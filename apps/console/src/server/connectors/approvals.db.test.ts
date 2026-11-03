import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { findApprovalOwner } from "./approvals";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const owner = randomUUID();
const requester = randomUUID();
const connectionId = randomUUID();
const approvalId = randomUUID();
const managedConnectionId = randomUUID();
const unmanagedConnectionId = randomUUID();
const managedApprovalId = randomUUID();
const unmanagedApprovalId = randomUUID();

describeDb("findApprovalOwner", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, name: "Approvals test", slug: `approvals-${suffix}` });
    await db.insert(schema.users).values([
      { id: owner, primaryEmail: `approvals-owner-${suffix}@example.test` },
      { id: requester, primaryEmail: `approvals-requester-${suffix}@example.test` },
    ]);
    await db.insert(schema.providerConnections).values([
      {
        displayName: "google",
        id: connectionId,
        organizationId: orgId,
        provider: "google",
        scopeKind: "user",
        userId: owner,
      },
      {
        displayName: "support",
        id: managedConnectionId,
        managedByUserId: owner,
        organizationId: orgId,
        provider: "google",
        scopeKind: "organization",
      },
      {
        displayName: "sales",
        id: unmanagedConnectionId,
        organizationId: orgId,
        provider: "google",
        scopeKind: "organization",
      },
    ]);
    const approval = {
      capability: "gmail.message.send",
      capabilityClass: "write",
      expiresAt: new Date(Date.now() + 900_000),
      organizationId: orgId,
      ownerUserId: owner,
      paramsHash: "h",
      requestedByUserId: requester,
    };
    await db.insert(schema.connectorActionApprovals).values([
      { ...approval, id: approvalId, providerConnectionId: connectionId },
      { ...approval, id: managedApprovalId, providerConnectionId: managedConnectionId },
      { ...approval, id: unmanagedApprovalId, providerConnectionId: unmanagedConnectionId },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(schema.connectorActionApprovals)
      .where(inArray(schema.connectorActionApprovals.id, [approvalId, managedApprovalId, unmanagedApprovalId]));
    await db
      .delete(schema.providerConnections)
      .where(inArray(schema.providerConnections.id, [connectionId, managedConnectionId, unmanagedConnectionId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [owner, requester]));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  });

  test("finds the approval's organization and owner, not the requester", async () => {
    expect(await findApprovalOwner(approvalId)).toEqual({
      id: approvalId,
      organizationId: orgId,
      ownerUserId: owner,
      unmanaged: false,
    });
  });

  test("says when the approval is on an organization account nobody manages", async () => {
    expect(await findApprovalOwner(unmanagedApprovalId)).toMatchObject({ ownerUserId: owner, unmanaged: true });
    expect(await findApprovalOwner(managedApprovalId)).toMatchObject({ ownerUserId: owner, unmanaged: false });
  });

  test("an unknown id finds nothing", async () => {
    expect(await findApprovalOwner(randomUUID())).toBeNull();
  });
});
