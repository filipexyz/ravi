import { describe, expect, test } from "bun:test";

import { asaasChargeStatus, asaasConfigFromEnv, createAsaasProvider } from "./asaas";
import { PaymentProviderError } from "./payment-provider";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const customer = {
  organizationId: "6d0f3c1e-4c1f-4b0e-9a57-0c5f1e2a9d11",
  name: "Cliente Ltda",
  taxId: "11222333000181",
  email: "financeiro@cliente.com.br",
};

describe("payment provider configuration", () => {
  test("needs an API key and defaults to the sandbox", () => {
    const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
    expect(asaasConfigFromEnv(env({}))).toBeNull();
    expect(asaasConfigFromEnv(env({ ASAAS_API_KEY: "k" }))?.environment).toBe("sandbox");
    expect(asaasConfigFromEnv(env({ ASAAS_API_KEY: "k", ASAAS_ENV: "production" }))?.environment).toBe("production");
  });

  test("groups charge statuses into Ravi's states", () => {
    expect(asaasChargeStatus("PENDING")).toBe("pending");
    expect(asaasChargeStatus("RECEIVED")).toBe("paid");
    expect(asaasChargeStatus("CONFIRMED")).toBe("paid");
    expect(asaasChargeStatus("REFUND_IN_PROGRESS")).toBe("paid");
    expect(asaasChargeStatus("OVERDUE")).toBe("overdue");
    expect(asaasChargeStatus("REFUNDED")).toBe("refunded");
    expect(asaasChargeStatus("PENDING", true)).toBe("canceled");
  });
});

describe("payment provider calls", () => {
  test("creates the customer once and updates it after, keyed by the organization", async () => {
    const created = fakeFetch([{ body: { data: [] } }, { body: { id: "cus_1" } }]);
    const provider = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: created.fetchImpl });
    expect(await provider.upsertCustomer(customer)).toEqual({ customerId: "cus_1" });
    expect(created.calls[0]?.url).toBe(
      `https://api-sandbox.asaas.com/v3/customers?externalReference=${customer.organizationId}&limit=1`,
    );
    expect(created.calls[0]?.headers.access_token).toBe("secret");
    expect(created.calls[0]?.headers["user-agent"]).toBe("ravi-console");
    expect(created.calls[1]).toMatchObject({
      method: "POST",
      body: { cpfCnpj: customer.taxId, externalReference: customer.organizationId, notificationDisabled: true },
    });

    const updated = fakeFetch([{ body: { data: [{ id: "cus_1" }] } }, { body: { id: "cus_1" } }]);
    const again = createAsaasProvider({ apiKey: "secret", environment: "production", fetch: updated.fetchImpl });
    expect(await again.upsertCustomer(customer)).toEqual({ customerId: "cus_1" });
    expect(updated.calls[1]).toMatchObject({ method: "PUT", url: "https://api.asaas.com/v3/customers/cus_1" });
  });

  test("charges in reais with the invoice as reference", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: { id: "pay_1", status: "PENDING", invoiceUrl: "https://example.test/i/1" } },
    ]);
    const provider = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: fetchImpl });
    const charge = await provider.createCharge({
      customerId: "cus_1",
      invoiceId: "inv-1",
      amountCents: 150_050,
      dueDate: "2026-11-10",
      description: "Ravi · 10/2026",
    });
    expect(charge).toEqual({ paymentId: "pay_1", status: "pending", invoiceUrl: "https://example.test/i/1", paidAt: null });
    expect(calls[0]?.body).toMatchObject({ billingType: "BOLETO", value: 1500.5, externalReference: "inv-1" });
  });

  test("finds the live charge already created for an invoice", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { body: { data: [{ id: "pay_0", status: "PENDING", deleted: true }, { id: "pay_1", status: "PENDING" }] } },
      { body: { data: [] } },
    ]);
    const provider = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: fetchImpl });
    expect((await provider.findChargeByReference("inv-1"))?.paymentId).toBe("pay_1");
    expect(calls[0]?.url).toBe("https://api-sandbox.asaas.com/v3/payments?externalReference=inv-1&limit=10");
    expect(await provider.findChargeByReference("inv-2")).toBeNull();
  });

  test("returns Pix and boleto codes, keeping the boleto when Pix is off", async () => {
    const both = fakeFetch([
      { body: { payload: "000201...", encodedImage: "iVBOR" } },
      { body: { identificationField: "23790.00000" } },
    ]);
    const provider = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: both.fetchImpl });
    expect(await provider.getInstructions("pay_1")).toEqual({
      pixCopyPaste: "000201...",
      pixQrCodePng: "iVBOR",
      boletoLine: "23790.00000",
    });

    const boletoOnly = fakeFetch([
      { status: 400, body: { errors: [{ description: "Pix disabled" }] } },
      { body: { identificationField: "23790.00000" } },
    ]);
    const fallback = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: boletoOnly.fetchImpl });
    expect(await fallback.getInstructions("pay_1")).toEqual({
      pixCopyPaste: null,
      pixQrCodePng: null,
      boletoLine: "23790.00000",
    });
  });

  test("a refusal becomes a provider error with its description", async () => {
    const { fetchImpl } = fakeFetch([{ status: 400, body: { errors: [{ code: "invalid_cpfCnpj", description: "CPF inválido" }] } }]);
    const provider = createAsaasProvider({ apiKey: "secret", environment: "sandbox", fetch: fetchImpl });
    const error = await provider.getCharge("pay_1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ code: "payment_provider_rejected", message: "CPF inválido", status: 400 });
  });
});
