import { describe, expect, it, mock } from "bun:test";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { runWithContext } from "../cli/context.js";
import {
  BASES_READ_SCOPE,
  BASES_WRITE_SCOPE,
  RaviBasesClient,
  assertBasesIdempotencyKey,
  currentBasesClientHint,
  missingBasesScopes,
  newBasesIdempotencyKey,
  openBasesClient,
} from "./client.js";

const ROW = { rowId: "row_1", version: 2, values: { title: "Acme" } };

describe("RaviBasesClient transport", () => {
  it("sends row creates with an Idempotency-Key header, the same key in the body, and the client hint", async () => {
    const calls: FetchCall[] = [];
    const client = makeBasesClient(
      fetchReturning(calls, () => jsonResponse({ row: ROW, users: {}, idempotentReplay: false }, 201)),
      { clientHint: () => ({ agentId: "dev", sessionKey: "agent:dev:main", sdk: "ravi-cli" }) },
    );

    const result = await client.createRow("crm", { values: { title: "Acme" } });

    expect(result.idempotencyKey).toBe("ravi-cli:fixed-key-0001");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://console.example/api/cli/projects/sales/bases/crm/rows",
      method: "POST",
      headers: { "Idempotency-Key": "ravi-cli:fixed-key-0001", Authorization: "Bearer access-secret" },
      body: {
        values: { title: "Acme" },
        idempotencyKey: "ravi-cli:fixed-key-0001",
        clientHint: { agentId: "dev", sessionKey: "agent:dev:main", sdk: "ravi-cli" },
      },
    });
  });

  it("uses a caller idempotency key and validates its format", async () => {
    const calls: FetchCall[] = [];
    const client = makeBasesClient(
      fetchReturning(calls, () => jsonResponse({ row: ROW, users: {}, idempotentReplay: true })),
    );

    const result = await client.updateRow(
      "crm",
      "row_1",
      { values: { stage: "won" }, expectedVersion: 2 },
      { idempotencyKey: "retry-key-123" },
    );
    expect(result).toMatchObject({ idempotencyKey: "retry-key-123", response: { idempotentReplay: true } });
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: "https://console.example/api/cli/projects/sales/bases/crm/rows/row_1",
      headers: { "Idempotency-Key": "retry-key-123" },
      body: { values: { stage: "won" }, expectedVersion: 2, idempotencyKey: "retry-key-123" },
    });
    expect(calls[0]?.body).not.toHaveProperty("clientHint");

    await expect(client.createRow("crm", { values: {} }, { idempotencyKey: "bad key" })).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends batch creates under one key and purges with confirm only", async () => {
    const calls: FetchCall[] = [];
    const client = makeBasesClient(
      fetchReturning(calls, (call) =>
        call.url.endsWith("/purge")
          ? jsonResponse({ purged: true, rowId: "row_1" })
          : jsonResponse({ rows: [ROW], users: {}, idempotentReplay: false }),
      ),
      { clientHint: () => ({ agentId: "dev", sdk: "ravi-cli" }) },
    );

    await client.createRows("crm", [{ values: { title: "A" } }, { values: { title: "B" }, body: "# notes" }], {
      idempotencyKey: "ravi-import:abc:0",
    });
    await client.purgeRow("crm", "row_1");

    expect(calls[0]?.body).toEqual({
      rows: [{ values: { title: "A" } }, { values: { title: "B" }, body: "# notes" }],
      idempotencyKey: "ravi-import:abc:0",
      clientHint: { agentId: "dev", sdk: "ravi-cli" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://console.example/api/cli/projects/sales/bases/crm/rows/row_1/purge",
      body: { confirm: true },
    });
  });

  it("builds view, chart, history, and subscription paths under the project", async () => {
    const calls: FetchCall[] = [];
    const client = makeBasesClient(fetchReturning(calls, () => jsonResponse({})));

    await client.queryView("crm", "view 1", { limit: 10 });
    await client.rowHistory("crm", "row_1", { cursor: "c1", limit: 20 });
    await client.chartData("crm", "chart_1");
    await client.unsubscribe("crm", "sub_1");
    await client.listBases({ includeArchived: true });

    expect(calls.map((call) => `${call.method} ${call.url.replace("https://console.example", "")}`)).toEqual([
      "POST /api/cli/projects/sales/bases/crm/views/view%201/query",
      "GET /api/cli/projects/sales/bases/crm/rows/row_1/history?cursor=c1&limit=20",
      "POST /api/cli/projects/sales/bases/crm/charts/chart_1/data",
      "POST /api/cli/projects/sales/bases/crm/subscriptions/sub_1/revoke",
      "GET /api/cli/projects/sales/bases?includeArchived=1",
    ]);
  });

  it("refreshes expired credentials once and retries with the new token", async () => {
    const tokens: string[] = [];
    const written: CloudCredentials[] = [];
    const fake = {
      requestJson: mock(async (_method: string, _path: string, _body: unknown, token: string) => {
        tokens.push(token);
        if (token === "access-secret") throw new CloudAuthError("AUTH_EXPIRED", "expired", { status: 401 });
        return { bases: [] };
      }),
      refresh: mock(async () => ({ ...makeCredentials(), accessToken: "access-new" })),
    } as unknown as ConsoleApiClient;
    const client = new RaviBasesClient({
      client: fake,
      credentials: makeCredentials(),
      projectRef: "sales",
      write: (credentials) => written.push(credentials),
      delete: () => undefined,
      newIdempotencyKey: () => "ravi-cli:fixed-key-0001",
      clientHint: () => null,
    });

    await expect(client.listBases()).resolves.toEqual({ bases: [] });
    expect(tokens).toEqual(["access-secret", "access-new"]);
    expect(written.map((credentials) => credentials.accessToken)).toEqual(["access-new"]);
  });
});

