import { and, desc, eq } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { isUuidRef } from "@/server/console/ref";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { type ComputedLine, currentPeriod, sumCents } from "./billing-math";
import { type ContractView, getContractForPeriod } from "./contracts";
import {
  computeLinesForContract,
  getInvoiceRow,
  type InvoiceView,
  invoicePaymentInstructions,
  invoiceViews,
  listInvoices,
} from "./invoices";
import { type BillingProfileView, getBillingProfile, saveBillingProfile } from "./profile";

// /api/console/billing/** for the selected organization (feature
// console.billing: owner, admin, billing). Never names the payment provider.

const INSTALLATION_ROLES = new Set(["owner", "admin"]);

export type OrgBillingOverview = {
  period: string;
  status: string;
  contract: Pick<ContractView, "version" | "startsPeriod" | "dueDay" | "currency" | "items"> | null;
  preview: { lines: ComputedLine[]; totalCents: number } | null;
  profile: BillingProfileView;
  canSeeInstallations: boolean;
};

export async function getOrgBillingOverview(workspace: ConsoleWorkspace, now = new Date()): Promise<OrgBillingOverview> {
  const organizationId = workspace.organization.id;
  const period = currentPeriod(now);
  const [contract, profile, [account]] = await Promise.all([
    getContractForPeriod(organizationId, period),
    getBillingProfile(organizationId),
    db
      .select({ status: schema.billingAccounts.status })
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, organizationId))
      .limit(1),
  ]);
  const lines = contract ? await computeLinesForContract(organizationId, contract, period) : null;
  return {
    period,
    status: account?.status ?? "trialing",
    contract: contract
      ? {
          version: contract.version,
          startsPeriod: contract.startsPeriod,
          dueDay: contract.dueDay,
          currency: contract.currency,
          items: contract.items,
        }
      : null,
    preview: lines ? { lines, totalCents: sumCents(lines.map((line) => line.amountCents)) } : null,
    profile,
    canSeeInstallations: INSTALLATION_ROLES.has(workspace.membership.role),
  };
}

export async function listOrgBillableInstallations(workspace: ConsoleWorkspace) {
  if (!INSTALLATION_ROLES.has(workspace.membership.role)) {
    throw new ConsoleApiError(403, { error: "feature_forbidden" });
  }
  const table = schema.localInstallations;
  const rows = await db
    .select({
      id: table.id,
      name: table.name,
      hostname: table.hostname,
      platform: table.platform,
      raviVersion: table.raviVersion,
      lastSeenAt: table.lastSeenAt,
      ownerEmail: schema.users.primaryEmail,
    })
    .from(table)
    .innerJoin(schema.users, eq(table.userId, schema.users.id))
    .where(
      and(eq(table.organizationId, workspace.organization.id), eq(table.status, "active"), eq(table.billable, true)),
    )
    .orderBy(desc(table.lastSeenAt))
    .limit(200);
  return rows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt.toISOString() }));
}

/**
 * The invoice as the organization sees it: no provider ids or provider pages,
 * and adjustments without the operator's internal reason.
 */
function clientInvoice(invoice: InvoiceView): InvoiceView {
  return {
    ...invoice,
    providerPaymentId: null,
    invoiceUrl: null,
    lines: invoice.lines.map((line) => (line.source === "adjustment" ? { ...line, details: {} } : line)),
  };
}

async function getOrgInvoice(workspace: ConsoleWorkspace, invoiceId: string) {
  if (!isUuidRef(invoiceId)) throw new ConsoleApiError(404, { error: "invoice_not_found" });
  const row = await getInvoiceRow(invoiceId).catch(() => null);
  // Drafts are the operator's work in progress; they are not the client's invoice yet.
  if (!row || row.organizationId !== workspace.organization.id || row.status === "draft") {
    throw new ConsoleApiError(404, { error: "invoice_not_found" });
  }
  const [view] = await invoiceViews([row]);
  const open = row.status === "issued" || row.status === "overdue";
  const payment = open ? await invoicePaymentInstructions(row) : null;
  return { invoice: clientInvoice(view!), payment };
}

export async function routeOrgBillingRequest(input: {
  method: "GET" | "POST";
  segments: string[];
  body: unknown;
  workspace: ConsoleWorkspace;
  requestId: string;
}): Promise<unknown> {
  const [area, id] = input.segments;
  const { workspace } = input;

  if (!area && input.method === "GET") return getOrgBillingOverview(workspace);
  if (area === "profile" && !id) {
    if (input.method === "GET") return { profile: await getBillingProfile(workspace.organization.id) };
    if (input.method === "POST") {
      return {
        profile: await saveBillingProfile({
          organizationId: workspace.organization.id,
          body: input.body,
          actorUserId: workspace.user.id,
          requestId: input.requestId,
        }),
      };
    }
  }
  if (area === "invoices" && input.method === "GET") {
    if (!id) {
      const invoices = await listInvoices(workspace.organization.id);
      return { invoices: invoices.map(clientInvoice) };
    }
    return getOrgInvoice(workspace, id);
  }
  if (area === "installations" && !id && input.method === "GET") {
    return { installations: await listOrgBillableInstallations(workspace) };
  }
  throw new ConsoleApiError(404, { error: "not_found" });
}
