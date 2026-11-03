import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { billableMetric, usageInBillingUnits } from "@/shared/billing/metrics";

import { getPaymentProvider } from "./asaas";
import {
  type ComputedLine,
  computeContractLines,
  invoiceDueDate,
  isPeriod,
  periodWindow,
  sumCents,
} from "./billing-math";
import { type ContractView, getContractForPeriod } from "./contracts";
import type { PaymentChargeStatus, PaymentInstructions } from "./payment-provider";
import { PaymentProviderError } from "./payment-provider";

// Monthly invoices (console/billing/contracts): prepared as drafts from the
// contract and the month's usage, adjusted and issued by a platform operator,
// moved forward by the payment provider.

export type InvoiceStatus = (typeof schema.billingInvoiceStatus.enumValues)[number];

export type InvoiceLineView = {
  id: string;
  position: number;
  source: string;
  description: string;
  metricKey: string | null;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  details: Record<string, unknown>;
};

export type InvoiceView = {
  id: string;
  organizationId: string;
  contractId: string | null;
  period: string;
  status: InvoiceStatus;
  currency: string;
  totalCents: number;
  dueDate: string | null;
  invoiceUrl: string | null;
  pixCopyPaste: string | null;
  boletoLine: string | null;
  providerPaymentId: string | null;
  preparedAt: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  canceledAt: string | null;
  lines: InvoiceLineView[];
};

type InvoiceRow = typeof schema.billingInvoices.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function lineView(row: typeof schema.billingInvoiceLines.$inferSelect): InvoiceLineView {
  return {
    id: row.id,
    position: row.position,
    source: row.source,
    description: row.description,
    metricKey: row.metricKey,
    quantity: Number(row.quantity),
    unit: row.unit,
    unitPriceCents: row.unitPriceCents,
    amountCents: row.amountCents,
    details: row.detailsJson,
  };
}

export async function invoiceViews(rows: InvoiceRow[]): Promise<InvoiceView[]> {
  if (rows.length === 0) return [];
  const lines = await db
    .select()
    .from(schema.billingInvoiceLines)
    .where(inArray(schema.billingInvoiceLines.invoiceId, rows.map((row) => row.id)))
    .orderBy(asc(schema.billingInvoiceLines.position));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    contractId: row.contractId,
    period: row.period,
    status: row.status,
    currency: row.currency,
    totalCents: row.totalCents,
    dueDate: row.dueDate,
    invoiceUrl: row.providerInvoiceUrl,
    pixCopyPaste: row.pixCopyPaste,
    boletoLine: row.boletoLine,
    providerPaymentId: row.providerPaymentId,
    preparedAt: iso(row.preparedAt),
    issuedAt: iso(row.issuedAt),
    paidAt: iso(row.paidAt),
    canceledAt: iso(row.canceledAt),
    lines: lines.filter((line) => line.invoiceId === row.id).map(lineView),
  }));
}

export async function listInvoices(
  organizationId: string,
  options: { includeDrafts?: boolean; limit?: number } = {},
): Promise<InvoiceView[]> {
  const rows = await db
    .select()
    .from(schema.billingInvoices)
    .where(
      and(
        eq(schema.billingInvoices.organizationId, organizationId),
        options.includeDrafts ? undefined : ne(schema.billingInvoices.status, "draft"),
      ),
    )
    .orderBy(desc(schema.billingInvoices.period), desc(schema.billingInvoices.createdAt))
    .limit(options.limit ?? 36);
  return invoiceViews(rows);
}

export async function getInvoiceRow(invoiceId: string): Promise<InvoiceRow> {
  const [row] = await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.id, invoiceId)).limit(1);
  if (!row) throw new ConsoleApiError(404, { error: "invoice_not_found" });
  return row;
}

/** Base-unit usage per metric for an organization in a month (São Paulo time). */
export async function usageForPeriod(
  organizationId: string,
  period: string,
  metricKeys: string[],
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  if (metricKeys.length === 0) return usage;
  const { start, end } = periodWindow(period);
  const rows = await db
    .select({
      metricKey: schema.usageEvents.metricKey,
      quantity: sql<string>`COALESCE(SUM(${schema.usageEvents.quantity}), 0)`,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organizationId, organizationId),
        inArray(schema.usageEvents.metricKey, metricKeys),
        gte(schema.usageEvents.occurredAt, start),
        lt(schema.usageEvents.occurredAt, end),
      ),
    )
    .groupBy(schema.usageEvents.metricKey);
  for (const row of rows) usage.set(row.metricKey, Number(row.quantity));
  return usage;
}

