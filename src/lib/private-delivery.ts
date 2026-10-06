import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import {
  containsProviderName,
  customerFacingText,
} from "payz-core/catalog-identity";

export type PrivateDelivery = {
  redemptionCode: string | null;
  redemptionUrl: string | null;
  redemptionPin: string | null;
  redemptionInstructions: string | null;
  expirationDate: string | null;
};

export type EncryptedPurchaseToken = {
  format: "payz-purchase-token-v1";
  iv: string;
  tag: string;
  ciphertext: string;
};

type EncryptedDelivery = {
  format: "payz-delivery-v1";
  iv: string;
  tag: string;
  ciphertext: string;
};

export const PURCHASE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const PDF_WIDTH = 612;
const PDF_HEIGHT = 792;
const PDF_MARGIN = 52;

function secret(): string {
  const value = process.env.SESSION_SECRET?.trim();
  if (!value) throw new Error("Private delivery encryption is not configured.");
  return value;
}

function deriveKey(purpose: string): Buffer {
  return createHmac("sha256", secret()).update(purpose).digest();
}

export function createPurchaseAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPurchaseAccessToken(token: string): string {
  return createHmac("sha256", deriveKey("payz:purchase-access-hash:v1"))
    .update(token, "utf8")
    .digest("hex");
}

