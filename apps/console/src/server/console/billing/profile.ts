import { eq } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import { formatTaxId, normalizeTaxId, taxIdKind } from "./tax-id";

// The organization's billing details: who the invoice is for. Edited by
// owner, admin and billing (console/billing/contracts).

export type BillingAddress = {
  postalCode?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
};

export type BillingProfileView = {
  legalName: string | null;
  taxId: string | null;
  taxIdKind: "cpf" | "cnpj" | null;
  billingEmail: string | null;
  phone: string | null;
  address: BillingAddress;
  complete: boolean;
  updatedAt: string | null;
};

type AccountRow = typeof schema.billingAccounts.$inferSelect;

export function billingProfileView(account: AccountRow | null | undefined): BillingProfileView {
  const taxId = account?.taxId ?? null;
  return {
    legalName: account?.legalName ?? null,
    taxId: taxId ? formatTaxId(taxId) : null,
    taxIdKind: taxId ? taxIdKind(taxId) : null,
    billingEmail: account?.billingEmail ?? null,
    phone: account?.phone ?? null,
    address: (account?.addressJson ?? {}) as BillingAddress,
    complete: Boolean(account?.legalName && account.taxId && account.billingEmail),
    updatedAt: account?.profileUpdatedAt?.toISOString() ?? null,
  };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => value || undefined);

const profileSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  taxId: z
    .string()
    .trim()
    .refine((value) => taxIdKind(value) !== null, "invalid_tax_id")
    .transform(normalizeTaxId),
  billingEmail: z.string().trim().toLowerCase().email().max(320),
  phone: optionalText(32),
  address: z
    .object({
      postalCode: z
        .string()
        .trim()
        .optional()
        .nullable()
        .transform((value) => (value ? value.replace(/\D/g, "") : undefined))
        .refine((value) => value === undefined || value.length === 8, "invalid_postal_code"),
      street: optionalText(200),
      number: optionalText(20),
      complement: optionalText(100),
      district: optionalText(100),
      city: optionalText(100),
      state: optionalText(2),
    })
    .prefault({}),
});

export async function getBillingProfile(organizationId: string): Promise<BillingProfileView> {
  const [account] = await db
    .select()
    .from(schema.billingAccounts)
    .where(eq(schema.billingAccounts.organizationId, organizationId))
    .limit(1);
  return billingProfileView(account);
}

export async function saveBillingProfile(input: {
  organizationId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
}): Promise<BillingProfileView> {
  const parsed = profileSchema.safeParse(input.body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "body"] = issue.message;
    throw new ConsoleApiError(400, { error: "invalid_billing_profile", fieldErrors });
  }
  const profile = parsed.data;
  const address = Object.fromEntries(Object.entries(profile.address).filter(([, value]) => value !== undefined));
  const now = new Date();

  const account = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, input.organizationId))
      .for("update")
      .limit(1);
    const values = {
      legalName: profile.legalName,
      taxId: profile.taxId,
      billingEmail: profile.billingEmail,
      phone: profile.phone ?? null,
      addressJson: address,
      profileUpdatedAt: now,
      profileUpdatedByUserId: input.actorUserId,
      updatedAt: now,
    };
    const [saved] = before
      ? await tx
          .update(schema.billingAccounts)
          .set(values)
          .where(eq(schema.billingAccounts.id, before.id))
          .returning()
      : await tx
          .insert(schema.billingAccounts)
          .values({ organizationId: input.organizationId, provider: "internal", createdAt: now, ...values })
          .returning();
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.actorUserId,
      targetType: "billing_account",
      targetId: saved!.id,
      action: "billing.profile.updated",
      requestId: input.requestId,
      // Only which fields changed: the details themselves stay out of the audit trail.
      metadataJson: {
        changed: Object.keys(values).filter(
          (key) =>
            !["profileUpdatedAt", "profileUpdatedByUserId", "updatedAt"].includes(key) &&
            JSON.stringify(before?.[key as keyof typeof before] ?? null) !==
              JSON.stringify(values[key as keyof typeof values] ?? null),
        ),
      },
    });
    return saved!;
  });
  return billingProfileView(account);
}