/** The contract's lines for a month, with metered usage converted to each item's billing unit. */
export async function computeLinesForContract(
  organizationId: string,
  contract: ContractView,
  period: string,
): Promise<ComputedLine[]> {
  const metered = contract.items.filter((item) => item.kind === "metered" && item.metricKey);
  const baseUsage = await usageForPeriod(
    organizationId,
    period,
    [...new Set(metered.map((item) => item.metricKey!))],
  );
  // Each metered item can bill its metric in its own unit.
  const lines = contract.items.map((item) => {
    if (item.kind !== "metered" || !item.metricKey) return computeContractLines([item], new Map())[0]!;
    const used = usageInBillingUnits(item.metricKey, item.unit, baseUsage.get(item.metricKey) ?? 0);
    return computeContractLines([item], new Map([[item.metricKey, used]]))[0]!;
  });
  return lines.map((line) => ({
    ...line,
    description: line.description || billableMetric(line.metricKey)?.label || "Item",
  }));
}

async function recomputeTotal(tx: Tx, invoiceId: string) {
  const lines = await tx
    .select({ amountCents: schema.billingInvoiceLines.amountCents })
    .from(schema.billingInvoiceLines)
    .where(eq(schema.billingInvoiceLines.invoiceId, invoiceId));
  const totalCents = sumCents(lines.map((line) => line.amountCents));
  await tx
    .update(schema.billingInvoices)
    .set({ totalCents, updatedAt: new Date() })
    .where(eq(schema.billingInvoices.id, invoiceId));
  return totalCents;
}

async function lockInvoice(tx: Tx, invoiceId: string): Promise<InvoiceRow> {
  const [row] = await tx
    .select()
    .from(schema.billingInvoices)
    .where(eq(schema.billingInvoices.id, invoiceId))
    .for("update")
    .limit(1);
  if (!row) throw new ConsoleApiError(404, { error: "invoice_not_found" });
  return row;
}

async function audit(
  tx: Tx | typeof db,
  input: {
    organizationId: string;
    actorUserId: string | null;
    invoiceId: string;
    action: string;
    requestId?: string | null;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorType: input.actorUserId ? "user" : "system",
    actorId: input.actorUserId,
    targetType: "billing_invoice",
    targetId: input.invoiceId,
    action: input.action,
    requestId: input.requestId ?? null,
    afterJson: input.after ?? null,
    metadataJson: input.metadata ?? {},
  });
}

const prepareSchema = z.object({ period: z.string().refine(isPeriod, "invalid_period") });

/**
 * Creates or recomputes the month's draft from the contract and the usage.
 * Operator adjustments stay; contract lines are rebuilt.
 */
