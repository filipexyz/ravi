// Ravi-owned payment provider boundary. Product code talks to this interface;
// the Asaas implementation lives in ./asaas.ts. Organization-facing code never
// names the provider (console/billing/contracts).

export type PaymentCustomerInput = {
  organizationId: string;
  name: string;
  taxId: string;
  email: string;
  phone?: string | null;
  postalCode?: string | null;
  address?: string | null;
  addressNumber?: string | null;
  complement?: string | null;
  district?: string | null;
};

export type PaymentChargeInput = {
  customerId: string;
  invoiceId: string;
  amountCents: number;
  dueDate: string;
  description: string;
};

export type PaymentChargeStatus = "pending" | "paid" | "overdue" | "refunded" | "canceled";

export type PaymentCharge = {
  paymentId: string;
  status: PaymentChargeStatus;
  invoiceUrl: string | null;
  paidAt: string | null;
};

export type PaymentInstructions = {
  pixCopyPaste: string | null;
  pixQrCodePng: string | null;
  boletoLine: string | null;
};

export interface PaymentProvider {
  readonly name: string;
  /** Finds the organization's customer (by organization id) or creates it, then brings its details up to date. */
  upsertCustomer(input: PaymentCustomerInput): Promise<{ customerId: string }>;
  createCharge(input: PaymentChargeInput): Promise<PaymentCharge>;
  /** The live charge created for an invoice id, if any: lets a retried issue reuse it. */
  findChargeByReference(invoiceId: string): Promise<PaymentCharge | null>;
  getCharge(paymentId: string): Promise<PaymentCharge>;
  getInstructions(paymentId: string): Promise<PaymentInstructions>;
  cancelCharge(paymentId: string): Promise<void>;
}

export class PaymentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
