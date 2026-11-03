import { and, asc, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";

import { createAdminOrganization } from "@/server/admin/organizations";
import { ConsoleApiError } from "@/server/console/api-error";
import { postgresErrorCode } from "@/server/console/bases/errors";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";

import { currentPeriod, shiftPeriod, sumCents } from "./billing-math";
import { countInstallations, getContractForPeriod, listContractVersions, saveContract } from "./contracts";
import {
  addInvoiceAdjustment,
  billingProfileGaps,
  cancelInvoice,
  issueInvoice,
  listInvoices,
  prepareInvoiceDraft,
  refreshInvoiceStatus,
  removeInvoiceAdjustment,
} from "./invoices";
import { billingProfileView } from "./profile";

// Platform-operator billing surfaces: /manage/clients and /manage/installations
// (console/billing/contracts). Every caller has passed assertPlatformOperator.

export type ManageInstallationRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  raviVersion: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  status: "active" | "revoked" | "decommissioned";
  subjectType: "user" | "installation";
  installState: string;
  installStateReason: string | null;
  desiredVersion: number;
  desiredHash: string | null;
  appliedHash: string | null;
  stateReportedAt: string | null;
  decommissionedAt: string | null;
  billable: boolean;
  billableNote: string | null;
  billableMarkedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ManageClientRow = {
  id: string;
  name: string;
  slug: string;
  billingStatus: string;
  legalName: string | null;
  profileComplete: boolean;
  contract: { version: number; monthlyFixedCents: number; meteredItems: number } | null;
  installations: { active: number; billable: number };
  lastInvoice: { id: string; period: string; status: string; totalCents: number } | null;
};

function installationRow(row: {
  installation: typeof schema.localInstallations.$inferSelect;
  organization: { name: string; slug: string };
  owner: { email: string | null; name: string | null } | null;
}): ManageInstallationRow {
  const { installation } = row;
  return {
    id: installation.id,
    organizationId: installation.organizationId,
    organizationName: row.organization.name,
    organizationSlug: row.organization.slug,
    name: installation.name,
    hostname: installation.hostname,
    platform: installation.platform,
    raviVersion: installation.raviVersion,
    ownerEmail: row.owner?.email ?? null,
    ownerName: row.owner?.name ?? null,
    status: installation.status,
    subjectType: installation.subjectType,
    installState: installation.installState,
    installStateReason: installation.installStateReason,
    desiredVersion: installation.desiredVersion,
    desiredHash: installation.desiredHash,
    appliedHash: installation.appliedHash,
    stateReportedAt: installation.stateReportedAt?.toISOString() ?? null,
    decommissionedAt: installation.decommissionedAt?.toISOString() ?? null,
    billable: installation.billable,
    billableNote: installation.billableNote,
    billableMarkedAt: installation.billableMarkedAt?.toISOString() ?? null,
    firstSeenAt: installation.firstSeenAt.toISOString(),
    lastSeenAt: installation.lastSeenAt.toISOString(),
  };
}

export async function listManageInstallations(params: URLSearchParams): Promise<ManageInstallationRow[]> {
  const organizationId = params.get("organizationId");
  const query = params.get("q")?.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const billable = params.get("billable");
  const includeRevoked = params.get("status") === "all";
  const table = schema.localInstallations;
  const rows = await db
    .select({
      installation: table,
      organization: { name: schema.organizations.name, slug: schema.organizations.slug },
      owner: { email: schema.users.primaryEmail, name: schema.users.displayName },
    })
    .from(table)
    .innerJoin(schema.organizations, eq(table.organizationId, schema.organizations.id))
    .leftJoin(schema.users, eq(table.userId, schema.users.id))
    .where(
      and(
        organizationId && isUuidRef(organizationId) ? eq(table.organizationId, organizationId) : undefined,
        includeRevoked ? undefined : eq(table.status, "active"),
        billable === "true" ? eq(table.billable, true) : billable === "false" ? eq(table.billable, false) : undefined,
        query
          ? or(
              ilike(table.name, `%${query}%`),
              ilike(table.hostname, `%${query}%`),
              ilike(schema.organizations.name, `%${query}%`),
              ilike(schema.users.primaryEmail, `%${query}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(table.lastSeenAt))
    .limit(500);
  return rows.map(installationRow);
}

const billableSchema = z.object({
  billable: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});

export async function setInstallationBillable(input: {
  installationId: string;
  body: unknown;
  actorUserId: string;
  requestId: string;
}): Promise<ManageInstallationRow> {
  if (!isUuidRef(input.installationId)) throw new ConsoleApiError(404, { error: "installation_not_found" });
  const parsed = billableSchema.safeParse(input.body);
  if (!parsed.success) throw new ConsoleApiError(400, { error: "reason_required" });
  const { billable, note, reason } = parsed.data;

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.localInstallations)
      .where(eq(schema.localInstallations.id, input.installationId))
      .for("update")
      .limit(1);
    if (!before) throw new ConsoleApiError(404, { error: "installation_not_found" });
    const now = new Date();
    await tx
      .update(schema.localInstallations)
      .set({
        billable,
        billableNote: note ?? null,
        billableMarkedAt: now,
        billableMarkedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(eq(schema.localInstallations.id, before.id));
    await tx.insert(schema.auditEvents).values({
      organizationId: before.organizationId,
      actorType: "user",
      actorId: input.actorUserId,
      targetType: "local_installation",
      targetId: before.id,
      action: billable ? "billing.installation.billable" : "billing.installation.not_billable",
      requestId: input.requestId,
      beforeJson: { billable: before.billable, note: before.billableNote },
      afterJson: { billable, note: note ?? null },
      metadataJson: { reason, platformOperator: true },
    });
  });

  const [row] = await listManageInstallationsById([input.installationId]);
  return row!;
}

async function listManageInstallationsById(ids: string[]) {
  const table = schema.localInstallations;
  const rows = await db
    .select({
      installation: table,
      organization: { name: schema.organizations.name, slug: schema.organizations.slug },
      owner: { email: schema.users.primaryEmail, name: schema.users.displayName },
    })
    .from(table)
    .innerJoin(schema.organizations, eq(table.organizationId, schema.organizations.id))
    .leftJoin(schema.users, eq(table.userId, schema.users.id))
    .where(inArray(table.id, ids));
  return rows.map(installationRow);
}

export async function listManageClients(now = new Date()): Promise<ManageClientRow[]> {
  const organizations = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      account: schema.billingAccounts,
    })
    .from(schema.organizations)
    .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.organizationId, schema.organizations.id))
    .where(eq(schema.organizations.status, "active"))
    .orderBy(asc(schema.organizations.name));
  const ids = organizations.map((organization) => organization.id);
  const counts = await countInstallations(ids);
  const period = currentPeriod(now);

  const invoices = ids.length
    ? await db
        .select({
          id: schema.billingInvoices.id,
          organizationId: schema.billingInvoices.organizationId,
          period: schema.billingInvoices.period,
          status: schema.billingInvoices.status,
          totalCents: schema.billingInvoices.totalCents,
        })
        .from(schema.billingInvoices)
        .where(and(inArray(schema.billingInvoices.organizationId, ids), ne(schema.billingInvoices.status, "canceled")))
        .orderBy(desc(schema.billingInvoices.period))
    : [];

  return Promise.all(
    organizations.map(async (organization) => {
      const contract = await getContractForPeriod(organization.id, period);
      const last = invoices.find((invoice) => invoice.organizationId === organization.id) ?? null;
      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        billingStatus: organization.account?.status ?? "trialing",
        legalName: organization.account?.legalName ?? null,
        profileComplete: billingProfileGaps(organization.account).length === 0,
        contract: contract
          ? {
              version: contract.version,
              monthlyFixedCents: sumCents(
                contract.items
                  .filter((item) => item.kind === "fixed")
                  .map((item) => Math.round((item.quantity ?? 0) * item.unitPriceCents)),
              ),
              meteredItems: contract.items.filter((item) => item.kind === "metered").length,
            }
          : null,
        installations: counts.get(organization.id) ?? { active: 0, billable: 0 },
        lastInvoice: last,
      } satisfies ManageClientRow;
    }),
  );
}

export async function getManageClient(organizationId: string, now = new Date()) {
  if (!isUuidRef(organizationId)) throw new ConsoleApiError(404, { error: "organization_not_found" });
  const [organization] = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      status: schema.organizations.status,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new ConsoleApiError(404, { error: "organization_not_found" });
  const [account] = await db
    .select()
    .from(schema.billingAccounts)
    .where(eq(schema.billingAccounts.organizationId, organizationId))
    .limit(1);
  const [contracts, invoices, installations] = await Promise.all([
    listContractVersions(organizationId),
    listInvoices(organizationId, { includeDrafts: true }),
    listManageInstallations(new URLSearchParams({ organizationId, status: "all" })),
  ]);
  const period = currentPeriod(now);
  return {
    organization,
    billing: {
      status: account?.status ?? "trialing",
      provider: account?.provider ?? null,
      providerCustomerId: account?.providerCustomerId ?? null,
      profile: billingProfileView(account),
    },
    contracts,
    currentContractId: (await getContractForPeriod(organizationId, period))?.id ?? null,
    invoices,
    installations,
    periods: { current: period, previous: shiftPeriod(period, -1) },
  };
}

const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().min(2).max(63),
  ownerEmail: z.string().trim().toLowerCase().email().max(320),
  reason: z.string().trim().min(3).max(500),
});

export async function createClientOrganization(input: { body: unknown; actorUserId: string; requestId: string }) {
  const parsed = createOrganizationSchema.safeParse(input.body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".") || "body"] = issue.message;
    throw new ConsoleApiError(400, { error: "invalid_organization", fieldErrors });
  }
  // The admin helper adopts an existing slug and makes the owner its owner;
  // from this screen an existing slug is always a mistake.
  const [taken] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, parsed.data.slug))
    .limit(1);
  if (taken) {
    throw new ConsoleApiError(409, { error: "organization_slug_taken", fieldErrors: { slug: "organization_slug_taken" } });
  }
  let result: Awaited<ReturnType<typeof createAdminOrganization>>;
  try {
    result = await createAdminOrganization({
      body: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        ownerUserRef: parsed.data.ownerEmail,
        reason: parsed.data.reason,
      },
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      source: "manage_billing",
      // The check above can race another create; the helper re-checks inside its transaction.
      creationOnly: true,
    });
  } catch (error) {
    // Two creates for the same new slug: the loser's insert hits the unique index and rolls back.
    if (postgresErrorCode(error) === "23505") {
      throw new ConsoleApiError(409, { error: "organization_slug_taken", fieldErrors: { slug: "organization_slug_taken" } });
    }
    if (error instanceof Error && error.name === "AdminOrganizationError") {
      throw new ConsoleApiError(400, { error: error.message, fieldErrors: { slug: error.message } });
    }
    throw error;
  }
  if (result.status === "not_found") {
    throw new ConsoleApiError(404, {
      error: "owner_user_not_found",
      reason: "The owner must sign in to Console once before an organization can be created for them.",
      fieldErrors: { ownerEmail: "owner_user_not_found" },
    });
  }
  if (result.status === "exists") {
    throw new ConsoleApiError(409, { error: "organization_slug_taken", fieldErrors: { slug: "organization_slug_taken" } });
  }
  return { organization: result.organization };
}

/** Routes /api/console/manage/billing/** for a platform operator. */
export async function routeManageBillingRequest(input: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  segments: string[];
  searchParams: URLSearchParams;
  body: unknown;
  operatorId: string;
  requestId: string;
}): Promise<unknown> {
  const [area, id, child, childId] = input.segments;
  const actor = { actorUserId: input.operatorId, requestId: input.requestId };

  if (area === "clients") {
    if (!id) {
      if (input.method === "GET") return { clients: await listManageClients() };
      if (input.method === "POST") return createClientOrganization({ body: input.body, ...actor });
    }
    if (!id) throw new ConsoleApiError(404, { error: "not_found" });
    if (!isUuidRef(id)) throw new ConsoleApiError(404, { error: "organization_not_found" });
    if (!child && input.method === "GET") return getManageClient(id);
    if (child === "contracts" && !childId && input.method === "POST") {
      return { contract: await saveContract({ organizationId: id, body: input.body, ...actor }) };
    }
    if (child === "invoices" && !childId && input.method === "POST") {
      return { invoice: await prepareInvoiceDraft({ organizationId: id, body: input.body, ...actor }) };
    }
  }

  if (area === "installations") {
    if (!id && input.method === "GET") return { installations: await listManageInstallations(input.searchParams) };
    if (id && child === "billable" && input.method === "POST") {
      return {
        installation: await setInstallationBillable({ installationId: id, body: input.body, ...actor }),
      };
    }
  }

  if (area === "invoices" && id && isUuidRef(id)) {
    if (child === "adjustments" && !childId && input.method === "POST") {
      return { invoice: await addInvoiceAdjustment({ invoiceId: id, body: input.body, ...actor }) };
    }
    if (child === "adjustments" && childId && isUuidRef(childId) && input.method === "DELETE") {
      return { invoice: await removeInvoiceAdjustment({ invoiceId: id, lineId: childId, ...actor }) };
    }
    if (child === "issue" && input.method === "POST") return { invoice: await issueInvoice({ invoiceId: id, ...actor }) };
    if (child === "refresh" && input.method === "POST") {
      return { invoice: await refreshInvoiceStatus({ invoiceId: id, requestId: input.requestId }) };
    }
    if (child === "cancel" && input.method === "POST") {
      return { invoice: await cancelInvoice({ invoiceId: id, body: input.body, ...actor }) };
    }
  }

  throw new ConsoleApiError(404, { error: "not_found" });
}