export async function prepareInvoiceDraft(input: {
  organizationId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
  now?: Date;
}): Promise<InvoiceView> {
  const parsed = prepareSchema.safeParse(input.body);
  if (!parsed.success) throw new ConsoleApiError(400, { error: "invalid_period" });
  const { period } = parsed.data;

  const contract = await getContractForPeriod(input.organizationId, period);
  if (!contract) {
    throw new ConsoleApiError(409, {
      error: "no_contract_for_period",
      reason: `No contract covers ${period}. Save a contract that starts on or before it.`,
    });
  }
  const computed = await computeLinesForContract(input.organizationId, contract, period);
  const now = input.now ?? new Date();

  const invoiceId = await db.transaction(async (tx) => {
    // Locks the organization first: two first-time prepares for a period would
    // otherwise both see no invoice and race on the insert.
    await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, input.organizationId))
      .for("update");
    const [existing] = await tx
      .select()
      .from(schema.billingInvoices)
      .where(
        and(
          eq(schema.billingInvoices.organizationId, input.organizationId),
          eq(schema.billingInvoices.period, period),
          ne(schema.billingInvoices.status, "canceled"),
        ),
      )
      .for("update")
      .limit(1);
    if (existing && existing.status !== "draft") {
      throw new ConsoleApiError(409, { error: "invoice_already_issued" });
    }

    const values = {
      contractId: contract.id,
      currency: contract.currency,
      dueDate: invoiceDueDate(period, contract.dueDay, now),
      preparedAt: now,
      preparedByUserId: input.actorUserId,
      updatedAt: now,
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.update(schema.billingInvoices).set(values).where(eq(schema.billingInvoices.id, id));
      await tx
        .delete(schema.billingInvoiceLines)
        .where(
          and(eq(schema.billingInvoiceLines.invoiceId, id), ne(schema.billingInvoiceLines.source, "adjustment")),
        );
    } else {
      const [created] = await tx
        .insert(schema.billingInvoices)
        .values({ organizationId: input.organizationId, period, status: "draft", createdAt: now, ...values })
        .returning({ id: schema.billingInvoices.id });
      if (!created) throw new Error("failed_to_create_invoice");
      id = created.id;
    }

    // Contract lines first, adjustments after them.
    const adjustments = await tx
      .select({ id: schema.billingInvoiceLines.id })
      .from(schema.billingInvoiceLines)
      .where(eq(schema.billingInvoiceLines.invoiceId, id))
      .orderBy(asc(schema.billingInvoiceLines.position));
    for (const [index, adjustment] of adjustments.entries()) {
      await tx
        .update(schema.billingInvoiceLines)
        .set({ position: computed.length + index })
        .where(eq(schema.billingInvoiceLines.id, adjustment.id));
    }
    if (computed.length > 0) {
      await tx.insert(schema.billingInvoiceLines).values(
        computed.map((line, position) => ({
          invoiceId: id,
          position,
          source: line.source,
          contractItemId: line.contractItemId,
          description: line.description,
          metricKey: line.metricKey,
          quantity: String(line.quantity),
          unit: line.unit,
          unitPriceCents: line.unitPriceCents,
          amountCents: line.amountCents,
          detailsJson: line.details,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    const totalCents = await recomputeTotal(tx, id);
    await audit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      invoiceId: id,
      action: existing ? "billing.invoice.recomputed" : "billing.invoice.prepared",
      requestId: input.requestId,
      after: { period, contractVersion: contract.version, totalCents },
      metadata: { platformOperator: true },
    });
    return id;
  });

  const [view] = await invoiceViews([await getInvoiceRow(invoiceId)]);
  return view!;
}

const adjustmentSchema = z.object({
  description: z.string().trim().min(1).max(200),
  amountCents: z
    .number()
    .int()
    .refine((value) => value !== 0, "amount_zero")
    .refine((value) => Math.abs(value) <= 100_000_000_000, "amount_too_large"),
  reason: z.string().trim().min(3).max(500),
});

export async function addInvoiceAdjustment(input: {
  invoiceId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
}): Promise<InvoiceView> {
  const parsed = adjustmentSchema.safeParse(input.body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "body"] = issue.message;
    throw new ConsoleApiError(400, { error: "invalid_adjustment", fieldErrors });
  }
  const adjustment = parsed.data;

  await db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, input.invoiceId);
    if (invoice.status !== "draft") throw new ConsoleApiError(409, { error: "invoice_not_draft" });
    const [last] = await tx
      .select({ position: schema.billingInvoiceLines.position })
      .from(schema.billingInvoiceLines)
      .where(eq(schema.billingInvoiceLines.invoiceId, invoice.id))
      .orderBy(desc(schema.billingInvoiceLines.position))
      .limit(1);
    const now = new Date();
    await tx.insert(schema.billingInvoiceLines).values({
      invoiceId: invoice.id,
      position: (last?.position ?? -1) + 1,
      source: "adjustment",
      description: adjustment.description,
      quantity: "1",
      unit: "adjustment",
      unitPriceCents: adjustment.amountCents,
      amountCents: adjustment.amountCents,
      detailsJson: { reason: adjustment.reason },
      createdByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    const totalCents = await recomputeTotal(tx, invoice.id);
    await audit(tx, {
      organizationId: invoice.organizationId,
      actorUserId: input.actorUserId,
      invoiceId: invoice.id,
      action: "billing.invoice.adjusted",
      requestId: input.requestId,
      after: { description: adjustment.description, amountCents: adjustment.amountCents, totalCents },
      metadata: { reason: adjustment.reason, platformOperator: true },
    });
  });

  const [view] = await invoiceViews([await getInvoiceRow(input.invoiceId)]);
  return view!;
}

