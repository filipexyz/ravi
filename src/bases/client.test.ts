import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { TurnRefusalError } from "../cloud-auth/turn-refusal.js";
import { runWithContext } from "../cli/context.js";
import { createContact } from "../contacts.js";
import { getOrCreateSession } from "../router/sessions.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
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

describe("Bases reads in a delegated turn", () => {
  // Console decides read or write by route; the CLI names the person of the turn on every
  // call, reads included, so a linked person's reads act as that person.
  it("sends the turn's contact on GET and POST reads, and on writes", async () => {
    const calls: FetchCall[] = [];
    const respond = fetchReturning(calls, () =>
      jsonResponse({ columns: [], rows: [], nextCursor: null, users: {}, row: ROW, idempotentReplay: false }),
    );
    const client = makeBasesClient(respond, {
      client: new ConsoleApiClient({
        consoleUrl: "https://console.example",
        fetch: respond as typeof fetch,
        actorContact: () => "c_ana",
      }),
    });

    await client.getBase("crm");
    await client.listViews("crm");
    await client.queryView("crm", "view_1", {});
    await client.queryRows("crm", {});
    await client.chartData("crm", "chart_1");
    await client.getViewRow("crm", "view_1", "row_1");
    await client.updateViewRow("crm", "view_1", "row_1", { values: { ok: "pending" }, expectedVersion: 2 });

    expect(calls).toHaveLength(7);
    for (const call of calls) expect(call.headers["x-ravi-actor-contact"]).toBe("c_ana");
  });

  it("refuses a turn Ravi cannot attribute before any Console call, reads included", async () => {
    let consoleCalls = 0;
    const client = {
      requestJson: async () => {
        consoleCalls += 1;
        return {};
      },
    } as unknown as ConsoleApiClient;
    await expect(
      openBasesClient(
        { project: "sales" },
        { client, readCredentials: () => makeCredentials(), unattributedTurn: () => true, env: {} },
      ),
    ).rejects.toMatchObject({ code: "ACTOR_UNKNOWN", reason: { kind: "unknown" } });
    expect(consoleCalls).toBe(0);

    const routine = openBasesClient(
      { project: "sales" },
      {
        client,
        readCredentials: () => makeCredentials(),
        unattributedTurn: () => ({
          reason: {
            kind: "routine_not_operator_owned",
            routine: "cron",
            jobId: "job_1",
            ownerPrincipal: "contact:c_ana",
          },
          actorPrincipal: "automation:cron:job_1",
        }),
        env: {},
      },
    );
    await expect(routine).rejects.toBeInstanceOf(TurnRefusalError);
    await expect(routine).rejects.toMatchObject({
      code: "ACTOR_UNKNOWN",
      exitCode: 3,
      details: { refusalReason: "routine_not_operator_owned", jobId: "job_1", ownerPrincipal: "contact:c_ana" },
    });
    expect(consoleCalls).toBe(0);

    const attributed = await openBasesClient(
      { project: "sales" },
      {
        client,
        readCredentials: () => makeCredentials(),
        unattributedTurn: () => false,
        getContext: () => undefined,
        env: {},
      },
    );
    expect(attributed.projectRef).toBe("sales");
  });

  it("sends no contact outside a delegated turn", async () => {
    const calls: FetchCall[] = [];
    const respond = fetchReturning(calls, () => jsonResponse({ columns: [], rows: [], nextCursor: null, users: {} }));
    const client = makeBasesClient(respond, {
      client: new ConsoleApiClient({
        consoleUrl: "https://console.example",
        fetch: respond as typeof fetch,
        actorContact: () => null,
      }),
    });

    await client.queryView("crm", "view_1", {});
    expect(calls[0]?.headers["x-ravi-actor-contact"]).toBeUndefined();
  });
});