export function sealPurchaseAccessToken(token: string): EncryptedPurchaseToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey("payz:purchase-access-encryption:v1"),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    format: "payz-purchase-token-v1",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function openPurchaseAccessToken(value: unknown): string {
  if (
    !isObject(value) ||
    value.format !== "payz-purchase-token-v1" ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("Purchase access token is not encrypted or has an invalid format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey("payz:purchase-access-encryption:v1"),
    Buffer.from(value.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  const token = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Purchase access token is invalid.");
  }
  return token;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sealPrivateDelivery(delivery: PrivateDelivery): EncryptedDelivery {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("payz:delivery-encryption:v1"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(delivery), "utf8"),
    cipher.final(),
  ]);
  return {
    format: "payz-delivery-v1",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function isSafeRedemptionUrl(value: string | null): boolean {
  if (value === null) return true;
  if (value.trim() !== value) return false;
  try {
    const parsedUrl = new URL(value);
    return (
      parsedUrl.protocol === "https:" &&
      parsedUrl.username.length === 0 &&
      parsedUrl.password.length === 0
    );
  } catch {
    return false;
  }
}

export function openPrivateDelivery(value: unknown): PrivateDelivery {
  if (
    !isObject(value) ||
    value.format !== "payz-delivery-v1" ||
    typeof value.iv !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("Private delivery data is not encrypted or has an invalid format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey("payz:delivery-encryption:v1"),
    Buffer.from(value.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  if (!isObject(parsed)) throw new Error("Private delivery data is invalid.");
  return {
    redemptionCode: typeof parsed.redemptionCode === "string" ? parsed.redemptionCode : null,
    redemptionUrl: typeof parsed.redemptionUrl === "string" ? parsed.redemptionUrl : null,
    redemptionPin: typeof parsed.redemptionPin === "string" ? parsed.redemptionPin : null,
    redemptionInstructions:
      typeof parsed.redemptionInstructions === "string" ? parsed.redemptionInstructions : null,
    expirationDate: typeof parsed.expirationDate === "string" ? parsed.expirationDate : null,
  };
}

function pdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, " ");
}

function wrapText(text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, maxWidth: number): string[] {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let chunk = "";
    for (const character of word) {
      if (font.widthOfTextAtSize(`${chunk}${character}`, size) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

export async function createGiftCardPdf(input: {
  orderId: string;
  orderPlacedAt: Date;
  brand: string;
  product: string;
  value: string;
  currency: string;
  delivery: PrivateDelivery;
}): Promise<Uint8Array> {
  if ([input.delivery.redemptionCode, input.delivery.redemptionPin].some(
    (value) => value && containsProviderName(value),
  )) {
    throw new Error("Purchase details are unavailable.");
  }
  if (
    [input.delivery.redemptionCode, input.delivery.redemptionPin].some(
      (value) => value && /[^\x20-\x7E]/.test(value),
    )
  ) {
    throw new Error("The purchase code contains characters not supported by the PDF font.");
  }
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const mono = await document.embedFont(StandardFonts.Courier);
  const ink = rgb(0.13, 0.18, 0.22);
  const muted = rgb(0.43, 0.49, 0.54);
  const accent = rgb(0.20, 0.36, 0.48);
  const line = rgb(0.87, 0.90, 0.92);
  let page = document.addPage([PDF_WIDTH, PDF_HEIGHT]);
  let y = PDF_HEIGHT - PDF_MARGIN;
  const maxWidth = PDF_WIDTH - PDF_MARGIN * 2;

  const addPage = () => {
    page = document.addPage([PDF_WIDTH, PDF_HEIGHT]);
    y = PDF_HEIGHT - PDF_MARGIN;
  };
  const ensureSpace = (height: number) => {
    if (y - height < PDF_MARGIN) addPage();
  };
  const paragraph = (
    text: string,
    font: typeof regular,
    size: number,
    color: ReturnType<typeof rgb>,
    after = 12,
  ) => {
    const lines = wrapText(customerFacingText(text), font, size, maxWidth);
    for (const value of lines) {
      ensureSpace(size + 7);
      page.drawText(value, { x: PDF_MARGIN, y: y - size, size, font, color });
      y -= size + 6;
    }
    y -= after;
  };
  const sectionHeading = (text: string) => {
    ensureSpace(32);
    page.drawText(pdfText(customerFacingText(text)), { x: PDF_MARGIN, y: y - 15, size: 11, font: bold, color: accent });
    y -= 25;
  };
  const redemptionLink = (url: string) => {
    sectionHeading("Redemption link");
    const label = "Open redemption page";
    const size = 10;
    ensureSpace(size + 20);
    const baseline = y - size;
    const width = regular.widthOfTextAtSize(label, size);
    page.drawText(label, { x: PDF_MARGIN, y: baseline, size, font: regular, color: accent });
    const annotation = document.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      Rect: [PDF_MARGIN, baseline - 2, PDF_MARGIN + width, baseline + size + 2],
      Border: [0, 0, 0],
      A: {
        Type: PDFName.of("Action"),
        S: PDFName.of("URI"),
        URI: PDFString.of(url),
      },
    });
    page.node.addAnnot(document.context.register(annotation));
    y -= size + 20;
  };

  page.drawText("payz", { x: PDF_MARGIN, y: y - 24, size: 25, font: bold, color: accent });
  page.drawText("PAYZ PURCHASE RECEIPT", {
    x: PDF_WIDTH - PDF_MARGIN - 150,
    y: y - 14,
    size: 9,
    font: bold,
    color: muted,
  });
  y -= 42;
  page.drawLine({
    start: { x: PDF_MARGIN, y },
    end: { x: PDF_WIDTH - PDF_MARGIN, y },
    thickness: 1,
    color: line,
  });
  y -= 32;

  paragraph(input.brand, bold, 22, ink, 3);
  paragraph(input.product, regular, 13, muted, 3);
  paragraph(`${pdfText(input.currency)} ${pdfText(input.value)}`, bold, 17, ink, 18);
  sectionHeading("Order details");
  paragraph(`Order number: ${pdfText(input.orderId)}`, regular, 10, muted, 3);
  paragraph(
    `Order placed: ${new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(input.orderPlacedAt)} UTC`,
    regular,
    10,
    muted,
    18,
  );

  if (input.delivery.redemptionCode) {
    sectionHeading("Purchase code");
    const codeLines = wrapText(input.delivery.redemptionCode, mono, 16, maxWidth);
    for (const value of codeLines) {
      ensureSpace(34);
      page.drawRectangle({
        x: PDF_MARGIN,
        y: y - 30,
        width: maxWidth,
        height: 35,
        color: rgb(0.96, 0.97, 0.98),
        borderColor: line,
        borderWidth: 1,
      });
      page.drawText(value, { x: PDF_MARGIN + 12, y: y - 19, size: 16, font: mono, color: ink });
      y -= 45;
    }
  }
  if (input.delivery.redemptionPin) {
    sectionHeading("PIN");
    paragraph(input.delivery.redemptionPin, mono, 14, ink);
  }
  if (input.delivery.redemptionUrl) {
    if (!isSafeRedemptionUrl(input.delivery.redemptionUrl)) {
      throw new Error("The redemption link is unavailable.");
    }
    redemptionLink(input.delivery.redemptionUrl);
  }
  if (input.delivery.redemptionInstructions) {
    sectionHeading("How to redeem");
    for (const block of input.delivery.redemptionInstructions.split(/\n+/)) {
      if (block.trim()) paragraph(block, regular, 10, ink, 8);
    }
  }
  if (input.delivery.expirationDate) {
    sectionHeading("Expiration date");
    paragraph(input.delivery.expirationDate, regular, 10, ink);
  }

  const pages = document.getPages();
  pages.forEach((pageItem, index) => {
    pageItem.drawLine({
      start: { x: PDF_MARGIN, y: 38 },
      end: { x: PDF_WIDTH - PDF_MARGIN, y: 38 },
      thickness: 1,
      color: line,
    });
    pageItem.drawText("Keep these purchase details private", {
      x: PDF_MARGIN,
      y: 22,
      size: 8,
      font: regular,
      color: muted,
    });
    pageItem.drawText(`${index + 1} / ${pages.length}`, {
      x: PDF_WIDTH - PDF_MARGIN - 35,
      y: 22,
      size: 8,
      font: regular,
      color: muted,
    });
  });

  return document.save();
}