export async function removeInvoiceAdjustment(input: {
  invoiceId: string;
  lineId: string;
  actorUserId: string;
  requestId: string;
}): Promise<InvoiceView> {
  await db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, input.invoiceId);
    if (invoice.status !== "draft") throw new ConsoleApiError(409, { error: "invoice_not_draft" });
    const removed = await tx
      .delete(schema.billingInvoiceLines)
      .where(
        and(
          eq(schema.billingInvoiceLines.id, input.lineId),
          eq(schema.billingInvoiceLines.invoiceId, invoice.id),
          eq(schema.billingInvoiceLines.source, "adjustment"),
        ),
      )
      .returning({ description: schema.billingInvoiceLines.description, amountCents: schema.billingInvoiceLines.amountCents });
    if (removed.length === 0) throw new ConsoleApiError(404, { error: "adjustment_not_found" });
    const totalCents = await recomputeTotal(tx, invoice.id);
    await audit(tx, {
      organizationId: invoice.organizationId,
      actorUserId: input.actorUserId,
      invoiceId: invoice.id,
      action: "billing.invoice.adjustment_removed",
      requestId: input.requestId,
      after: { removed: removed[0], totalCents },
      metadata: { platformOperator: true },
    });
  });
  const [view] = await invoiceViews([await getInvoiceRow(input.invoiceId)]);
  return view!;
}

export function billingProfileGaps(account: {
  legalName: string | null;
  taxId: string | null;
  billingEmail: string | null;
} | null | undefined): string[] {
  const gaps: string[] = [];
  if (!account?.legalName) gaps.push("legalName");
  if (!account?.taxId) gaps.push("taxId");
  if (!account?.billingEmail) gaps.push("billingEmail");
  return gaps;
}

function providerFailure(error: unknown): never {
  if (error instanceof PaymentProviderError) {
    const status = error.code === "payment_provider_not_configured" ? 503 : 502;
    throw new ConsoleApiError(status, { error: error.code, reason: error.message });
  }
  throw error;
}

function periodLabel(period: string) {
  const [year, month] = period.split("-");
  return `${month}/${year}`;
}

/** Sends a draft to the payment provider: creates the charge and stores how to pay it. */
export async function issueInvoice(input: {
  invoiceId: string;
  actorUserId: string;
  requestId: string;
  now?: Date;
}): Promise<InvoiceView> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    // The row lock spans the provider calls so a double click cannot create two charges.
    const invoice = await lockInvoice(tx, input.invoiceId);
    if (invoice.status !== "draft") throw new ConsoleApiError(409, { error: "invoice_not_draft" });
    if (invoice.totalCents <= 0) throw new ConsoleApiError(409, { error: "invoice_total_not_positive" });

    const [account] = await tx
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, invoice.organizationId))
      .limit(1);
    const gaps = billingProfileGaps(account);
    if (!account || gaps.length > 0) {
      throw new ConsoleApiError(409, {
        error: "billing_profile_incomplete",
        fieldErrors: Object.fromEntries(gaps.map((gap) => [gap, "required"])),
      });
    }

    const [contract] = invoice.contractId
      ? await tx
          .select({ dueDay: schema.billingContracts.dueDay })
          .from(schema.billingContracts)
          .where(eq(schema.billingContracts.id, invoice.contractId))
          .limit(1)
      : [];
    const dueDate = invoiceDueDate(invoice.period, contract?.dueDay ?? 10, now);
    const address = account.addressJson as Record<string, string | undefined>;

    let customerId: string;
    let charge: Awaited<ReturnType<ReturnType<typeof getPaymentProvider>["createCharge"]>>;
    let instructions: PaymentInstructions = { pixCopyPaste: null, pixQrCodePng: null, boletoLine: null };
    let providerName: string;
    try {
      const provider = getPaymentProvider();
      providerName = provider.name;
      ({ customerId } = await provider.upsertCustomer({
        organizationId: invoice.organizationId,
        name: account.legalName!,
        taxId: account.taxId!,
        email: account.billingEmail!,
        phone: account.phone,
        postalCode: address.postalCode ?? null,
        address: address.street ?? null,
        addressNumber: address.number ?? null,
        complement: address.complement ?? null,
        district: address.district ?? null,
      }));
      // A charge from an earlier attempt that failed after creating it is reused, not duplicated.
      charge =
        (await provider.findChargeByReference(invoice.id)) ??
        (await provider.createCharge({
          customerId,
          invoiceId: invoice.id,
          amountCents: invoice.totalCents,
          dueDate,
          description: `Ravi · ${periodLabel(invoice.period)}`,
        }));
      instructions = await provider.getInstructions(charge.paymentId).catch(() => instructions);
    } catch (error) {
      providerFailure(error);
    }

    await tx
      .update(schema.billingInvoices)
      .set({
        status: charge.status === "paid" ? "paid" : "issued",
        dueDate,
        provider: providerName,
        providerCustomerId: customerId,
        providerPaymentId: charge.paymentId,
        providerInvoiceUrl: charge.invoiceUrl,
        pixCopyPaste: instructions.pixCopyPaste,
        boletoLine: instructions.boletoLine,
        issuedAt: now,
        issuedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(eq(schema.billingInvoices.id, invoice.id));
    await tx
      .update(schema.billingAccounts)
      .set({
        provider: providerName,
        providerCustomerId: customerId,
        // The first issued invoice starts billing; later states come from payments.
        ...(account.status === "trialing" ? { status: "active" as const } : {}),
        updatedAt: now,
      })
      .where(eq(schema.billingAccounts.id, account.id));
    await audit(tx, {
      organizationId: invoice.organizationId,
      actorUserId: input.actorUserId,
      invoiceId: invoice.id,
      action: "billing.invoice.issued",
      requestId: input.requestId,
      after: { period: invoice.period, totalCents: invoice.totalCents, dueDate, paymentId: charge.paymentId },
      metadata: { platformOperator: true, provider: providerName },
    });
  });
  const [view] = await invoiceViews([await getInvoiceRow(input.invoiceId)]);
  return view!;
}

