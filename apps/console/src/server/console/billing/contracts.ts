import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { BILLABLE_METRIC_KEYS, billingUnit } from "@/shared/billing/metrics";

import { type ContractItemInput, isPeriod, shiftPeriod } from "./billing-math";

// Contract versions per organization (console/billing/contracts). Saving
// always creates a new version; the previous open one ends the month before.

const MAX_CENTS = 100_000_000_000;

const description = z.string().trim().min(1).max(200);

const fixedItemSchema = z.object({
  kind: z.literal("fixed"),
  description,
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(40).default("unit"),
  unitPriceCents: z.number().int().min(0).max(MAX_CENTS),
});

const meteredItemSchema = z
  .object({
    kind: z.literal("metered"),
    description,
    metricKey: z.enum(BILLABLE_METRIC_KEYS),
    unit: z.string().trim().min(1).max(40),
    includedQuantity: z.number().min(0).max(1_000_000_000).default(0),
    capQuantity: z.number().positive().max(1_000_000_000).nullable().optional(),
    unitPriceCents: z.number().int().min(0).max(MAX_CENTS),
  })
  .refine((item) => Boolean(billingUnit(item.metricKey, item.unit)), {
    message: "unit_not_offered_for_metric",
    path: ["unit"],
  });

export const contractInputSchema = z.object({
  startsPeriod: z.string().refine(isPeriod, "invalid_period"),
  dueDay: z.number().int().min(1).max(28),
  notes: z.string().trim().max(2_000).nullable().optional(),
  items: z.array(z.discriminatedUnion("kind", [fixedItemSchema, meteredItemSchema])).min(1).max(30),
  reason: z.string().trim().min(3).max(500),
});

export type ContractInput = z.infer<typeof contractInputSchema>;

export type ContractItemView = ContractItemInput & { id: string; position: number };

export type ContractView = {
  id: string;
  organizationId: string;
  version: number;
  status: "active" | "ended";
  startsPeriod: string;
  endsPeriod: string | null;
  currency: string;
  dueDay: number;
  notes: string | null;
  createdAt: string;
  items: ContractItemView[];
};

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function itemView(row: typeof schema.billingContractItems.$inferSelect): ContractItemView {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind,
    description: row.description,
    metricKey: row.metricKey,
    quantity: toNumber(row.quantity),
    includedQuantity: toNumber(row.includedQuantity),
    capQuantity: toNumber(row.capQuantity),
    unit: row.unit,
    unitPriceCents: row.unitPriceCents,
  };
}

async function withItems(rows: Array<typeof schema.billingContracts.$inferSelect>): Promise<ContractView[]> {
  if (rows.length === 0) return [];
  const items = await db
    .select()
    .from(schema.billingContractItems)
    .where(inArray(schema.billingContractItems.contractId, rows.map((row) => row.id)))
    .orderBy(asc(schema.billingContractItems.position));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    version: row.version,
    status: row.status,
    startsPeriod: row.startsPeriod,
    endsPeriod: row.endsPeriod,
    currency: row.currency,
    dueDay: row.dueDay,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    items: items.filter((item) => item.contractId === row.id).map(itemView),
  }));
}

export async function listContractVersions(organizationId: string): Promise<ContractView[]> {
  const rows = await db
    .select()
    .from(schema.billingContracts)
    .where(eq(schema.billingContracts.organizationId, organizationId))
    .orderBy(desc(schema.billingContracts.version));
  return withItems(rows);
}

/** The active version that covers `period`, if any. */
export async function getContractForPeriod(organizationId: string, period: string): Promise<ContractView | null> {
  const rows = await db
    .select()
    .from(schema.billingContracts)
    .where(
      and(
        eq(schema.billingContracts.organizationId, organizationId),
        eq(schema.billingContracts.status, "active"),
        lte(schema.billingContracts.startsPeriod, period),
        or(isNull(schema.billingContracts.endsPeriod), gte(schema.billingContracts.endsPeriod, period)),
      ),
    )
    .orderBy(desc(schema.billingContracts.version))
    .limit(1);
  const [contract] = await withItems(rows);
  return contract ?? null;
}