describe("Bases in a turn a trigger fired", () => {
  // The default wiring, with the daemon's own record of the turn: who owns
  // the trigger decides who the call acts as, and nothing is sent for a
  // trigger nobody owns or one that answers into someone else's chat.
  let stateDir: string | null = null;
  let previousContextKey: string | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-bases-trigger-turn-");
    previousContextKey = process.env.RAVI_CONTEXT_KEY;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
    else process.env.RAVI_CONTEXT_KEY = previousContextKey;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  /** The session the trigger's runner created for it, where its fires run. */
  const OWN_SESSION = "agent:main:trigger:trg_1:own";

  function enterTriggerTurn(
    ownerPrincipal?: string,
    ownerIsOperator = false,
    turnReplyTarget: Record<string, unknown> = { kind: "none" },
    session: { runsIn?: string; sentTo?: string | null } = {},
  ): void {
    const ownSessionKey = session.sentTo === undefined ? OWN_SESSION : session.sentTo;
    const sessionKey = session.runsIn ?? OWN_SESSION;
    // A turn runs in a session that exists; the trigger's own was created by its runner.
    getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp", undefined, { triggerRunner: true });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionKey,
      sessionName: "requests-queue",
      metadata: {
        actorResolution: "resolved",
        executorAgentId: "main",
        actorPrincipal: "automation:trigger:trg_1",
        agentIdentityCompartment: "automation:trigger:trg_1",
        turnReplyTarget,
        ...(ownerPrincipal
          ? { triggerRunAuthority: { triggerId: "trg_1", ownerPrincipal, ownerIsOperator, ownSessionKey } }
          : {}),
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
  }

  /** Every Console call goes through the process's own fetch: no client is injected. */
  function captureConsoleCalls(): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = fetchReturning(calls, () =>
      jsonResponse({ columns: [], rows: [], nextCursor: null, users: {} }),
    ) as typeof fetch;
    return calls;
  }

  async function queryAsTheTurn(): Promise<void> {
    const client = await openBasesClient(
      { project: "sales" },
      { readCredentials: () => makeCredentials(), getContext: () => undefined },
    );
    await client.queryView("crm", "view_1", {});
  }

  it("acts as the operator for a trigger the operator owns, naming no contact", async () => {
    const calls = captureConsoleCalls();
    enterTriggerTurn("operator", true);
    await queryAsTheTurn();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-ravi-actor-contact"]).toBeUndefined();
  });

  it("acts for the contact who owns the trigger", async () => {
    const calls = captureConsoleCalls();
    const contact = createContact({ phone: "5511888888888", name: "Ana", status: "allowed", source: "manual" });
    enterTriggerTurn(`contact:${contact.id}`);
    await queryAsTheTurn();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-ravi-actor-contact"]).toBe(contact.id);
  });

  it("names the same actor on the project lookup as on the Bases calls", async () => {
    const calls = captureConsoleCalls();
    const contact = createContact({ phone: "5511888888888", name: "Ana", status: "allowed", source: "manual" });
    enterTriggerTurn(`contact:${contact.id}`);
    let lookupClient: ConsoleApiClient | undefined;

    // No project given: the lookup lists the projects with the client Bases built.
    const client = await openBasesClient(
      {},
      {
        readCredentials: () => makeCredentials(),
        getContext: () => undefined,
        // The saved-scope store lives in the isolated state directory.
        env: { RAVI_STATE_DIR: process.env.RAVI_STATE_DIR },
        cwd: stateDir ?? undefined,
        listProjects: async (_options, deps) => {
          lookupClient = deps?.client;
          await deps?.client?.requestJson("GET", "/api/cli/projects", undefined, "access-secret");
          const project = { id: "prj_1", slug: "sales", name: "Sales" };
          return {
            success: true,
            consoleUrl: "https://console.example",
            total: 1,
            projects: [project],
            items: [project],
          } as never;
        },
      },
    );
    await client.queryView("crm", "view_1", {});

    expect(lookupClient).toBeInstanceOf(ConsoleApiClient);
    expect(client.projectRef).toBe("sales");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/cli/projects",
      "/api/cli/projects/sales/bases/crm/views/view_1/query",
    ]);
    for (const call of calls) expect(call.headers["x-ravi-actor-contact"]).toBe(contact.id);
  });

  it("refuses a trigger nobody owns before any Console call", async () => {
    const calls = captureConsoleCalls();
    for (const enter of [() => enterTriggerTurn("unknown"), () => enterTriggerTurn("agent:helper")]) {
      enter();
      const error = await captureError(queryAsTheTurn);
      expect(error).toBeInstanceOf(TurnRefusalError);
      expect(error).toMatchObject({
        code: "ACTOR_UNKNOWN",
        exitCode: 3,
        details: { refusalReason: "routine_not_operator_owned", routine: "trigger", jobId: "trg_1" },
      });
      expect((error as TurnRefusalError).message).toContain("trigger trg_1");
      expect((error as TurnRefusalError).suggestedAction).toContain("create it again");
    }
    // No snapshot at all (a turn fired before owners were carried): refused as unknown.
    enterTriggerTurn();
    expect(await captureError(queryAsTheTurn)).toMatchObject({
      code: "ACTOR_UNKNOWN",
      details: { refusalReason: "unknown" },
    });
    expect(calls).toEqual([]);
  });

  it("refuses an owned trigger outside a session of its own, before any Console call", async () => {
    const calls = captureConsoleCalls();
    const chatSession = "agent:main:whatsapp:wa-main:dm:5511888888888";
    for (const enter of [
      // Fired into the agent's main session, or into a chat's.
      () => enterTriggerTurn("operator", true, { kind: "none" }, { runsIn: "agent:main:main", sentTo: null }),
      () => enterTriggerTurn("operator", true, { kind: "none" }, { runsIn: chatSession, sentTo: null }),
      // Sent to the trigger's own session, but the turn runs in another one.
      () => enterTriggerTurn("operator", true, { kind: "none" }, { runsIn: chatSession }),
    ]) {
      enter();
      const error = await captureError(queryAsTheTurn);
      expect(error).toBeInstanceOf(TurnRefusalError);
      expect(error).toMatchObject({
        code: "ACTOR_UNKNOWN",
        exitCode: 3,
        details: { refusalReason: "routine_shared_session", routine: "trigger", jobId: "trg_1" },
      });
      expect((error as TurnRefusalError).message).toContain("a session the trigger does not own");
      expect((error as TurnRefusalError).suggestedAction).toContain("ravi triggers set trg_1 session isolated");
    }
    expect(calls).toEqual([]);
  });

  it("refuses an owned trigger whose answer goes to someone else's chat, before any Console call", async () => {
    const calls = captureConsoleCalls();
    const intoGroup = { kind: "chat", channel: "whatsapp", chatId: "120363000000000000@g.us" };
    enterTriggerTurn("operator", true, intoGroup);

    const error = await captureError(queryAsTheTurn);
    expect(error).toBeInstanceOf(TurnRefusalError);
    expect(error).toMatchObject({
      code: "ACTOR_UNKNOWN",
      exitCode: 3,
      details: { refusalReason: "routine_answers_elsewhere", routine: "trigger", jobId: "trg_1" },
    });
    expect((error as TurnRefusalError).suggestedAction).toContain("ravi triggers show trg_1");
    expect(calls).toEqual([]);
  });
});