const ACTIVE_CHARGE: InvoiceStatus[] = ["issued", "overdue"];

/** Where a provider charge state may move an invoice. Never backwards: a paid invoice does not become overdue. */
export function nextInvoiceStatus(current: InvoiceStatus, charge: PaymentChargeStatus): InvoiceStatus | null {
  switch (charge) {
    case "paid":
      return ACTIVE_CHARGE.includes(current) ? "paid" : null;
    case "overdue":
      return current === "issued" ? "overdue" : null;
    case "refunded":
      return current === "paid" || ACTIVE_CHARGE.includes(current) ? "refunded" : null;
    case "canceled":
      return ACTIVE_CHARGE.includes(current) ? "canceled" : null;
    default:
      return null;
  }
}

/**
 * Keeps the account's status in step with its invoices: past due while any
 * invoice is overdue, active again once none is. Trialing, canceled and
 * disabled accounts are left alone.
 */
async function syncAccountStatus(tx: Tx, organizationId: string, now: Date) {
  const [overdue] = await tx
    .select({ id: schema.billingInvoices.id })
    .from(schema.billingInvoices)
    .where(and(eq(schema.billingInvoices.organizationId, organizationId), eq(schema.billingInvoices.status, "overdue")))
    .limit(1);
  const [from, to] = overdue ? (["active", "past_due"] as const) : (["past_due", "active"] as const);
  await tx
    .update(schema.billingAccounts)
    .set({ status: to, updatedAt: now })
    .where(and(eq(schema.billingAccounts.organizationId, organizationId), eq(schema.billingAccounts.status, from)));
}

/** Applies a provider charge state to an invoice and the organization's billing status. */
export async function applyChargeStatus(input: {
  invoiceId: string;
  /** When set, the invoice must carry this provider payment id, or nothing changes. */
  expectedPaymentId?: string;
  charge: PaymentChargeStatus;
  paidAt?: string | null;
  source: string;
  requestId?: string | null;
}): Promise<{ changed: boolean; status: InvoiceStatus | null; mismatch?: boolean }> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(schema.billingInvoices)
      .where(eq(schema.billingInvoices.id, input.invoiceId))
      .for("update")
      .limit(1);
    if (!invoice) return { changed: false, status: null, mismatch: true };
    if (input.expectedPaymentId && invoice.providerPaymentId !== input.expectedPaymentId) {
      return { changed: false, status: invoice.status, mismatch: true };
    }
    const next = nextInvoiceStatus(invoice.status, input.charge);
    if (!next) return { changed: false, status: invoice.status };
    const now = new Date();
    await tx
      .update(schema.billingInvoices)
      .set({
        status: next,
        paidAt: next === "paid" ? (input.paidAt ? new Date(input.paidAt) : now) : invoice.paidAt,
        canceledAt: next === "canceled" ? now : invoice.canceledAt,
        updatedAt: now,
      })
      .where(eq(schema.billingInvoices.id, invoice.id));

    await syncAccountStatus(tx, invoice.organizationId, now);
    await audit(tx, {
      organizationId: invoice.organizationId,
      actorUserId: null,
      invoiceId: invoice.id,
      action: `billing.invoice.${next}`,
      requestId: input.requestId,
      after: { from: invoice.status, to: next },
      metadata: { source: input.source },
    });
    return { changed: true, status: next };
  });
}

