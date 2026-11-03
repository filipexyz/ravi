import { describe, expect, test } from "bun:test";

import { asaasWebhookTokenMatches, chargeStatusForEvent, handleAsaasWebhook } from "./asaas-webhook";
import { nextInvoiceStatus } from "./invoices";

describe("payment webhook", () => {
  test("only the configured token authenticates", () => {
    expect(asaasWebhookTokenMatches("token-1", "token-1")).toBe(true);
    expect(asaasWebhookTokenMatches("token-2", "token-1")).toBe(false);
    expect(asaasWebhookTokenMatches("token", "token-1")).toBe(false);
    expect(asaasWebhookTokenMatches(null, "token-1")).toBe(false);
    expect(asaasWebhookTokenMatches("token-1", undefined)).toBe(false);
  });

  test("refuses before touching the database when unconfigured, unauthenticated or malformed", async () => {
    const base = { requestId: "req-1", body: { event: "PAYMENT_RECEIVED", payment: { id: "pay_1" } } };
    const previous = process.env.ASAAS_WEBHOOK_TOKEN;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    try {
      expect((await handleAsaasWebhook({ ...base, token: "x" })).status).toBe(503);
    } finally {
      if (previous !== undefined) process.env.ASAAS_WEBHOOK_TOKEN = previous;
    }
    expect((await handleAsaasWebhook({ ...base, token: "wrong", expectedToken: "right" })).status).toBe(401);
    expect((await handleAsaasWebhook({ ...base, body: [], token: "right", expectedToken: "right" })).status).toBe(400);
    expect((await handleAsaasWebhook({ ...base, body: { payment: {} }, token: "right", expectedToken: "right" })).status).toBe(400);
  });

  test("maps payment events to charge states and ignores the rest", () => {
    expect(chargeStatusForEvent("PAYMENT_RECEIVED")).toBe("paid");
    expect(chargeStatusForEvent("PAYMENT_CONFIRMED")).toBe("paid");
    expect(chargeStatusForEvent("PAYMENT_OVERDUE")).toBe("overdue");
    expect(chargeStatusForEvent("PAYMENT_REFUNDED")).toBe("refunded");
    expect(chargeStatusForEvent("PAYMENT_DELETED")).toBe("canceled");
    expect(chargeStatusForEvent("PAYMENT_CREATED")).toBeNull();
  });
});

describe("invoice states move forward only", () => {
  test("an issued invoice gets paid, goes overdue or is canceled", () => {
    expect(nextInvoiceStatus("issued", "paid")).toBe("paid");
    expect(nextInvoiceStatus("issued", "overdue")).toBe("overdue");
    expect(nextInvoiceStatus("overdue", "paid")).toBe("paid");
    expect(nextInvoiceStatus("issued", "canceled")).toBe("canceled");
  });

  test("late or stale notifications change nothing", () => {
    expect(nextInvoiceStatus("paid", "overdue")).toBeNull();
    expect(nextInvoiceStatus("paid", "canceled")).toBeNull();
    expect(nextInvoiceStatus("overdue", "overdue")).toBeNull();
    expect(nextInvoiceStatus("draft", "paid")).toBeNull();
    expect(nextInvoiceStatus("canceled", "paid")).toBeNull();
    expect(nextInvoiceStatus("issued", "pending")).toBeNull();
  });

  test("a refund ends a paid invoice", () => {
    expect(nextInvoiceStatus("paid", "refunded")).toBe("refunded");
    expect(nextInvoiceStatus("refunded", "paid")).toBeNull();
  });
});
