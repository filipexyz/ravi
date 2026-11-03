import {
  type PaymentCharge,
  type PaymentChargeStatus,
  type PaymentCustomerInput,
  type PaymentInstructions,
  type PaymentProvider,
  PaymentProviderError,
} from "./payment-provider";

// Asaas API v3. Auth is the `access_token` header; newer accounts also
// require a User-Agent naming the application.

export const ASAAS_PROVIDER = "asaas";

const BASE_URLS = {
  production: "https://api.asaas.com/v3",
  sandbox: "https://api-sandbox.asaas.com/v3",
} as const;

export type AsaasEnvironment = keyof typeof BASE_URLS;

export type AsaasConfig = {
  apiKey: string;
  environment: AsaasEnvironment;
  fetch?: typeof fetch;
};

export function asaasConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AsaasConfig | null {
  const apiKey = env.ASAAS_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, environment: env.ASAAS_ENV?.trim() === "production" ? "production" : "sandbox" };
}

/** Asaas payment statuses, grouped into Ravi's charge states. */
export function asaasChargeStatus(status: string | undefined, deleted?: boolean): PaymentChargeStatus {
  if (deleted) return "canceled";
  switch (status) {
    case "RECEIVED":
    case "CONFIRMED":
    case "RECEIVED_IN_CASH":
    // The money arrived; a refund or chargeback still in progress hasn't taken it back yet.
    case "REFUND_REQUESTED":
    case "REFUND_IN_PROGRESS":
    case "CHARGEBACK_REQUESTED":
    case "CHARGEBACK_DISPUTE":
    case "AWAITING_CHARGEBACK_REVERSAL":
      return "paid";
    case "OVERDUE":
      return "overdue";
    case "REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

type AsaasPayment = {
  id: string;
  status?: string;
  deleted?: boolean;
  invoiceUrl?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
};

function chargeFromPayment(payment: AsaasPayment): PaymentCharge {
  return {
    paymentId: payment.id,
    status: asaasChargeStatus(payment.status, payment.deleted),
    invoiceUrl: payment.invoiceUrl ?? null,
    paidAt: payment.paymentDate ?? payment.clientPaymentDate ?? payment.confirmedDate ?? null,
  };
}

export function createAsaasProvider(config: AsaasConfig): PaymentProvider {
  const baseUrl = BASE_URLS[config.environment];
  const doFetch = config.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          access_token: config.apiKey,
          accept: "application/json",
          "user-agent": "ravi-console",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PaymentProviderError(
        "payment_provider_unreachable",
        error instanceof Error ? error.message : "request failed",
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const errors = (payload as { errors?: Array<{ code?: string; description?: string }> } | null)?.errors;
      const first = errors?.[0];
      throw new PaymentProviderError(
        "payment_provider_rejected",
        first?.description ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    return payload as T;
  }

  function customerBody(input: PaymentCustomerInput) {
    return {
      name: input.name,
      cpfCnpj: input.taxId,
      email: input.email,
      mobilePhone: input.phone || undefined,
      postalCode: input.postalCode || undefined,
      address: input.address || undefined,
      addressNumber: input.addressNumber || undefined,
      complement: input.complement || undefined,
      province: input.district || undefined,
      externalReference: input.organizationId,
      // Ravi tells the client about invoices itself.
      notificationDisabled: true,
    };
  }

  return {
    name: ASAAS_PROVIDER,

    async upsertCustomer(input) {
      const found = await call<{ data?: Array<{ id: string; deleted?: boolean }> }>(
        "GET",
        `/customers?externalReference=${encodeURIComponent(input.organizationId)}&limit=1`,
      );
      const existing = found.data?.find((customer) => !customer.deleted);
      if (existing) {
        await call("PUT", `/customers/${encodeURIComponent(existing.id)}`, customerBody(input));
        return { customerId: existing.id };
      }
      const created = await call<{ id: string }>("POST", "/customers", customerBody(input));
      return { customerId: created.id };
    },

    async createCharge(input) {
      const payment = await call<AsaasPayment>("POST", "/payments", {
        customer: input.customerId,
        billingType: "BOLETO",
        value: input.amountCents / 100,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.invoiceId,
      });
      return chargeFromPayment(payment);
    },

    async findChargeByReference(invoiceId) {
      const found = await call<{ data?: AsaasPayment[] }>(
        "GET",
        `/payments?externalReference=${encodeURIComponent(invoiceId)}&limit=10`,
      );
      const live = found.data?.find((payment) => !payment.deleted);
      return live ? chargeFromPayment(live) : null;
    },

    async getCharge(paymentId) {
      return chargeFromPayment(await call<AsaasPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`));
    },

    async getInstructions(paymentId): Promise<PaymentInstructions> {
      const id = encodeURIComponent(paymentId);
      // Pix only exists when the account has it on; a failure leaves boleto alone.
      const [pix, boleto] = await Promise.allSettled([
        call<{ payload?: string; encodedImage?: string }>("GET", `/payments/${id}/pixQrCode`),
        call<{ identificationField?: string }>("GET", `/payments/${id}/identificationField`),
      ]);
      return {
        pixCopyPaste: pix.status === "fulfilled" ? pix.value?.payload ?? null : null,
        pixQrCodePng: pix.status === "fulfilled" ? pix.value?.encodedImage ?? null : null,
        boletoLine: boleto.status === "fulfilled" ? boleto.value?.identificationField ?? null : null,
      };
    },

    async cancelCharge(paymentId) {
      await call("DELETE", `/payments/${encodeURIComponent(paymentId)}`);
    },
  };
}

let override: PaymentProvider | null | undefined;

/** Test hook: replace the provider for this process (null = not configured). */
export function setPaymentProviderForTests(provider: PaymentProvider | null | undefined) {
  override = provider;
}

export function getPaymentProvider(): PaymentProvider {
  if (override !== undefined) {
    if (override === null) {
      throw new PaymentProviderError("payment_provider_not_configured", "Payment provider is not configured");
    }
    return override;
  }
  const config = asaasConfigFromEnv();
  if (!config) {
    throw new PaymentProviderError("payment_provider_not_configured", "Payment provider is not configured");
  }
  return createAsaasProvider(config);
}
