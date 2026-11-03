import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { InstallationRequestError, listOwnInstallations, revokeLocalInstallation } from "./installations";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const ana = randomUUID();
const bea = randomUUID();
const admin = randomUUID();
const anaLaptop = randomUUID();
const beaDesktop = randomUUID();
const anaSession = randomUUID();
const anaOldSession = randomUUID();
const beaSession = randomUUID();
const binding = randomUUID();
const grant = randomUUID();
const consent = randomUUID();
const approval = randomUUID();
const anaAccount = randomUUID();
const requestId = `installations-test-${suffix}`;

function workspace(userId: string, role: "owner" | "admin" | "developer"): ConsoleWorkspace {
  return {
    membership: { role, status: "active" },
    mode: "workos",
    organization: { id: orgId },
    user: { id: userId },
  } as unknown as ConsoleWorkspace;
}

function session(id: string, localInstallationId: string, userId: string, status: "active" | "expired" = "active") {
  return {
    accessTokenJti: randomBytes(12).toString("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
    id,
    localInstallationId,
    organizationId: orgId,
    refreshTokenHash: randomBytes(16).toString("base64"),
    status,
    userId,
  };
}

function statusOf<T extends { id: string; status: string }>(rows: T[]) {
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describeDb("your computers", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, name: "Installations test", slug: `installations-${suffix}` });
    await db.insert(schema.users).values([
      { id: ana, primaryEmail: `ana-${suffix}@example.test` },
      { id: bea, primaryEmail: `bea-${suffix}@example.test` },
      { id: admin, primaryEmail: `admin-${suffix}@example.test` },
    ]);
    await db.insert(schema.localInstallations).values([
      { hostname: "ana-mbp", id: anaLaptop, name: "Ana's laptop", organizationId: orgId, userId: ana },
      { hostname: "bea-pc", id: beaDesktop, name: "Bea's desktop", organizationId: orgId, userId: bea },
    ]);
    await db.insert(schema.cliSessions).values([
      session(anaSession, anaLaptop, ana),
      session(anaOldSession, anaLaptop, ana, "expired"),
      session(beaSession, beaDesktop, bea),
    ]);
    await db.insert(schema.raviActorBindings).values({
      consoleUserId: bea,
      contactId: "contact-bea",
      id: binding,
      installationId: anaLaptop,
      linkedBy: ana,
      organizationId: orgId,
    });
    await db.insert(schema.providerConnections).values({
      displayName: "google",
      id: anaAccount,
      organizationId: orgId,
      provider: "google",
      scopeKind: "user",
      userId: ana,
    });
    await db.insert(schema.agentConnectorGrants).values({
      agentId: "main",
      grantedByUserId: bea,
      id: grant,
      localInstallationId: anaLaptop,
      mode: "person_asking",
      organizationId: orgId,
      provider: "google",
    });
    await db.insert(schema.connectorConsentRequests).values({
      agentId: "main",
      bindingId: binding,
      consoleUserId: bea,
      contactId: "contact-bea",
      expiresAt: new Date(Date.now() + 86_400_000),
      id: consent,
      localInstallationId: anaLaptop,
      organizationId: orgId,
      provider: "google",
      tokenHash: randomBytes(16).toString("base64"),
    });
    await db.insert(schema.connectorActionApprovals).values({
      capability: "gmail.message.send",
      capabilityClass: "write",
      expiresAt: new Date(Date.now() + 900_000),
      id: approval,
      localInstallationId: anaLaptop,
      organizationId: orgId,
      ownerUserId: ana,
      paramsHash: "h",
      providerConnectionId: anaAccount,
    });
  });

  afterAll(async () => {
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.requestId, requestId));
    // The organization cascades to installations, sessions and connector rows.
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(inArray(schema.users.id, [ana, bea, admin]));
  });

  test("lists only the person's own active installations", async () => {
    const rows = await listOwnInstallations(workspace(ana, "developer"));
    expect(rows.map((row) => ({ hostname: row.hostname, id: row.id, name: row.name }))).toEqual([
      { hostname: "ana-mbp", id: anaLaptop, name: "Ana's laptop" },
    ]);
  });

  test("someone else's installation doesn't exist for a member who isn't an admin", async () => {
    const error = await revokeLocalInstallation({
      installationId: beaDesktop,
      requestId,
      workspace: workspace(ana, "developer"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallationRequestError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
    const malformed = await revokeLocalInstallation({
      installationId: "nope",
      requestId,
      workspace: workspace(ana, "developer"),
    }).catch((caught: unknown) => caught);
    expect(malformed).toMatchObject({ code: "not_found", status: 404 });
  });

  test("the owner revokes: sessions signed out, grants ended, waiting requests expired, audited", async () => {
    expect(await revokeLocalInstallation({ installationId: anaLaptop, requestId, workspace: workspace(ana, "developer") })).toEqual(
      { alreadyRevoked: false, revoked: true },
    );

    const [installation] = await db
      .select({ revokedAt: schema.localInstallations.revokedAt, status: schema.localInstallations.status })
      .from(schema.localInstallations)
      .where(eq(schema.localInstallations.id, anaLaptop));
    expect(installation?.status).toBe("revoked");
    expect(installation?.revokedAt).toBeInstanceOf(Date);

    const sessions = await db
      .select({ id: schema.cliSessions.id, status: schema.cliSessions.status })
      .from(schema.cliSessions)
      .where(eq(schema.cliSessions.organizationId, orgId));
    expect(statusOf(sessions)).toEqual({ [anaOldSession]: "expired", [anaSession]: "revoked", [beaSession]: "active" });

    const [grantRow] = await db
      .select({ status: schema.agentConnectorGrants.status })
      .from(schema.agentConnectorGrants)
      .where(eq(schema.agentConnectorGrants.id, grant));
    expect(grantRow?.status).toBe("revoked");
    const [consentRow] = await db
      .select({ status: schema.connectorConsentRequests.status })
      .from(schema.connectorConsentRequests)
      .where(eq(schema.connectorConsentRequests.id, consent));
    expect(consentRow?.status).toBe("expired");
    const [approvalRow] = await db
      .select({ status: schema.connectorActionApprovals.status })
      .from(schema.connectorActionApprovals)
      .where(eq(schema.connectorActionApprovals.id, approval));
    expect(approvalRow?.status).toBe("expired");

    const audits = await db
      .select({ action: schema.auditEvents.action, metadata: schema.auditEvents.metadataJson, targetId: schema.auditEvents.targetId })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.requestId, requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "local_installation.revoked",
      metadata: { agentGrants: 1, by: "owner", cliSessions: 1, consentRequests: 1, pendingApprovals: 1 },
      targetId: anaLaptop,
    });

    expect(await listOwnInstallations(workspace(ana, "developer"))).toEqual([]);
  });

  test("revoking again changes nothing", async () => {
    expect(await revokeLocalInstallation({ installationId: anaLaptop, requestId, workspace: workspace(ana, "developer") })).toEqual(
      { alreadyRevoked: true, revoked: true },
    );
  });

  test("an organization admin can revoke someone else's installation", async () => {
    expect(await revokeLocalInstallation({ installationId: beaDesktop, requestId, workspace: workspace(admin, "admin") })).toEqual({
      alreadyRevoked: false,
      revoked: true,
    });
    const [beaRow] = await db
      .select({ status: schema.cliSessions.status })
      .from(schema.cliSessions)
      .where(eq(schema.cliSessions.id, beaSession));
    expect(beaRow?.status).toBe("revoked");
  });
});