describe("Console error mapping for Bases paths", () => {
  it("surfaces VERSION_CONFLICT with the current row and request id", async () => {
    const client = makeBasesClient(async () =>
      jsonResponse(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "Row changed since version 1.",
            requestId: "req_1",
            details: { error: "version_conflict", current: ROW },
          },
        },
        409,
      ),
    );

    const error = await captureError(() =>
      client.updateRow("crm", "row_1", { values: { title: "B" }, expectedVersion: 1 }),
    );
    expect(error).toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      requestId: "req_1",
      details: { error: "version_conflict", current: ROW },
    });
  });

  it("keeps CONFLICT and maps a bare 409 to CONFLICT outside the auth flow", async () => {
    const coded = makeBasesClient(async () =>
      jsonResponse({ error: { code: "CONFLICT", message: "Slug taken", details: { error: "slug_taken" } } }, 409),
    );
    expect(await captureError(() => coded.createBase({ name: "CRM" }))).toMatchObject({
      code: "CONFLICT",
      details: { error: "slug_taken" },
    });

    const bare = makeBasesClient(async () => jsonResponse({}, 409));
    expect(await captureError(() => bare.createBase({ name: "CRM" }))).toMatchObject({ code: "CONFLICT" });
  });

  it("maps NOT_FOUND and PROJECT_ACCESS_DENIED", async () => {
    const notFound = makeBasesClient(async () =>
      jsonResponse({ error: { code: "NOT_FOUND", message: "Base not found." } }, 404),
    );
    expect(await captureError(() => notFound.getBase("nope"))).toMatchObject({ code: "NOT_FOUND", status: 404 });

    const denied = makeBasesClient(async () =>
      jsonResponse({ error: { code: "PROJECT_ACCESS_DENIED", message: "No access." } }, 403),
    );
    expect(await captureError(() => denied.getBase("crm"))).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("keeps AUTH_PENDING for a bare 409 on the auth flow and link aliases on /api/cli/link", async () => {
    const pending = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => jsonResponse({}, 409),
    });
    expect(await captureError(() => pending.requestJson("POST", "/api/cli/auth/exchange", {}))).toMatchObject({
      code: "AUTH_PENDING",
    });

    const link = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => jsonResponse({ error: { code: "CONFLICT" } }, 409),
    });
    expect(await captureError(() => link.requestJson("POST", "/api/cli/link", {}))).toMatchObject({
      code: "ACTOR_BINDING_CONFLICT",
    });
    expect(await captureError(() => link.requestJson("POST", "/api/cli/projects/p/bases", {}))).toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("Bases client helpers", () => {
  it("reports missing Bases scopes only when the credentials record scopes", () => {
    expect(missingBasesScopes({ scopes: ["console.projects.read"] })).toEqual([BASES_READ_SCOPE, BASES_WRITE_SCOPE]);
    expect(missingBasesScopes({ scopes: [BASES_READ_SCOPE] })).toEqual([BASES_WRITE_SCOPE]);
    expect(missingBasesScopes({ scopes: [] })).toEqual([]);
    expect(missingBasesScopes(null)).toEqual([]);
  });

  it("generates valid idempotency keys and rejects malformed ones", () => {
    const key = newBasesIdempotencyKey();
    expect(assertBasesIdempotencyKey(key)).toBe(key);
    expect(newBasesIdempotencyKey()).not.toBe(key);
    expect(() => assertBasesIdempotencyKey("short")).toThrow(CloudAuthError);
    expect(() => assertBasesIdempotencyKey("-starts-with-dash")).toThrow(CloudAuthError);
  });

  it("derives the client hint only inside an agent runtime invocation", () => {
    const saved = { ...process.env };
    for (const key of ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"]) {
      delete process.env[key];
    }
    try {
      expect(currentBasesClientHint()).toBeNull();
      expect(runWithContext({ agentId: "dev" }, () => currentBasesClientHint())).toBeNull();
      expect(
        runWithContext({ transport: "tool", agentId: "dev", sessionKey: "agent:dev:main" }, () =>
          currentBasesClientHint(),
        ),
      ).toEqual({ agentId: "dev", sessionKey: "agent:dev:main", sdk: "ravi-cli" });
      expect(runWithContext({ transport: "gateway", sessionName: "dev-main" }, () => currentBasesClientHint())).toEqual(
        { sessionKey: "dev-main", sdk: "ravi-sdk-gateway" },
      );
    } finally {
      process.env = saved;
    }
  });

  it("requires stored credentials for the requested Console before resolving the project", async () => {
    await expect(openBasesClient({ project: "sales" }, { readCredentials: () => null })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(
      openBasesClient(
        { project: "sales", console: "https://other.example" },
        { readCredentials: () => makeCredentials() },
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const client = await openBasesClient(
      { project: "sales" },
      { readCredentials: () => makeCredentials(), getContext: () => undefined, env: {} },
    );
    expect(client.projectRef).toBe("sales");
    expect(client.consoleUrl).toBe("https://console.example");
  });
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fetchReturning(calls: FetchCall[], respond: (call: FetchCall) => Response) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
}

function makeBasesClient(
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof RaviBasesClient>[0]> = {},
): RaviBasesClient {
  return new RaviBasesClient({
    client: new ConsoleApiClient({ consoleUrl: "https://console.example", fetch: fetchImpl as typeof fetch }),
    credentials: makeCredentials(),
    projectRef: "sales",
    write: () => undefined,
    delete: () => undefined,
    newIdempotencyKey: () => "ravi-cli:fixed-key-0001",
    clientHint: () => null,
    ...overrides,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", BASES_READ_SCOPE, BASES_WRITE_SCOPE],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
