import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import { createAdminOrganization } from "@/server/admin/organizations";
import { db, schema } from "@/server/db";

import { setPaymentProviderForTests } from "./asaas";
import { handleAsaasWebhook } from "./asaas-webhook";
import { periodWindow, shiftPeriod } from "./billing-math";
import { saveContract } from "./contracts";
import { addInvoiceAdjustment, cancelInvoice, issueInvoice, prepareInvoiceDraft } from "./invoices";
import { createClientOrganization, routeManageBillingRequest } from "./manage";
import { routeOrgBillingRequest } from "./org-billing";
import type { PaymentProvider } from "./payment-provider";
import { saveBillingProfile } from "./profile";

// Runs only with BILLING_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.BILLING_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const operator = randomUUID();
const owner = randomUUID();
const billedLaptop = randomUUID();
const otherLaptop = randomUUID();
const period = "2026-09";
const token = `webhook-${suffix}`;
const actor = { actorUserId: operator, requestId: `req-${suffix}` };

const charges = new Map<string, { invoiceId: string; amountCents: number }>();
const provider: PaymentProvider = {
  name: "asaas",
  async upsertCustomer() {
    return { customerId: `cus_${suffix}` };
  },
  async createCharge(input) {
    const paymentId = `pay_${suffix}_${charges.size + 1}`;
    charges.set(paymentId, { invoiceId: input.invoiceId, amountCents: input.amountCents });
    return { paymentId, status: "pending", invoiceUrl: `https://pay.example.test/${paymentId}`, paidAt: null };
  },
  async findChargeByReference(invoiceId) {
    const found = [...charges].find(([, charge]) => charge.invoiceId === invoiceId);
    return found ? { paymentId: found[0], status: "pending", invoiceUrl: null, paidAt: null } : null;
  },
  async getCharge(paymentId) {
    return { paymentId, status: "pending", invoiceUrl: null, paidAt: null };
  },
  async getInstructions() {
    return { pixCopyPaste: "00020101pix", pixQrCodePng: "iVBORw0", boletoLine: "23790.00000 00000.000000" };
  },
  async cancelCharge() {},
};

function workspace(role: "owner" | "billing"): ConsoleWorkspace {
  return {
    membership: { role, status: "active" },
    mode: "workos",
    organization: { id: orgId },
    user: { id: owner },
  } as unknown as ConsoleWorkspace;
}

async function errorCode(promise: Promise<unknown>) {
  const error = (await promise.catch((caught: unknown) => caught)) as { payload?: { error?: string } };
  return error?.payload?.error;
}