describe("Bases H2 transport", () => {
  it("posts filtered subscriptions, agent fills and reruns, and lists the project's Pages sites", async () => {
    const calls: FetchCall[] = [];
    const client = makeBasesClient(
      fetchReturning(calls, (call) =>
        call.url.endsWith("/pages")
          ? jsonResponse([{ site: { id: "site_1", slug: "acme", defaultHostname: "acme.ravi.page", isDefault: true } }])
          : jsonResponse({ row: ROW, users: {}, idempotentReplay: false }),
      ),
      { clientHint: () => ({ agentId: "dev", sdk: "ravi-cli" }) },
    );

    await client.subscribe("crm", { events: ["agent.requested"] });
    await client.fillAgentCell("crm", "row_1", "resumo", { inputsHash: "0123456789abcdef", value: "ok" });
    await client.rerunAgentCell("crm", "row_1", "resumo");
    const sites = await client.listPagesSites();
    await client.createView("crm", { name: "Fila" }, { idempotencyKey: "crm:view:fila" });

    expect(calls.map((call) => `${call.method} ${call.url.replace("https://console.example", "")}`)).toEqual([
      "POST /api/cli/projects/sales/bases/crm/subscriptions",
      "POST /api/cli/projects/sales/bases/crm/rows/row_1/agent/resumo",
      "POST /api/cli/projects/sales/bases/crm/rows/row_1/agent/resumo/rerun",
      "GET /api/cli/projects/sales/pages",
      "POST /api/cli/projects/sales/bases/crm/views",
    ]);
    expect(calls[0]?.body).toEqual({ events: ["agent.requested"] });
    expect(calls[1]).toMatchObject({
      headers: { "Idempotency-Key": "ravi-cli:fixed-key-0001" },
      body: {
        inputsHash: "0123456789abcdef",
        value: "ok",
        idempotencyKey: "ravi-cli:fixed-key-0001",
        clientHint: { agentId: "dev", sdk: "ravi-cli" },
      },
    });
    expect(calls[2]?.body).toEqual({ clientHint: { agentId: "dev", sdk: "ravi-cli" } });
    expect(sites).toEqual([{ id: "site_1", slug: "acme", hostname: "acme.ravi.page", isDefault: true }]);
    // Schema creates carry the key but not the ledger hint.
    expect(calls[4]).toMatchObject({
      headers: { "Idempotency-Key": "crm:view:fila" },
      body: { name: "Fila", idempotencyKey: "crm:view:fila" },
    });
    expect(calls[4]?.body).not.toHaveProperty("clientHint");
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
