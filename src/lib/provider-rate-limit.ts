import { createRequestPacer } from "payz-core/request-pacer";

// Preserve the provider's existing invoice and order request limits.
export const waitForFulfillmentInvoiceCreateSlot = createRequestPacer(10_100);
export const waitForFulfillmentInvoiceReadSlot = createRequestPacer(10_100);
export const waitForFulfillmentOrderReadSlot = createRequestPacer(10_100);
