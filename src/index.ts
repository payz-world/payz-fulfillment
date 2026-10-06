import type { FulfillmentProvider } from "payz-core/contracts";
import { bitrefillFulfillmentProvider } from "./lib/bitrefill-provider";

const fulfillmentProviders: Readonly<Record<string, FulfillmentProvider>> = {
  [bitrefillFulfillmentProvider.id]: bitrefillFulfillmentProvider,
};

export function getFulfillmentProvider(
  providerId: string,
): FulfillmentProvider | null {
  return fulfillmentProviders[providerId] ?? null;
}

export function isAnyFulfillmentProviderConfigured(): boolean {
  return Object.values(fulfillmentProviders).some((provider) =>
    provider.isConfigured(),
  );
}

export {
  bitrefillFulfillmentProvider,
  getBitrefillAccountBalance,
} from "./lib/bitrefill-provider";
export { sealPrivateDelivery } from "./lib/private-delivery";
export type { PrivateDelivery } from "./lib/private-delivery";
