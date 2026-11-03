// Test doubles for the MCP Worker: a fake Postgres tagged template, fake rate
// limit Durable Objects and an env. Imported only by `*.test.ts` files.

import type { BridgeRecord, McpDb, OAuthAccessTokenRecord } from "./db";
import type { DurableObjectNamespace, McpWorkerEnv } from "./env";

export type FakeQuery = { query: string; values: unknown[] };
export type FakeHandler = { match: string; rows: unknown[] | ((values: unknown[]) => unknown[]) };

export function makeFakeDb(handlers: FakeHandler[]): McpDb & { queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    queries.push({ query, values });
    const handler = handlers.find((candidate) => query.includes(candidate.match));
    if (!handler) return Promise.resolve([]);
    return Promise.resolve(typeof handler.rows === "function" ? handler.rows(values) : handler.rows);
  }) as unknown as McpDb["sql"] & { json: (value: unknown) => unknown };
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value: unknown) => ({ json: value });
  return { sql, queries, async close() {} };
}

export function fakeRateLimitNamespace(allowed = true): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ allowed }), { status: allowed ? 200 : 429 }),
    }),
  };
}

export function makeEnv(overrides: Partial<McpWorkerEnv> = {}): McpWorkerEnv {
  return {
    RAVI_CONSOLE_DB: {
      connectionString: "postgres://fake",
      host: "fake",
      port: 5432,
      user: "fake",
      password: "fake",
      database: "fake",
    },
    RAVI_MCP_RATE_LIMIT_BRIDGE: fakeRateLimitNamespace(),
    RAVI_MCP_RATE_LIMIT_CLIENT: fakeRateLimitNamespace(),
    RAVI_MCP_WORKER_HMAC_KEY_CURRENT: "worker-hmac-secret",
    RAVI_MCP_WORKER_HMAC_KEY_CURRENT_ID: "worker-k1",
    RAVI_CONSOLE_BASE_URL: "https://console.ravi.bot",
    RAVI_MCP_BASE_URL: "https://mcp.ravi.so",
    RAVI_MCP_DEFAULT_BRIDGE_RATE_LIMIT_PER_MINUTE: "120",
    RAVI_MCP_DEFAULT_CLIENT_RATE_LIMIT_PER_HOUR: "600",
    ...overrides,
  };
}

export const BRIDGE_TOKEN = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst";

export function makeBridge(overrides: Partial<BridgeRecord> = {}): BridgeRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Default bridge",
    status: "active",
    allowedCapabilityClassesJson: ["read"],
    rateLimitOverridesJson: null,
    cachedToolsJson: null,
    expiresAt: null,
    ...overrides,
  };
}

export function makeAccessToken(overrides: Partial<OAuthAccessTokenRecord> = {}): OAuthAccessTokenRecord {
  return {
    id: "token-1",
    bridgeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    oauthClientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    subjectUserId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    scopesJson: ["mcp.console.tools.read", "mcp.console.tools.write"],
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    clientId: "mcp_client_1",
    clientName: "Claude",
    softwareId: null,
    softwareVersion: null,
    ...overrides,
  };
}
