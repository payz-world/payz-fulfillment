import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { containsProviderName, customerFacingText } from "payz-core/catalog-identity";
import {
  createPurchaseAccessToken,
  createGiftCardPdf,
  hashPurchaseAccessToken,
  isSafeRedemptionUrl,
  openPrivateDelivery,
  openPurchaseAccessToken,
  PURCHASE_ACCESS_TTL_MS,
  sealPrivateDelivery,
  sealPurchaseAccessToken,
} from "../src/lib/private-delivery";

test("purchase access tokens are random, hashed, encrypted, and reopenable only with the server key", () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-only-session-secret-for-private-delivery";

  try {
    const token = createPurchaseAccessToken();
    const secondToken = createPurchaseAccessToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(token, secondToken);
    assert.equal(hashPurchaseAccessToken(token), hashPurchaseAccessToken(token));
    assert.match(hashPurchaseAccessToken(token), /^[a-f0-9]{64}$/);
    assert.notEqual(hashPurchaseAccessToken(token), token);
    assert.equal(isSafeRedemptionUrl("https://redeem.example.test/offer?code=abc"), true);
    assert.equal(isSafeRedemptionUrl("http://redeem.example.test/offer"), false);
    assert.equal(isSafeRedemptionUrl("javascript:alert(1)"), false);
    assert.equal(isSafeRedemptionUrl("https://user:pass@redeem.example.test/offer"), false);
    assert.equal(isSafeRedemptionUrl(" https://redeem.example.test/offer"), false);

    const encryptedToken = sealPurchaseAccessToken(token);
    assert.equal(encryptedToken.format, "payz-purchase-token-v1");
    assert.equal(openPurchaseAccessToken(encryptedToken), token);
    assert.ok(!JSON.stringify(encryptedToken).includes(token));

    const delivery = {
      redemptionCode: "TEST-CODE-123",
      redemptionUrl: "https://redeem.example.test/offer",
      redemptionPin: "8472",
      redemptionInstructions: "Enter the code at checkout.",
      expirationDate: "2027-01-01",
    };
    const encryptedDelivery = sealPrivateDelivery(delivery);
    assert.equal(encryptedDelivery.format, "payz-delivery-v1");
    assert.ok(!JSON.stringify(encryptedDelivery).includes(delivery.redemptionCode));
    assert.deepEqual(openPrivateDelivery(encryptedDelivery), delivery);
    assert.equal(PURCHASE_ACCESS_TTL_MS, 24 * 60 * 60 * 1000);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("customer text and download copy conceal provider names while keeping redemption links clickable", async () => {
  assert.equal(containsProviderName("ChangeNOW"), true);
  assert.equal(containsProviderName("change now"), true);
  assert.equal(containsProviderName("Bitrefill"), true);
  assert.equal(containsProviderName("the payment service"), false);
  assert.equal(
    customerFacingText("Use Bitrefill or ChangeNOW to finish."),
    "Use the fulfillment provider or the payment service to finish.",
  );

  const pdf = await createGiftCardPdf({
    orderId: "payz-order-sample",
    orderPlacedAt: new Date("2026-10-06T00:00:00.000Z"),
    brand: "Bitrefill Sample",
    product: "Netflix 25",
    value: "25.00",
    currency: "USD",
    delivery: {
      redemptionCode: "CODE-12345",
      redemptionUrl: "https://redeem.bitrefill.example/claim",
      redemptionPin: null,
      redemptionInstructions: "Visit Bitrefill and use this code.",
      expirationDate: null,
    },
  });
  const parsedPdf = await PDFDocument.load(pdf);
  assert.equal(parsedPdf.getPages()[0]?.node.Annots()?.size(), 1);
  await writeFile("/tmp/payz-provider-neutral-purchase.pdf", pdf);
  assert.ok(pdf.byteLength > 500);
});
