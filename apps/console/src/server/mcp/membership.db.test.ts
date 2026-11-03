import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, dbClient, schema } from "@/server/db";
import { handleConsoleToolsCallRequest, loadActiveMember, CONSOLE_MCP_SCOPES } from "./console-tools";
import { OrganizationMembersService } from "../console/fleet/members";
import { fixturePolicy, installFixturePolicy } from "../../../tests/fleet/authorization-fixture";

const suite = process.env.BASES_TEST_DATABASE_URL ? describe : describe.skip;
const org = randomUUID(), steward = randomUUID(), user = randomUUID(), project = randomUUID(), bridge = randomUUID(), client = randomUUID();
const token = randomUUID(), otherToken = randomUUID(), key = randomUUID();
const scopes = [CONSOLE_MCP_SCOPES.read];
suite("human MCP credential lifecycle (real PG, no MCP Worker/provider)", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values({ id: org, name: "Credential fixture", slug: org });
    for (const id of [steward, user]) {
      await db.insert(schema.users).values({ id, primaryEmail: `${id}@example.invalid`, displayName: "Fixture" });
      await db.insert(schema.organizationMemberships).values({ organizationId: org, userId: id, role: "viewer", status: "active" });
      await db.insert(schema.authIdentities).values({ userId: id, provider: "oidc:https://fixture.invalid", providerUserId: id, email: `${id}@example.invalid` });
    }
    await db.insert(schema.projects).values({ id: project, organizationId: org, name: "Fixture", slug: project });
    await db.insert(schema.mcpBridges).values({ id: bridge, organizationId: org, projectId: project, sessionRef: "synthetic", channelId: "synthetic", name: "Fixture", bridgeTokenHash: randomUUID() });
    await db.insert(schema.mcpOAuthClients).values({ id: client, organizationId: org, projectId: project, bridgeId: bridge, clientId: randomUUID(), clientName: "Fixture" });
    for (const [id, subject] of [[token, user], [otherToken, steward]] as const) {
      await db.insert(schema.mcpOAuthTokens).values({ id, organizationId: org, projectId: project, bridgeId: bridge, oauthClientId: client, subjectUserId: subject,
        accessTokenHash: randomUUID(), refreshTokenHash: randomUUID(), accessTokenExpiresAt: new Date(Date.now()+60000), refreshTokenExpiresAt: new Date(Date.now()+120000), scopesJson: scopes });
    }
    await db.insert(schema.apiKeys).values({ id: key, organizationId: org, projectId: project, name: "Institutional ownership unknown", keyPrefix: "synthetic", keyHash: randomUUID(), createdByUserId: user });
    await installFixturePolicy(dbClient, steward, fixturePolicy(org, steward));
  });
  // Keep immutable receipts/audit in the owned, stopped fixture cluster; do not
  // defeat production RESTRICT constraints merely to delete a test subject.
  // The pool is shared with the other DB suites of the same process: never end it here.
  test("current token + current subject required, suspension scoped and reactivation cannot resurrect", async () => {
    const input = { organizationId: org, userId: user, bridgeId: bridge, tokenId: token, scopes };
    expect(await loadActiveMember(input)).not.toBeNull();
    for (const patch of [{ tokenId: null }, { tokenId: otherToken }, { userId: steward }, { scopes: [...scopes, CONSOLE_MCP_SCOPES.write] }]) {
      expect(await loadActiveMember({ ...input, ...patch })).toBeNull();
    }
    const members = new OrganizationMembersService(dbClient, org), actor = { mode: "oidc", role: "viewer", organizationId: org, userId: steward };
    const change = async (status: "active" | "suspended") => {
      const target = (await members.list(actor)).members.find(m => m.userId === user)!;
      return members.change(actor, { operationId: randomUUID(), userId: user, expectedVersion: target.version, status });
    };
    await change("suspended");
    expect(await loadActiveMember(input)).toBeNull();
    expect((await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, token)))[0]!.revokedAt).not.toBeNull();
    expect((await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, otherToken)))[0]!.revokedAt).toBeNull();
    expect((await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key)))[0]!.status).toBe("active");
    await change("active"); expect(await loadActiveMember(input)).toBeNull();
    // Actual signed internal call handler, real admission lookup; no operation
    // executes even though the human is active again and Worker HMAC is valid.
    const hmacConfig = { currentId: "fixture", currentKey: "synthetic-worker-key-only" };
    const path = "/api/internal/mcp/console/tools/call", body = JSON.stringify({ ...input, operationId: "ravi.bases.query", arguments: {} });
    const timestamp = Math.floor(Date.now()/1000).toString();
    const signature = createHmac("sha256", hmacConfig.currentKey).update([timestamp, "POST", path, createHash("sha256").update(body).digest("hex")].join("\n")).digest("base64");
    let operations = 0;
    const response = await handleConsoleToolsCallRequest(new Request(`https://console.example.invalid${path}`, { method: "POST", body,
      headers: { "x-ravi-hmac-timestamp": timestamp, "x-ravi-hmac-key-id": hmacConfig.currentId, "x-ravi-hmac-signature": signature } }),
      { hmacConfig, runOperation: async () => { operations++; throw new Error("must not execute"); } });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "mcp_access_revoked" }); expect(operations).toBe(0);
  });
});
