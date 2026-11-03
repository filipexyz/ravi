import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { connectTokenHash, findConnectGrantOwner } from "./connect-grants";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const userId = randomUUID();
const pendingId = randomUUID();
const connectToken = randomBytes(32).toString("base64url");

describeDb("findConnectGrantOwner", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: orgId, name: "Connect grants test", slug: `connect-grants-${suffix}` });
    await db.insert(schema.users).values({ id: userId, primaryEmail: `connect-grants-${suffix}@example.test` });
    await db.insert(schema.connectorGrantsPending).values({
      connectTokenHash: connectTokenHash(connectToken),
      expiresAt: new Date(Date.now() + 600_000),
      id: pendingId,
      organizationId: orgId,
      origin: "cli",
      provider: "google",
      stateTokenHash: `placeholder:${randomBytes(16).toString("base64url")}`,
      userId,
    });
  });

  afterAll(async () => {
    await db.delete(schema.connectorGrantsPending).where(eq(schema.connectorGrantsPending.id, pendingId));
    await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId]));
  });

  test("finds the grant's id, organization and initiator by connect token", async () => {
    expect(await findConnectGrantOwner({ connectToken })).toEqual({ id: pendingId, organizationId: orgId, userId });
  });

  test("finds them by pending id", async () => {
    expect(await findConnectGrantOwner({ pendingId })).toEqual({ id: pendingId, organizationId: orgId, userId });
  });

  test("an unknown token or id finds nothing", async () => {
    expect(await findConnectGrantOwner({ connectToken: randomBytes(32).toString("base64url") })).toBeNull();
    expect(await findConnectGrantOwner({ pendingId: randomUUID() })).toBeNull();
  });
});
