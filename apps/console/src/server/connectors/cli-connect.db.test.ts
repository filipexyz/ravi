import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";

import type { CliAuthContext } from "@/server/cli/auth";
import { db, schema } from "@/server/db";

import { startCliConnect } from "./cli-connect";

// Runs only with CONNECTORS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database. The feature check reads the organization's plan
// and entitlements; the entitlement fixture is created and deleted here.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const orgId = randomUUID();
const disabledOrgId = randomUUID();
const suffix = randomUUID().slice(0, 8);

function cliAuth(role: string, organizationId = orgId): CliAuthContext {
  return {
    accessTokenJti: randomUUID(),
    cliSession: { expiresAt: new Date(Date.now() + 60_000), id: randomUUID(), lastUsedAt: null, status: "active" },
    localInstallation: {
      hostname: "laptop",
      id: randomUUID(),
      lastSeenAt: new Date(),
      name: "laptop",
      platform: "darwin",
      raviVersion: "test",
      status: "active",
    },
    membership: { id: randomUUID(), role, status: "active" },
    organization: { id: organizationId, name: "Connect test org", slug: `connect-${suffix}`, status: "active" },
    scopes: [],
    user: { avatarUrl: null, displayName: "Ana", id: randomUUID(), primaryEmail: "ana@example.test", status: "active" },
  };
}

const env = process.env;
const originalFetch = globalThis.fetch;
let calls: Array<{ path: string; body: Record<string, unknown> }> = [];

describeDb("POST /api/cli/connectors/connect/start rule", () => {
  beforeEach(() => {
    calls = [];
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
    env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        path: String(input).replace("https://link.example.test", ""),
      });
      return new Response(
        JSON.stringify({
          connectUrl: "https://console.example.test/connect/token",
          expiresAt: "2026-10-10T10:10:00.000Z",
          pendingGrantId: "66666666-6666-4666-8666-666666666666",
          requestId: "w",
        }),
        { status: 201 },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
    delete env.RAVI_CONNECTORS_LINK_URL;
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [disabledOrgId]));
  });

  test("a developer starts; the Worker gets the CLI session and installation, no project", async () => {
    const auth = cliAuth("developer");
    const result = await startCliConnect({
      auth,
      body: { accessMode: "read_only", projectId: randomUUID(), provider: "google" },
    });
    expect(result).toEqual({
      connectUrl: "https://console.example.test/connect/token",
      expiresAt: "2026-10-10T10:10:00.000Z",
      pendingGrantId: "66666666-6666-4666-8666-666666666666",
    });
    expect(calls).toEqual([
      {
        body: {
          accessMode: "read_only",
          cliSessionId: auth.cliSession.id,
          localInstallationId: auth.localInstallation.id,
          organizationId: orgId,
          origin: "cli",
          provider: "google",
          userId: auth.user.id,
        },
        path: "/ui/connect/start",
      },
    ]);
  });

  test("a role without connectors is refused before the Worker is called", async () => {
    const error = await startCliConnect({ auth: cliAuth("billing"), body: { provider: "google" } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "ORG_ACCESS_DENIED", status: 403 });
    expect(calls).toHaveLength(0);
  });

  test("an organization with connectors turned off is refused", async () => {
    await db.insert(schema.organizations).values({ id: disabledOrgId, name: "Off", slug: `connect-off-${suffix}` });
    await db
      .insert(schema.entitlements)
      .values({ key: "console.connectors", organizationId: disabledOrgId, source: "manual", valueJson: { enabled: false } });
    const error = await startCliConnect({ auth: cliAuth("owner", disabledOrgId), body: { provider: "google" } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "ORG_ACCESS_DENIED", status: 403 });
    expect(calls).toHaveLength(0);
  });
});