/** Asks the provider for the charge's current state and applies it. */
export async function refreshInvoiceStatus(input: { invoiceId: string; requestId: string }): Promise<InvoiceView> {
  const invoice = await getInvoiceRow(input.invoiceId);
  if (!invoice.providerPaymentId) throw new ConsoleApiError(409, { error: "invoice_not_issued" });
  try {
    const provider = getPaymentProvider();
    const charge = await provider.getCharge(invoice.providerPaymentId);
    await applyChargeStatus({
      invoiceId: invoice.id,
      charge: charge.status,
      paidAt: charge.paidAt,
      source: "refresh",
      requestId: input.requestId,
    });
    if (!invoice.pixCopyPaste && !invoice.boletoLine && ACTIVE_CHARGE.includes(invoice.status)) {
      const instructions = await provider.getInstructions(invoice.providerPaymentId);
      await db
        .update(schema.billingInvoices)
        .set({
          pixCopyPaste: instructions.pixCopyPaste,
          boletoLine: instructions.boletoLine,
          providerInvoiceUrl: invoice.providerInvoiceUrl ?? charge.invoiceUrl,
          updatedAt: new Date(),
        })
        .where(eq(schema.billingInvoices.id, invoice.id));
    }
  } catch (error) {
    providerFailure(error);
  }
  const [view] = await invoiceViews([await getInvoiceRow(input.invoiceId)]);
  return view!;
}

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export async function cancelInvoice(input: {
  invoiceId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
}): Promise<InvoiceView> {
  const parsed = cancelSchema.safeParse(input.body);
  if (!parsed.success) throw new ConsoleApiError(400, { error: "reason_required" });
  await db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, input.invoiceId);
    if (invoice.status !== "draft" && !ACTIVE_CHARGE.includes(invoice.status)) {
      throw new ConsoleApiError(409, { error: "invoice_not_cancelable" });
    }
    if (invoice.providerPaymentId) {
      try {
        await getPaymentProvider().cancelCharge(invoice.providerPaymentId);
      } catch (error) {
        providerFailure(error);
      }
    }
    const now = new Date();
    await tx
      .update(schema.billingInvoices)
      .set({ status: "canceled", canceledAt: now, updatedAt: now })
      .where(eq(schema.billingInvoices.id, invoice.id));
    await syncAccountStatus(tx, invoice.organizationId, now);
    await audit(tx, {
      organizationId: invoice.organizationId,
      actorUserId: input.actorUserId,
      invoiceId: invoice.id,
      action: "billing.invoice.canceled",
      requestId: input.requestId,
      after: { from: invoice.status, to: "canceled" },
      metadata: { reason: parsed.data.reason, platformOperator: true },
    });
  });
  const [view] = await invoiceViews([await getInvoiceRow(input.invoiceId)]);
  return view!;
}

/** How to pay an open invoice. The QR image is fetched live; the copy codes are stored at issue. */
export async function invoicePaymentInstructions(invoice: InvoiceRow): Promise<PaymentInstructions> {
  const stored = { pixCopyPaste: invoice.pixCopyPaste, pixQrCodePng: null, boletoLine: invoice.boletoLine };
  if (!invoice.providerPaymentId || !ACTIVE_CHARGE.includes(invoice.status)) return stored;
  try {
    const live = await getPaymentProvider().getInstructions(invoice.providerPaymentId);
    return {
      pixCopyPaste: live.pixCopyPaste ?? stored.pixCopyPaste,
      pixQrCodePng: live.pixQrCodePng,
      boletoLine: live.boletoLine ?? stored.boletoLine,
    };
  } catch {
    return stored;
  }
}
