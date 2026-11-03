import { timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { ASAAS_PROVIDER } from "./asaas";
import { applyChargeStatus } from "./invoices";
import type { PaymentChargeStatus } from "./payment-provider";

// POST /api/internal/billing/asaas/webhook (console/billing/contracts).
// Authenticated by the `asaas-access-token` header; each event is stored once.

export type AsaasWebhookResult = { status: number; body: Record<string, unknown> };

type AsaasWebhookPayment = {
  id?: unknown;
  status?: unknown;
  value?: unknown;
  dueDate?: unknown;
  paymentDate?: unknown;
  clientPaymentDate?: unknown;
  externalReference?: unknown;
  billingType?: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_CHARGE: Record<string, PaymentChargeStatus> = {
  PAYMENT_CONFIRMED: "paid",
  PAYMENT_RECEIVED: "paid",
  PAYMENT_RECEIVED_IN_CASH: "paid",
  PAYMENT_OVERDUE: "overdue",
  PAYMENT_REFUNDED: "refunded",
  PAYMENT_DELETED: "canceled",
};

export function chargeStatusForEvent(event: string): PaymentChargeStatus | null {
  return EVENT_CHARGE[event] ?? null;
}

export function asaasWebhookTokenMatches(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What we keep of a notification: the charge's state, never the payer's details. */
function redactedPayload(event: string, payment: AsaasWebhookPayment) {
  return {
    event,
    payment: {
      id: text(payment.id),
      status: text(payment.status),
      value: typeof payment.value === "number" ? payment.value : null,
      dueDate: text(payment.dueDate),
      paymentDate: text(payment.paymentDate) ?? text(payment.clientPaymentDate),
      externalReference: text(payment.externalReference),
      billingType: text(payment.billingType),
    },
  };
}

export async function handleAsaasWebhook(input: {
  token: string | null;
  body: unknown;
  requestId: string;
  expectedToken?: string | undefined;
}): Promise<AsaasWebhookResult> {
  const expected = input.expectedToken ?? process.env.ASAAS_WEBHOOK_TOKEN?.trim();
  if (!expected) return { status: 503, body: { error: "webhook_not_configured" } };
  if (!asaasWebhookTokenMatches(input.token, expected)) return { status: 401, body: { error: "unauthorized" } };

  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return { status: 400, body: { error: "invalid_payload" } };
  }
  const body = input.body as { id?: unknown; event?: unknown; payment?: unknown };
  const event = text(body.event);
  if (!event) return { status: 400, body: { error: "invalid_payload" } };
  const payment = (body.payment && typeof body.payment === "object" ? body.payment : {}) as AsaasWebhookPayment;
  const paymentId = text(payment.id);
  const eventId = text(body.id) ?? `${event}:${paymentId ?? "none"}:${text(payment.status) ?? "none"}`;

  const [stored] = await db
    .insert(schema.billingProviderEvents)
    .values({
      provider: ASAAS_PROVIDER,
      providerEventId: eventId,
      eventType: event,
      providerPaymentId: paymentId,
      payloadJson: redactedPayload(event, payment),
    })
    .onConflictDoNothing()
    .returning({ id: schema.billingProviderEvents.id });
  let eventRowId = stored?.id;
  if (!eventRowId) {
    // A retry of an event that failed before it was processed is processed again.
    const [existing] = await db
      .select({ id: schema.billingProviderEvents.id, processedAt: schema.billingProviderEvents.processedAt })
      .from(schema.billingProviderEvents)
      .where(
        and(
          eq(schema.billingProviderEvents.provider, ASAAS_PROVIDER),
          eq(schema.billingProviderEvents.providerEventId, eventId),
        ),
      )
      .limit(1);
    if (!existing || existing.processedAt) return { status: 200, body: { received: true, duplicate: true } };
    eventRowId = existing.id;
  }

  const outcome = await processEvent(event, paymentId, payment, input.requestId);
  await db
    .update(schema.billingProviderEvents)
    .set({ invoiceId: outcome.invoiceId, outcome: outcome.outcome, processedAt: new Date() })
    .where(eq(schema.billingProviderEvents.id, eventRowId));
  return { status: 200, body: { received: true, outcome: outcome.outcome } };
}

async function processEvent(
  event: string,
  paymentId: string | null,
  payment: AsaasWebhookPayment,
  requestId: string,
): Promise<{ invoiceId: string | null; outcome: string }> {
  const charge = chargeStatusForEvent(event);
  if (!charge) return { invoiceId: null, outcome: "ignored_event" };
  if (!paymentId) return { invoiceId: null, outcome: "missing_payment" };

  const [byPayment] = await db
    .select({ id: schema.billingInvoices.id })
    .from(schema.billingInvoices)
    .where(eq(schema.billingInvoices.providerPaymentId, paymentId))
    .limit(1);
  // The webhook can beat the issue transaction's commit: the reference names the
  // invoice, and applying waits for that row's lock before checking the payment id.
  const reference = text(payment.externalReference);
  const invoiceId = byPayment?.id ?? (reference && UUID_PATTERN.test(reference) ? reference : null);
  if (!invoiceId) return { invoiceId: null, outcome: "unknown_payment" };
  return apply(invoiceId, paymentId, charge, payment, requestId);
}

async function apply(
  invoiceId: string,
  paymentId: string,
  charge: PaymentChargeStatus,
  payment: AsaasWebhookPayment,
  requestId: string,
) {
  const result = await applyChargeStatus({
    invoiceId,
    expectedPaymentId: paymentId,
    charge,
    paidAt: text(payment.paymentDate) ?? text(payment.clientPaymentDate),
    source: "provider_webhook",
    requestId,
  });
  if (result.mismatch) return { invoiceId: null, outcome: "unknown_payment" };
  return { invoiceId, outcome: result.changed ? `invoice_${result.status}` : "no_change" };
}