export function parseContractInput(body: unknown): ContractInput {
  const parsed = contractInputSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "body"] = issue.message;
    throw new ConsoleApiError(400, { error: "invalid_contract", fieldErrors });
  }
  return parsed.data;
}

export async function saveContract(input: {
  organizationId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
}): Promise<ContractView> {
  const contract = parseContractInput(input.body);

  const saved = await db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, input.organizationId))
      .for("update")
      .limit(1);
    if (!organization) throw new ConsoleApiError(404, { error: "organization_not_found" });

    // A month that already has an issued invoice keeps the contract it was billed with.
    const [invoiced] = await tx
      .select({ period: schema.billingInvoices.period })
      .from(schema.billingInvoices)
      .where(
        and(
          eq(schema.billingInvoices.organizationId, input.organizationId),
          gte(schema.billingInvoices.period, contract.startsPeriod),
          notInArray(schema.billingInvoices.status, ["draft", "canceled"]),
        ),
      )
      .limit(1);
    if (invoiced) {
      throw new ConsoleApiError(409, {
        error: "period_already_invoiced",
        reason: `${invoiced.period} already has an issued invoice; start the new version after it.`,
      });
    }

    const existing = await tx
      .select()
      .from(schema.billingContracts)
      .where(eq(schema.billingContracts.organizationId, input.organizationId))
      .orderBy(desc(schema.billingContracts.version));
    const now = new Date();
    const previousEnd = shiftPeriod(contract.startsPeriod, -1);

    for (const version of existing) {
      if (version.status !== "active") continue;
      if (version.startsPeriod >= contract.startsPeriod) {
        // Superseded before it ever applied.
        await tx
          .update(schema.billingContracts)
          .set({ status: "ended", updatedAt: now })
          .where(eq(schema.billingContracts.id, version.id));
      } else if (version.endsPeriod === null || version.endsPeriod > previousEnd) {
        await tx
          .update(schema.billingContracts)
          .set({ endsPeriod: previousEnd, updatedAt: now })
          .where(eq(schema.billingContracts.id, version.id));
      }
    }

    const [created] = await tx
      .insert(schema.billingContracts)
      .values({
        organizationId: input.organizationId,
        version: (existing[0]?.version ?? 0) + 1,
        status: "active",
        startsPeriod: contract.startsPeriod,
        endsPeriod: null,
        currency: "BRL",
        dueDay: contract.dueDay,
        notes: contract.notes ?? null,
        createdByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed_to_create_contract");

    await tx.insert(schema.billingContractItems).values(
      contract.items.map((item, position) => ({
        contractId: created.id,
        position,
        kind: item.kind,
        description: item.description,
        metricKey: item.kind === "metered" ? item.metricKey : null,
        quantity: item.kind === "fixed" ? String(item.quantity) : null,
        includedQuantity: item.kind === "metered" ? String(item.includedQuantity) : null,
        capQuantity: item.kind === "metered" && item.capQuantity ? String(item.capQuantity) : null,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        createdAt: now,
        updatedAt: now,
      })),
    );

    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.actorUserId,
      targetType: "billing_contract",
      targetId: created.id,
      action: "billing.contract.saved",
      requestId: input.requestId,
      afterJson: {
        version: created.version,
        startsPeriod: created.startsPeriod,
        dueDay: created.dueDay,
        items: contract.items,
      },
      metadataJson: { reason: contract.reason, platformOperator: true },
    });

    return created;
  });

  const [view] = await withItems([saved]);
  return view!;
}

/** Billable installations per organization, for comparing with what the contract sells. */
export async function countInstallations(organizationIds: string[]) {
  if (organizationIds.length === 0) return new Map<string, { active: number; billable: number }>();
  const rows = await db
    .select({
      organizationId: schema.localInstallations.organizationId,
      billable: schema.localInstallations.billable,
    })
    .from(schema.localInstallations)
    .where(
      and(
        inArray(schema.localInstallations.organizationId, organizationIds),
        eq(schema.localInstallations.status, "active"),
      ),
    );
  const counts = new Map<string, { active: number; billable: number }>();
  for (const row of rows) {
    const current = counts.get(row.organizationId) ?? { active: 0, billable: 0 };
    current.active += 1;
    if (row.billable) current.billable += 1;
    counts.set(row.organizationId, current);
  }
  return counts;
}
