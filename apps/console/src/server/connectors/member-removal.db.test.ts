import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { revokeRemovedMemberConnectorAccess } from "./member-removal";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const member = randomUUID();
const other = randomUUID();
const installation = randomUUID();
const otherInstallation = randomUUID();
const binding = randomUUID();
const ids = {
  // the member's
  active: randomUUID(),
  revokePending: randomUUID(),
  legacyProject: randomUUID(),
  history: randomUUID(),
  github: randomUUID(),
  // someone else's, and the organization's
  othersAccount: randomUUID(),
  orgAccount: randomUUID(),
};
const grantByMember = randomUUID();
const grantByMemberNoConnection = randomUUID();
const sharedGrantByMember = randomUUID();
const grantByOtherOnMemberAccount = randomUUID();
const grantByOther = randomUUID();
const approvalOwned = randomUUID();
const approvalRequested = randomUUID();
const approvalUnrelated = randomUUID();
const approvalApproved = randomUUID();
const consentForMember = randomUUID();
const consentForOther = randomUUID();
const queuedOutbox = randomUUID();

function connection(id: string, values: Partial<typeof schema.providerConnections.$inferInsert>) {
  return {
    displayName: "google",
    id,
    organizationId: orgId,
    provider: "google",
    scopeKind: "user" as const,
    userId: member,
    ...values,
  };
}

