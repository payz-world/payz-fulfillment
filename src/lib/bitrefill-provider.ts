import {
  FulfillmentProviderUnavailableError,
  type FulfillmentProvider,
} from "payz-core/contracts";
import {
  waitForFulfillmentInvoiceCreateSlot,
  waitForFulfillmentInvoiceReadSlot,
  waitForFulfillmentOrderReadSlot,
} from "./provider-rate-limit";
import { isSafeRedemptionUrl } from "./private-delivery";
import {
  containsProviderName,
  customerFacingText,
} from "payz-core/catalog-identity";

type JsonObject = Record<string, unknown>;

export class BitrefillUnavailableError extends FulfillmentProviderUnavailableError {
  constructor() {
    super();
    this.name = "BitrefillUnavailableError";
  }
}

export type BitrefillInvoice = {
  id: string;
  status: string;
  providerOrderId: string | null;
};

export type BitrefillOrder = {
  id: string;
  status: string;
  redemptionCode: string | null;
  redemptionUrl: string | null;
  redemptionPin: string | null;
  redemptionInstructions: string | null;
  expirationDate: string | null;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function baseUrl(): URL {
  const configured = process.env.PAYZ_FULFILLMENT_API_BASE_URL?.trim();
  const parsed = new URL(configured || "https://api-bitrefill.com/v2");
  if (parsed.protocol !== "https:") throw new BitrefillUnavailableError();
  return new URL(`${parsed.toString().replace(/\/+$/, "")}/`);
}

function getPersonalAuthHeader(): string | null {
  const apiKey =
    process.env.PAYZ_PROVIDER_ACCESS_TOKEN?.trim() ||
    process.env.BITREFILL_PERSONAL_API?.trim();
  return apiKey ? `Bearer ${apiKey}` : null;
}

async function request(path: string, method: "GET" | "POST", body?: JsonObject): Promise<unknown> {
  const authorization = getPersonalAuthHeader();
  if (!authorization) throw new BitrefillUnavailableError();

  let response: Response;
  try {
    if (method === "POST" && path === "invoices") {
      await waitForFulfillmentInvoiceCreateSlot();
    } else if (path.startsWith("invoices/") || path === "accounts/balance") {
      await waitForFulfillmentInvoiceReadSlot();
    } else if (path.startsWith("orders/")) {
      await waitForFulfillmentOrderReadSlot();
    } else {
      throw new BitrefillUnavailableError();
    }
    response = await fetch(new URL(path, baseUrl()), {
      method,
      headers: {
        accept: "application/json",
        authorization,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new BitrefillUnavailableError();
  }
  if (!response.ok) throw new BitrefillUnavailableError();
  try {
    return await response.json();
  } catch {
    throw new BitrefillUnavailableError();
  }
}

function dataOf(payload: unknown): JsonObject {
  if (!isObject(payload) || !isObject(payload.data)) throw new BitrefillUnavailableError();
  return payload.data;
}

export async function getBitrefillAccountBalance(): Promise<{
  amount: number;
  currency: string;
}> {
  const data = dataOf(await request("accounts/balance", "GET"));
  const rawAmount = data.balance;
  const amount =
    typeof rawAmount === "number"
      ? rawAmount
      : typeof rawAmount === "string" && /^\d+(?:\.\d+)?$/.test(rawAmount)
        ? Number(rawAmount)
        : NaN;
  const currency = stringValue(data.currency)?.toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !currency) {
    throw new BitrefillUnavailableError();
  }
  return { amount, currency };
}

function parseInvoice(value: JsonObject, requireOrderId = false): BitrefillInvoice {
  const id = stringValue(value.id);
  const status = stringValue(value.status);
  const orders = Array.isArray(value.orders) ? value.orders : [];
  const firstOrder = orders.find(isObject);
  const providerOrderId = isObject(firstOrder) ? stringValue(firstOrder.id) : null;
  if (!id || !status || (requireOrderId && !providerOrderId)) {
    throw new BitrefillUnavailableError();
  }
  return { id, status, providerOrderId };
}

export async function createBitrefillInvoice(input: {
  providerProductId: string;
  providerPackageId: string;
}): Promise<BitrefillInvoice> {
  const product: JsonObject = { product_id: input.providerProductId, quantity: 1 };
  if (input.providerPackageId.startsWith("package:")) {
    product.package_id = input.providerPackageId.slice("package:".length);
  } else if (input.providerPackageId.startsWith("range:")) {
    const value = Number(input.providerPackageId.slice("range:".length));
    // Keep fulfillment compatible with orders created before the catalog floor increased.
    if (!Number.isFinite(value) || value <= 15) throw new BitrefillUnavailableError();
    product.value = value;
  } else {
    throw new BitrefillUnavailableError();
  }
  const payload = await request(
    "invoices",
    "POST",
    {
      products: [product],
      payment_method: "balance",
      auto_pay: true,
    },
  );
  return parseInvoice(dataOf(payload), true);
}

export async function getBitrefillInvoice(invoiceId: string): Promise<BitrefillInvoice> {
  const payload = await request(`invoices/${encodeURIComponent(invoiceId)}`, "GET");
  return parseInvoice(dataOf(payload));
}

export async function getBitrefillOrder(orderId: string): Promise<BitrefillOrder> {
  const payload = await request(`orders/${encodeURIComponent(orderId)}`, "GET");
  const data = dataOf(payload);
  const id = stringValue(data.id);
  const status = stringValue(data.status);
  if (!id || !status) throw new BitrefillUnavailableError();

  const rawRedemption = data.redemption_info;
  const redemption = isObject(rawRedemption) ? rawRedemption : null;
  const rawInstructions =
    stringValue(redemption?.instructions) ??
    (typeof rawRedemption === "string" ? rawRedemption.trim() || null : null);
  const redemptionInstructions = rawInstructions ? customerFacingText(rawInstructions) : null;
  const redemptionCode = stringValue(redemption?.code);
  const redemptionPin = stringValue(redemption?.pin);
  if ([redemptionCode, redemptionPin].some((value) => value && containsProviderName(value))) {
    throw new BitrefillUnavailableError();
  }
  const rawRedemptionUrl =
    typeof redemption?.link === "string" && redemption.link.trim()
      ? redemption.link
      : null;
  if (!isSafeRedemptionUrl(rawRedemptionUrl)) throw new BitrefillUnavailableError();
  return {
    id,
    status,
    redemptionCode,
    redemptionUrl: rawRedemptionUrl,
    redemptionPin,
    redemptionInstructions,
    expirationDate: stringValue(redemption?.expiration_date),
  };
}

export const bitrefillFulfillmentProvider: FulfillmentProvider = {
  id: "bitrefill",
  isConfigured: () => Boolean(getPersonalAuthHeader()),
  async createInvoice(input) {
    const invoice = await createBitrefillInvoice({
      providerProductId: input.productId,
      providerPackageId: input.variantId,
    });
    return {
      id: invoice.id,
      status: invoice.status,
      fulfillmentReference: invoice.providerOrderId,
    };
  },
  async getInvoice(invoiceId) {
    const invoice = await getBitrefillInvoice(invoiceId);
    return {
      id: invoice.id,
      status: invoice.status,
      fulfillmentReference: invoice.providerOrderId,
    };
  },
  async getDelivery(orderId) {
    const order = await getBitrefillOrder(orderId);
    return {
      status: order.status,
      code: order.redemptionCode,
      url: order.redemptionUrl,
      pin: order.redemptionPin,
      instructions: order.redemptionInstructions,
      expiresAt: order.expirationDate,
    };
  },
};
