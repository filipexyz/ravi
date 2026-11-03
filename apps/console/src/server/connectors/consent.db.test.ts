import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { connectTokenHash } from "./connect-grants";
import { findConsentRequestOwner } from "./consent";
import { listOrganizationInstallations } from "./installations";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const operator = randomUUID();
const speaker = randomUUID();
const former = randomUUID();
const suspended = randomUUID();
const laptop = randomUUID();
const revokedLaptop = randomUUID();
const otherOrgLaptop = randomUUID();
const formerLaptop = randomUUID();
const suspendedLaptop = randomUUID();
const binding = randomUUID();
const consentId = randomUUID();
const token = randomBytes(32).toString("base64url");

function workspace(role: "owner" | "admin" | "developer", status: "active" | "suspended" = "active"): ConsoleWorkspace {
  return {
    membership: { role, status },
    mode: "workos",
    organization: { id: orgId },
    user: { id: operator },
  } as unknown as ConsoleWorkspace;
}

describeDb("consent requests and organization computers", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: orgId, name: "Consent test", slug: `consent-${suffix}` },
      { id: otherOrgId, name: "Consent other", slug: `consent-other-${suffix}` },
    ]);
    await db.insert(schema.users).values([
      { displayName: "Olga Operator", id: operator, primaryEmail: `consent-operator-${suffix}@example.test` },
      { id: speaker, primaryEmail: `consent-speaker-${suffix}@example.test` },
      { displayName: "Former Member", id: former, primaryEmail: `consent-former-${suffix}@example.test` },
      { displayName: "Suspended Member", id: suspended, primaryEmail: `consent-suspended-${suffix}@example.test` },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, role: "admin", userId: operator },
      { organizationId: orgId, userId: speaker },
      { organizationId: orgId, status: "removed", userId: former },
      { organizationId: orgId, status: "suspended", userId: suspended },
      { organizationId: otherOrgId, userId: speaker },
    ]);
    await db.insert(schema.localInstallations).values([
      { hostname: "olga-mbp", id: laptop, name: "olga-mbp", organizationId: orgId, userId: operator },
      { id: revokedLaptop, name: "old-box", organizationId: orgId, status: "revoked", userId: operator },
      { id: otherOrgLaptop, name: "elsewhere", organizationId: otherOrgId, userId: speaker },
      // Still active: removing or suspending a member leaves their computers as they were.
      { id: formerLaptop, name: "old-laptop", organizationId: orgId, userId: former },
      { id: suspendedLaptop, name: "paused-laptop", organizationId: orgId, userId: suspended },
    ]);
    await db.insert(schema.raviActorBindings).values({
      consoleUserId: speaker,
      contactId: "contact-speaker",
      id: binding,
      installationId: laptop,
      linkedBy: operator,
      organizationId: orgId,
    });
    await db.insert(schema.connectorConsentRequests).values({
      agentId: "support",
      bindingId: binding,
      consoleUserId: speaker,
      contactId: "contact-speaker",
      expiresAt: new Date(Date.now() + 86_400_000),
      id: consentId,
      localInstallationId: laptop,
      organizationId: orgId,
      provider: "google",
      requestedByUserId: operator,
      tokenHash: connectTokenHash(token),
    });
  });

  afterAll(async () => {
    // The organizations cascade to installations, bindings and consent requests.
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId, otherOrgId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [operator, speaker, former, suspended]));
  });

  test("a consent token finds its organization and the person it was made for, not the operator", async () => {
    expect(await findConsentRequestOwner(token)).toEqual({ consoleUserId: speaker, organizationId: orgId });
  });

  test("an unknown token finds nothing", async () => {
    expect(await findConsentRequestOwner(randomBytes(32).toString("base64url"))).toBeNull();
  });

  test("owners and admins list the active computers of active members with whose they are; anyone else none", async () => {
    for (const role of ["owner", "admin"] as const) {
      const rows = await listOrganizationInstallations(workspace(role));
      expect(rows.map((row) => ({ id: row.id, name: row.name, owner: row.owner }))).toEqual([
        {
          id: laptop,
          name: "olga-mbp",
          owner: { email: `consent-operator-${suffix}@example.test`, name: "Olga Operator", userId: operator },
        },
      ]);
      expect(typeof rows[0]?.lastSeenAt).toBe("string");
    }
    expect(await listOrganizationInstallations(workspace("developer"))).toEqual([]);
    expect(await listOrganizationInstallations(workspace("admin", "suspended"))).toEqual([]);
  });

  test("a member the Worker said manages an organization account lists the same computers; suspended, none", async () => {
    const rows = await listOrganizationInstallations(workspace("developer"), { managesAnAccount: true });
    expect(rows.map((row) => row.id)).toEqual([laptop]);
    expect(await listOrganizationInstallations(workspace("developer", "suspended"), { managesAnAccount: true })).toEqual([]);
  });

  test("the consent request is still pending: reading changes nothing", async () => {
    const [row] = await db
      .select({ status: schema.connectorConsentRequests.status })
      .from(schema.connectorConsentRequests)
      .where(eq(schema.connectorConsentRequests.id, consentId));
    expect(row?.status).toBe("pending");
  });
});