describeDb("removing a member suspends their connectors", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, name: "Member removal test", slug: `member-removal-${suffix}` });
    await db.insert(schema.projects).values({ id: projectId, name: "P", organizationId: orgId, slug: `p-${suffix}` });
    await db.insert(schema.users).values([
      { id: member, primaryEmail: `member-${suffix}@example.test` },
      { id: other, primaryEmail: `other-${suffix}@example.test` },
    ]);
    await db.insert(schema.localInstallations).values([
      { id: installation, name: "laptop", organizationId: orgId, userId: member },
      { id: otherInstallation, name: "desktop", organizationId: orgId, userId: other },
    ]);
    await db.insert(schema.raviActorBindings).values({
      consoleUserId: member,
      contactId: "contact-member",
      id: binding,
      installationId: otherInstallation,
      linkedBy: member,
      organizationId: orgId,
    });
    await db.insert(schema.providerConnections).values([
      connection(ids.active, {}),
      connection(ids.revokePending, { status: "revoke_pending" }),
      connection(ids.legacyProject, { projectId, scopeKind: "project" }),
      connection(ids.history, { status: "revoked_by_user" }),
      connection(ids.github, { displayName: "github", projectId, provider: "github", scopeKind: "project" }),
      connection(ids.othersAccount, { userId: other }),
      connection(ids.orgAccount, { managedByUserId: member, scopeKind: "organization", userId: null }),
    ]);
    await db.insert(schema.connectorRevocationOutbox).values({
      id: queuedOutbox,
      organizationId: orgId,
      providerConnectionId: ids.revokePending,
      reason: "member_removed",
    });
    await db.insert(schema.agentConnectorGrants).values([
      {
        agentId: "main",
        grantedByUserId: member,
        id: grantByMember,
        localInstallationId: otherInstallation,
        mode: "person_asking",
        organizationId: orgId,
        provider: "google",
        providerConnectionId: ids.active,
      },
      {
        // A consent that follows their default account (no connection picked).
        agentId: "notes",
        grantedByUserId: member,
        id: grantByMemberNoConnection,
        localInstallationId: otherInstallation,
        mode: "person_asking",
        organizationId: orgId,
        provider: "google",
        providerConnectionId: null,
      },
      {
        // They shared the organization account they manage: the grant is the account's.
        agentId: "support",
        grantedByUserId: member,
        id: sharedGrantByMember,
        localInstallationId: otherInstallation,
        mode: "shared",
        organizationId: orgId,
        provider: "google",
        providerConnectionId: ids.orgAccount,
      },
      {
        agentId: "helper",
        grantedByUserId: other,
        id: grantByOtherOnMemberAccount,
        localInstallationId: otherInstallation,
        mode: "shared",
        organizationId: orgId,
        provider: "google",
        providerConnectionId: ids.legacyProject,
      },
      {
        agentId: "main",
        grantedByUserId: other,
        id: grantByOther,
        localInstallationId: otherInstallation,
        mode: "person_asking",
        organizationId: orgId,
        provider: "google",
        providerConnectionId: ids.othersAccount,
      },
    ]);
    const approval = (id: string, values: Partial<typeof schema.connectorActionApprovals.$inferInsert>) => ({
      capability: "gmail.message.send",
      capabilityClass: "write",
      expiresAt: new Date(Date.now() + 900_000),
      id,
      organizationId: orgId,
      ownerUserId: member,
      paramsHash: "h",
      providerConnectionId: ids.active,
      ...values,
    });
    await db.insert(schema.connectorActionApprovals).values([
      approval(approvalOwned, {}),
      approval(approvalRequested, { ownerUserId: other, providerConnectionId: ids.othersAccount, requestedByUserId: member }),
      approval(approvalUnrelated, { ownerUserId: other, providerConnectionId: ids.othersAccount, requestedByUserId: other }),
      approval(approvalApproved, { status: "approved" }),
    ]);
    const consent = (id: string, consoleUserId: string) => ({
      agentId: "main",
      bindingId: binding,
      consoleUserId,
      contactId: "contact-member",
      expiresAt: new Date(Date.now() + 86_400_000),
      id,
      localInstallationId: otherInstallation,
      organizationId: orgId,
      provider: "google",
      tokenHash: randomBytes(16).toString("base64"),
    });
    await db.insert(schema.connectorConsentRequests).values([consent(consentForMember, member), consent(consentForOther, other)]);
  });

  afterAll(async () => {
    // The organization cascades to every connector row above.
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(inArray(schema.users.id, [member, other]));
  });

  test("suspends live personal rows, queues them once for revocation and ends consents, approvals and consent requests", async () => {
    const changes = await db.transaction((tx) =>
      revokeRemovedMemberConnectorAccess(tx, { organizationId: orgId, userId: member }),
    );
    expect(changes).toEqual({
      expiredApprovals: 2,
      expiredConsentRequests: 1,
      revokedAgentGrants: 3,
      suspendedConnections: 3,
      unmanagedOrganizationConnections: 1,
    });

    const rows = await db
      .select({
        id: schema.providerConnections.id,
        managedByUserId: schema.providerConnections.managedByUserId,
        status: schema.providerConnections.status,
      })
      .from(schema.providerConnections)
      .where(inArray(schema.providerConnections.id, Object.values(ids)));
    const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    expect(status[ids.active]).toBe("suspended");
    expect(status[ids.revokePending]).toBe("suspended");
    expect(status[ids.legacyProject]).toBe("suspended");
    expect(status[ids.history]).toBe("revoked_by_user");
    expect(status[ids.github]).toBe("active");
    expect(status[ids.othersAccount]).toBe("active");
    expect(status[ids.orgAccount]).toBe("active");
    expect(rows.find((row) => row.id === ids.orgAccount)?.managedByUserId).toBeNull();

    const outbox = await db
      .select({
        providerConnectionId: schema.connectorRevocationOutbox.providerConnectionId,
        reason: schema.connectorRevocationOutbox.reason,
        status: schema.connectorRevocationOutbox.status,
      })
      .from(schema.connectorRevocationOutbox)
      .where(eq(schema.connectorRevocationOutbox.organizationId, orgId));
    expect(outbox.map((row) => row.providerConnectionId).sort()).toEqual(
      [ids.active, ids.revokePending, ids.legacyProject].sort(),
    );
    expect(outbox.every((row) => row.reason === "member_removed" && row.status === "pending")).toBe(true);

    const grants = await db
      .select({ id: schema.agentConnectorGrants.id, status: schema.agentConnectorGrants.status })
      .from(schema.agentConnectorGrants)
      .where(eq(schema.agentConnectorGrants.organizationId, orgId));
    expect(Object.fromEntries(grants.map((row) => [row.id, row.status]))).toEqual({
      // "The person asking" consents they gave, with or without a connection picked.
      [grantByMember]: "revoked",
      [grantByMemberNoConnection]: "revoked",
      // Someone else's grant on an account of theirs that was just suspended.
      [grantByOtherOnMemberAccount]: "revoked",
      [grantByOther]: "active",
      // The shared grant they gave on the organization account stays with the account.
      [sharedGrantByMember]: "active",
    });

    const approvals = await db
      .select({ id: schema.connectorActionApprovals.id, status: schema.connectorActionApprovals.status })
      .from(schema.connectorActionApprovals)
      .where(eq(schema.connectorActionApprovals.organizationId, orgId));
    expect(Object.fromEntries(approvals.map((row) => [row.id, row.status]))).toEqual({
      [approvalApproved]: "approved",
      [approvalOwned]: "expired",
      [approvalRequested]: "expired",
      [approvalUnrelated]: "pending",
    });

    const consent = await db
      .select({ id: schema.connectorConsentRequests.id, status: schema.connectorConsentRequests.status })
      .from(schema.connectorConsentRequests)
      .where(eq(schema.connectorConsentRequests.organizationId, orgId));
    expect(Object.fromEntries(consent.map((row) => [row.id, row.status]))).toEqual({
      [consentForMember]: "expired",
      [consentForOther]: "pending",
    });
  });

  test("waits for a connect finish of that person that holds the member lock", async () => {
    const someone = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    // What the connectors Worker's `lockOrganizationMember` takes before it
    // checks the membership and stores an account.
    const finish = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('ravi-connectors:member'), hashtext(${`${orgId}:${someone}`}::text))`,
      );
      held();
      await gate;
    });
    await holding;
    let removed = false;
    const removal = db
      .transaction((tx) => revokeRemovedMemberConnectorAccess(tx, { organizationId: orgId, userId: someone }))
      .then((changes) => {
        removed = true;
        return changes;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(removed).toBe(false);
    release();
    await finish;
    expect((await removal).suspendedConnections).toBe(0);
    expect(removed).toBe(true);
  });

  test("a second removal queues nothing new", async () => {
    const changes = await db.transaction((tx) =>
      revokeRemovedMemberConnectorAccess(tx, { organizationId: orgId, userId: member }),
    );
    expect(changes).toMatchObject({ expiredApprovals: 0, revokedAgentGrants: 0, unmanagedOrganizationConnections: 0 });
    const outbox = await db
      .select({ id: schema.connectorRevocationOutbox.id })
      .from(schema.connectorRevocationOutbox)
      .where(eq(schema.connectorRevocationOutbox.organizationId, orgId));
    expect(outbox).toHaveLength(3);
  });
});