describeDb("contract billing, from contract to paid invoice", () => {
  beforeAll(async () => {
    setPaymentProviderForTests(provider);
    await db.insert(schema.organizations).values({ id: orgId, name: "Billing test", slug: `billing-${suffix}` });
    await db.insert(schema.users).values([
      { displayName: "Paula Operator", id: operator, primaryEmail: `billing-operator-${suffix}@example.test` },
      { displayName: "Otto Owner", id: owner, primaryEmail: `billing-owner-${suffix}@example.test` },
    ]);
    await db.insert(schema.organizationMemberships).values({ organizationId: orgId, role: "owner", userId: owner });
    await db.insert(schema.localInstallations).values([
      { id: billedLaptop, name: "escritorio", organizationId: orgId, userId: owner },
      { id: otherLaptop, name: "notebook", organizationId: orgId, userId: owner },
    ]);
    const { start, end } = periodWindow(period);
    await db.insert(schema.usageEvents).values([
      // 30 minutes in the month, 10 included: 20 billed. The second event is next month.
      { eventType: "meeting.recorded", metricKey: "meetings.recording_seconds", organizationId: orgId, occurredAt: start, quantity: "1800", source: "test", unit: "second" },
      { eventType: "meeting.recorded", metricKey: "meetings.recording_seconds", organizationId: orgId, occurredAt: end, quantity: "6000", source: "test", unit: "second" },
    ]);
  });

  afterAll(async () => {
    setPaymentProviderForTests(undefined);
    await db.delete(schema.billingProviderEvents).where(inArray(schema.billingProviderEvents.providerPaymentId, [...charges.keys()]));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.organizationId, orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(inArray(schema.users.id, [operator, owner]));
  });

  test("marks an installation billable with a reason", async () => {
    const result = (await routeManageBillingRequest({
      method: "POST",
      segments: ["installations", billedLaptop, "billable"],
      searchParams: new URLSearchParams(),
      body: { billable: true, note: "Line 1", reason: "Signed contract" },
      operatorId: operator,
      requestId: actor.requestId,
    })) as { installation: { billable: boolean; billableNote: string } };
    expect(result.installation).toMatchObject({ billable: true, billableNote: "Line 1" });

    const org = (await routeOrgBillingRequest({
      method: "GET",
      segments: ["installations"],
      body: {},
      workspace: workspace("owner"),
      requestId: actor.requestId,
    })) as { installations: Array<{ id: string }> };
    expect(org.installations.map((row) => row.id)).toEqual([billedLaptop]);
    expect(
      await errorCode(
        routeOrgBillingRequest({ method: "GET", segments: ["installations"], body: {}, workspace: workspace("billing"), requestId: "r" }),
      ),
    ).toBe("feature_forbidden");
  });

  test("bills the contract's fixed lines and the usage above what is included", async () => {
    const contract = await saveContract({
      organizationId: orgId,
      body: {
        startsPeriod: shiftPeriod(period, -1),
        dueDay: 10,
        items: [
          { kind: "fixed", description: "Ravi installation", quantity: 2, unit: "installation", unitPriceCents: 150_000 },
          {
            kind: "metered",
            description: "Call recording",
            metricKey: "meetings.recording_seconds",
            unit: "minute",
            includedQuantity: 10,
            unitPriceCents: 50,
          },
        ],
        reason: "Signed proposal",
      },
      ...actor,
    });
    expect(contract.version).toBe(1);

    const draft = await prepareInvoiceDraft({ organizationId: orgId, body: { period }, ...actor });
    expect(draft.status).toBe("draft");
    expect(draft.lines.map((line) => line.amountCents)).toEqual([300_000, 1_000]);
    expect(draft.totalCents).toBe(301_000);

    const adjusted = await addInvoiceAdjustment({
      invoiceId: draft.id,
      body: { description: "Onboarding discount", amountCents: -50_000, reason: "Agreed in the proposal" },
      ...actor,
    });
    expect(adjusted.totalCents).toBe(251_000);

    // Preparing again rebuilds the contract lines and keeps the adjustment.
    const again = await prepareInvoiceDraft({ organizationId: orgId, body: { period }, ...actor });
    expect(again.id).toBe(draft.id);
    expect(again.lines.map((line) => line.source)).toEqual(["contract_fixed", "contract_metered", "adjustment"]);
    expect(again.totalCents).toBe(251_000);

    // The client doesn't see the draft.
    const listed = (await routeOrgBillingRequest({
      method: "GET",
      segments: ["invoices"],
      body: {},
      workspace: workspace("billing"),
      requestId: "r",
    })) as { invoices: unknown[] };
    expect(listed.invoices).toEqual([]);
  });

  test("issues only with complete billing details, then pays through the webhook once", async () => {
    const [draft] = await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.organizationId, orgId));
    expect(await errorCode(issueInvoice({ invoiceId: draft!.id, ...actor }))).toBe("billing_profile_incomplete");

    await saveBillingProfile({
      organizationId: orgId,
      body: { legalName: "Cliente Teste Ltda", taxId: "11.222.333/0001-81", billingEmail: "Financeiro@Example.test" },
      actorUserId: owner,
      requestId: "r",
    });
    const issued = await issueInvoice({ invoiceId: draft!.id, ...actor, now: new Date("2026-10-02T12:00:00Z") });
    expect(issued).toMatchObject({ status: "issued", dueDate: "2026-10-10", boletoLine: "23790.00000 00000.000000" });
    expect(charges.get(issued.providerPaymentId!)).toEqual({ invoiceId: draft!.id, amountCents: 251_000 });

    // A month already invoiced keeps its contract.
    expect(
      await errorCode(
        saveContract({
          organizationId: orgId,
          body: { startsPeriod: period, dueDay: 5, items: [{ kind: "fixed", description: "x", quantity: 1, unit: "u", unitPriceCents: 1 }], reason: "late change" },
          ...actor,
        }),
      ),
    ).toBe("period_already_invoiced");

    const view = (await routeOrgBillingRequest({
      method: "GET",
      segments: ["invoices", draft!.id],
      body: {},
      workspace: workspace("billing"),
      requestId: "r",
    })) as { invoice: { providerPaymentId: string | null; invoiceUrl: string | null; lines: Array<{ source: string; details: object }> }; payment: { pixQrCodePng: string } };
    expect(view.invoice.providerPaymentId).toBeNull();
    expect(view.invoice.invoiceUrl).toBeNull();
    expect(view.invoice.lines.find((line) => line.source === "adjustment")?.details).toEqual({});
    expect(view.payment.pixQrCodePng).toBe("iVBORw0");

    const event = {
      id: `evt_${suffix}`,
      event: "PAYMENT_RECEIVED",
      payment: { id: issued.providerPaymentId, status: "RECEIVED", paymentDate: "2026-10-05", externalReference: draft!.id, customer: "cus", value: 2510 },
    };
    const first = await handleAsaasWebhook({ token, expectedToken: token, body: event, requestId: "r" });
    expect(first).toEqual({ status: 200, body: { received: true, outcome: "invoice_paid" } });
    const second = await handleAsaasWebhook({ token, expectedToken: token, body: event, requestId: "r" });
    expect(second.body.duplicate).toBe(true);
    // A late overdue notice doesn't move a paid invoice back.
    const late = await handleAsaasWebhook({
      token,
      expectedToken: token,
      body: { ...event, id: `evt_${suffix}_late`, event: "PAYMENT_OVERDUE" },
      requestId: "r",
    });
    expect(late.body.outcome).toBe("no_change");

    const [paid] = await db.select().from(schema.billingInvoices).where(eq(schema.billingInvoices.id, draft!.id));
    expect(paid?.status).toBe("paid");
    const [account] = await db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.organizationId, orgId));
    expect(account).toMatchObject({ status: "active", providerCustomerId: `cus_${suffix}`, billingEmail: "financeiro@example.test" });
    const [stored] = await db.select().from(schema.billingProviderEvents).where(eq(schema.billingProviderEvents.providerEventId, event.id));
    expect(stored?.payloadJson).not.toHaveProperty("payment.customer");
    expect(stored?.outcome).toBe("invoice_paid");
    expect(await errorCode(cancelInvoice({ invoiceId: draft!.id, body: { reason: "test" }, ...actor }))).toBe("invoice_not_cancelable");
  });

  test("reuses a charge left by a failed issue, and holds past due only while an invoice is overdue", async () => {
    const next = shiftPeriod(period, 1);
    const draft = await prepareInvoiceDraft({ organizationId: orgId, body: { period: next }, ...actor });
    // An earlier attempt created the charge, then failed before saving it.
    const leftover = `pay_${suffix}_leftover`;
    charges.set(leftover, { invoiceId: draft.id, amountCents: draft.totalCents });
    const issued = await issueInvoice({ invoiceId: draft.id, ...actor, now: new Date("2026-11-02T12:00:00Z") });
    expect(issued.providerPaymentId).toBe(leftover);

    const overdue = await handleAsaasWebhook({
      token,
      expectedToken: token,
      body: { id: `evt_${suffix}_overdue`, event: "PAYMENT_OVERDUE", payment: { id: leftover, status: "OVERDUE", externalReference: draft.id } },
      requestId: "r",
    });
    expect(overdue.body.outcome).toBe("invoice_overdue");
    const accountStatus = async () =>
      (await db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.organizationId, orgId)))[0]?.status;
    expect(await accountStatus()).toBe("past_due");

    const refunded = await handleAsaasWebhook({
      token,
      expectedToken: token,
      body: { id: `evt_${suffix}_refund`, event: "PAYMENT_REFUNDED", payment: { id: leftover, status: "REFUNDED", externalReference: draft.id } },
      requestId: "r",
    });
    expect(refunded.body.outcome).toBe("invoice_refunded");
    expect(await accountStatus()).toBe("active");

    // Canceling the last overdue invoice also lifts past due.
    const later = await prepareInvoiceDraft({ organizationId: orgId, body: { period: shiftPeriod(period, 2) }, ...actor });
    const laterIssued = await issueInvoice({ invoiceId: later.id, ...actor, now: new Date("2026-12-02T12:00:00Z") });
    await handleAsaasWebhook({
      token,
      expectedToken: token,
      body: { id: `evt_${suffix}_overdue2`, event: "PAYMENT_OVERDUE", payment: { id: laterIssued.providerPaymentId, status: "OVERDUE", externalReference: later.id } },
      requestId: "r",
    });
    expect(await accountStatus()).toBe("past_due");
    await cancelInvoice({ invoiceId: later.id, body: { reason: "negotiated off" }, ...actor });
    expect(await accountStatus()).toBe("active");
  });

  test("creating a client for a taken slug leaves that organization's members alone", async () => {
    const takenId = randomUUID();
    const slug = `cliente-teste-${suffix}`;
    await db.insert(schema.organizations).values({ id: takenId, name: "Taken", slug });
    try {
      const result = await createAdminOrganization({
        body: { name: "Other", slug, ownerUserRef: `billing-operator-${suffix}@example.test`, reason: "race" },
        actorUserId: operator,
        requestId: "r",
        creationOnly: true,
      });
      expect(result.status).toBe("exists");
      const members = await db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.organizationId, takenId));
      expect(members).toEqual([]);
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, takenId));
    }
  });

  test("two creates racing for a new slug: one wins, the other gets 409 and adds no owner", async () => {
    const slug = `cliente-corrida-${suffix}`;
    const attempt = (email: string) =>
      createClientOrganization({ body: { name: "Race", slug, ownerEmail: email, reason: "race" }, actorUserId: operator, requestId: "r" })
        .then(() => "created")
        .catch((error: { payload?: { error?: string } }) => error.payload?.error ?? "threw");
    try {
      const results = await Promise.all([
        attempt(`billing-owner-${suffix}@example.test`),
        attempt(`billing-operator-${suffix}@example.test`),
      ]);
      expect(results.sort()).toEqual(["created", "organization_slug_taken"]);
      const [created] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
      const members = await db
        .select()
        .from(schema.organizationMemberships)
        .where(eq(schema.organizationMemberships.organizationId, created!.id));
      expect(members).toHaveLength(1);
    } finally {
      const [created] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
      if (created) {
        await db.delete(schema.auditEvents).where(eq(schema.auditEvents.organizationId, created.id));
        await db.delete(schema.organizations).where(eq(schema.organizations.id, created.id));
      }
    }
  });

  test("an event for a payment Ravi didn't issue changes nothing", async () => {
    const result = await handleAsaasWebhook({
      token,
      expectedToken: token,
      body: { id: `evt_${suffix}_foreign`, event: "PAYMENT_RECEIVED", payment: { id: `pay_${suffix}_foreign`, externalReference: randomUUID() } },
      requestId: "r",
    });
    charges.set(`pay_${suffix}_foreign`, { invoiceId: "", amountCents: 0 });
    expect(result.body.outcome).toBe("unknown_payment");
  });
});
