import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runWithContext, type ToolContext } from "../cli/context.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { mergeClaudeMcpServers } from "../runtime/claude-provider.js";
import { ADMIN_BOOTSTRAP_KIND } from "../runtime/context-registry.js";
import type { RuntimeCrashRecoveryCoordinator } from "../runtime/crash-recovery.js";
import { buildRuntimeHostAttachments, HOST_MCP_SERVER_NAMES } from "../runtime/runtime-host-attachments.js";
import {
  DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
  isForwardedMcpToolName,
  resolveToolInactivityTimeoutMs,
} from "../runtime/tool-liveness.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "../runtime/types.js";
import {
  recordAdapterRequestTrace,
  recordRuntimeMcpNameOverlap,
  recordRuntimeMcpServersReport,
} from "../session-trace/runtime-trace.js";
import { getSessionTraceBlob, listRecentSessionEventsByType } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildGatewayMcpServers,
  type ClaudeFacadeServerConfig,
  createClaudeGatewayFacades,
  facadeCallResult,
  facadeToolEntry,
  MCP_FACADE_CALL_BUDGET_MS,
} from "./claude-facade.js";
import { McpGateway, withMcpRaviNote } from "./gateway.js";
import { attachMcpServer, createMcpServer, setMcpConfigChangedEmitterForTests } from "./registry-db.js";
import { recordMcpServerProbe } from "./registry-db.js";
import { writeMcpServerSecret } from "./secrets.js";
import { type HttpFixture, startHttpFixture } from "./test-fixtures/servers.js";
import { type McpCallTraceInput, setMcpTraceSinksForTests } from "./trace.js";

const AGENT = "main";

let stateDir: string | null = null;
let fixture: HttpFixture | null = null;
let gateway: McpGateway | null = null;
let calls: McpCallTraceInput[] = [];
let clients: Client[] = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-facade-");
  setMcpConfigChangedEmitterForTests(() => {});
  setPermissionAuditPublisherForTest(() => {});
  calls = [];
  setMcpTraceSinksForTests({ call: (input) => calls.push(input), catalog: () => {} });
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  clients = [];
  await gateway?.stop();
  gateway = null;
  await fixture?.close();
  fixture = null;
  setMcpTraceSinksForTests({ call: null, catalog: null });
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const toolGrant = (objectId: string): ContextCapability => ({ permission: "use", objectType: "tool", objectId });

function context(metadata: Record<string, unknown>, extra: Partial<ContextRecord> = {}): ContextRecord {
  return {
    contextId: `ctx_${Math.random().toString(36).slice(2)}`,
    contextKey: "rctx_test",
    kind: "agent-runtime",
    agentId: AGENT,
    sessionKey: "agent:main:main",
    sessionName: "main-session",
    capabilities: [],
    metadata,
    createdAt: Date.now(),
    ...extra,
  };
}

/** The operator's own turn (the terminal's admin bootstrap root). */
function operatorTurn(capabilities: ContextCapability[] = []): ContextRecord {
  return context(
    {},
    {
      kind: ADMIN_BOOTSTRAP_KIND,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }, ...capabilities],
    },
  );
}

/** A resolved contact who is not the operator. */
function contactTurn(capabilities: ContextCapability[]): ContextRecord {
  return context(
    {
      actorPrincipal: "contact:c_friend",
      actorResolution: "resolved",
      agentIdentityCompartment: "dm:chat_friend",
    },
    { capabilities },
  );
}

/** A registered server with a cached catalog and no network behind it. */
function registerCached(name: string, audience: "operator" | "any", tools: string[]) {
  createMcpServer({ name, transport: "http", url: `https://${name}.example.com/mcp`, authKind: "none" });
  attachMcpServer({ agentId: AGENT, server: name, audience });
  recordMcpServerProbe(name, {
    status: "ok",
    era: "modern",
    catalog: {
      tools: tools.map((tool) => ({
        name: tool,
        exposedName: `mcp__${name}__${tool}`,
        description: `Tool ${tool}`,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      })),
      dropped: [],
    },
  });
}

async function connect(config: ClaudeFacadeServerConfig): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: "claude-code-test", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

function newGateway(): McpGateway {
  gateway = new McpGateway({ subscribe: false, refreshTickMs: 0, closeGraceMs: 200 });
  return gateway;
}

describe("Claude facade servers", () => {
  it("serves the cached catalog under the registered name and forwards calls to the gateway", async () => {
    fixture = startHttpFixture({ badToolNames: ["bad.name"] });
    createMcpServer({ name: "fixture", transport: "http", url: fixture.url, authKind: "none" });
    await writeMcpServerSecret("fixture", { url: fixture.url });
    attachMcpServer({ agentId: AGENT, server: "fixture", audience: "any" });
    const gw = newGateway();
    const refreshed = await gw.refresh("fixture");
    expect(refreshed?.status).toBe("ok");
    const methodsAfterRefresh = fixture.methods.length;

    const turn = operatorTurn();
    const built = buildGatewayMcpServers({ agentId: AGENT, getContext: () => turn, getGateway: () => gw });
    // Building and listing read the cache only: no request reached the server.
    expect(Object.keys(built.servers)).toEqual(["fixture"]);
    expect(built.servers.fixture).toMatchObject({
      type: "sdk",
      name: "fixture",
      timeout: MCP_FACADE_CALL_BUDGET_MS + 30_000,
    });
    expect(built.detail).toEqual([
      { name: "fixture", kind: "gateway", transport: "http", era: "modern", toolCount: 8, status: "ok" },
    ]);

    const client = await connect(built.servers.fixture!);
    const listed = await client.listTools();
    expect(fixture.methods.length).toBe(methodsAfterRefresh);
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(["big", "deploy", "echo", "env", "fail", "mixed", "slow", "slow_deploy"]);
    // Claude Code prefixes each with the server name: exactly the name every runtime is granted.
    const exposed = refreshed!.catalog!.tools.map((tool) => tool.exposedName);
    expect(names.map((name) => `mcp__fixture__${name}`)).toEqual(exposed);
    expect(names).not.toContain("bad.name");
    // Annotations and titles never reach the runtime.
    expect(listed.tools.find((tool) => tool.name === "echo")?.annotations).toBeUndefined();

    const echo = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(echo.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(echo.structuredContent).toEqual({ echoed: "hi" });
    expect(echo.isError).toBeFalsy();
    expect(echo._meta).toBeUndefined();

    const failed = await client.callTool({ name: "fail", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "it broke" }]);

    expect(calls.map((call) => [call.tool, call.surface, call.outcome])).toEqual([
      ["echo", "claude", "ok"],
      ["fail", "claude", "tool_error"],
    ]);
  });

  it("leaves out an operator-audience server on a contact turn and denies its call when the turn changes", async () => {
    registerCached("ops", "operator", ["search"]);
    registerCached("open", "any", ["search"]);
    const grants = [toolGrant("mcp__ops__*"), toolGrant("mcp__open__*")];

    const onContact = buildGatewayMcpServers({ agentId: AGENT, getContext: () => contactTurn(grants) });
    expect(Object.keys(onContact.servers)).toEqual(["open"]);

    let turn: ContextRecord = operatorTurn(grants);
    const gw = newGateway();
    const built = buildGatewayMcpServers({ agentId: AGENT, getContext: () => turn, getGateway: () => gw });
    expect(Object.keys(built.servers)).toEqual(["open", "ops"]);
    const client = await connect(built.servers.ops!);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["search"]);

    // The next turn is someone else's: the listing empties and the call is refused before any network call.
    turn = contactTurn(grants);
    expect((await client.listTools()).tools).toEqual([]);
    const denied = await client.callTool({ name: "search", arguments: { text: "x" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("operator's own turns only");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ server: "ops", tool: "search", surface: "claude", outcome: "denied", era: null });
  });

  it("lists only the granted tools and builds no facade without a granted tool", () => {
    registerCached("tools", "any", ["read", "write"]);
    const partial = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => contactTurn([toolGrant("mcp__tools__read")]),
    });
    expect(partial.detail[0]?.toolCount).toBe(1);

    const none = buildGatewayMcpServers({ agentId: AGENT, getContext: () => contactTurn([toolGrant("Read")]) });
    expect(none.servers).toEqual({});
    const noTurn = buildGatewayMcpServers({ agentId: AGENT, getContext: () => undefined });
    expect(noTurn.servers).toEqual({});
  });

  it("answers with an error when the gateway is not running, and fails closed when it throws", async () => {
    registerCached("open", "any", ["search"]);
    const turn = operatorTurn();
    const absent = buildGatewayMcpServers({ agentId: AGENT, getContext: () => turn, getGateway: () => null });
    const first = await (await connect(absent.servers.open!)).callTool({ name: "search", arguments: {} });
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first.content)).toContain("gateway is not running");

    const throwing = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => turn,
      getGateway: () => ({
        call: async () => {
          throw new Error("secret-ish detail 0123456789abcdef");
        },
      }),
    });
    const second = await (await connect(throwing.servers.open!)).callTool({ name: "search", arguments: {} });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).not.toContain("secret-ish");
  });

  it("passes the 240 s budget and the request's abort signal to the gateway", async () => {
    registerCached("open", "any", ["search"]);
    const seen: Array<{ budgetMs?: number; signal?: AbortSignal; surface: string }> = [];
    const built = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => operatorTurn(),
      getGateway: () => ({
        call: async (_scope, input) => {
          seen.push({ budgetMs: input.budgetMs, signal: input.signal, surface: input.surface });
          return { ok: false, outcome: "timeout", reason: "The MCP call did not finish within 240 s." };
        },
      }),
    });
    const result = await (await connect(built.servers.open!)).callTool({ name: "search", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("did not finish within 240 s");
    expect(seen[0]?.budgetMs).toBe(240_000);
    expect(seen[0]?.surface).toBe("claude");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for a detachable call and hands the model the background handle as a normal result", async () => {
    registerCached("open", "any", ["search"]);
    const seen: Array<boolean | undefined> = [];
    const built = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => operatorTurn(),
      getGateway: () => ({
        call: async (_scope, input) => {
          seen.push(input.detach);
          return {
            ok: true,
            outcome: "detached",
            content: [{ type: "text", text: "continues in the background as mc_01jd8x00000000000000000000" }],
            bytes: 0,
            truncated: false,
            era: "modern",
            rounds: 0,
            callId: "mc_01jd8x00000000000000000000",
            detachReason: "task",
          };
        },
      }),
    });
    const result = await (await connect(built.servers.open!)).callTool({ name: "search", arguments: {} });
    expect(seen).toEqual([true]);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("mc_01jd8x00000000000000000000");
  });

  it("hands the session's approval wait lease to the gateway, read when the call starts", async () => {
    registerCached("open", "any", ["search"]);
    const events: string[] = [];
    let lease: { begin(): void; end(): void } | undefined;
    const built = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => operatorTurn(),
      getApprovalWait: () => lease,
      getGateway: () => ({
        call: async (scope) => {
          // As the elicitation handler does while a person answers.
          scope.approvalWait?.begin();
          scope.approvalWait?.end();
          events.push(scope.approvalWait ? "with-lease" : "without-lease");
          return { ok: false, outcome: "error", reason: "done" };
        },
      }),
    });
    const client = await connect(built.servers.open!);
    await client.callTool({ name: "search", arguments: {} });
    lease = { begin: () => events.push("begin"), end: () => events.push("end") };
    await client.callTool({ name: "search", arguments: {} });
    expect(events).toEqual(["without-lease", "begin", "end", "with-lease"]);
  });

  it("never builds a facade under a host server name", () => {
    registerCached("open", "any", ["search"]);
    const built = buildGatewayMcpServers({
      agentId: AGENT,
      getContext: () => operatorTurn(),
      listAttachments: () =>
        [
          { agentId: AGENT, server: "spec", audience: "any", uploads: false, createdBy: null, createdAt: 0 },
          { agentId: AGENT, server: "open", audience: "any", uploads: false, createdBy: null, createdAt: 0 },
        ] as never,
    });
    expect(Object.keys(built.servers)).toEqual(["open"]);
    // Host names win: the facade of the same name is left out of the query, and the overlap is reported.
    const overlaps: string[][] = [];
    expect(
      mergeClaudeMcpServers({ spec: { host: 1 } }, { spec: { facade: 1 }, open: { b: 2 } }, (names) =>
        overlaps.push(names),
      ),
    ).toEqual({
      spec: { host: 1 },
      open: { b: 2 },
    });
    expect(overlaps).toEqual([["spec"]]);
    // A throwing reporter never fails the turn.
    expect(
      mergeClaudeMcpServers({ spec: {} }, { spec: {} }, () => {
        throw new Error("boom");
      }),
    ).toEqual({ spec: {} });
    expect(mergeClaudeMcpServers({ spec: { a: 1 } }, { open: { b: 2 } })).toEqual({ spec: { a: 1 }, open: { b: 2 } });
    expect(mergeClaudeMcpServers(undefined, {})).toBeUndefined();
  });

  it("checks the schema Claude Code requires and maps results without upstream metadata", () => {
    expect(facadeToolEntry({ name: "a", exposedName: "mcp__s__a" })).toEqual({
      name: "a",
      inputSchema: { type: "object" },
    });
    expect(
      facadeToolEntry({ name: "a", exposedName: "mcp__s__a", inputSchema: { properties: { x: { type: "string" } } } })
        ?.inputSchema,
    ).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(facadeToolEntry({ name: "a", exposedName: "mcp__s__a", inputSchema: { type: "string" } })).toBeNull();
    expect(facadeToolEntry({ name: "a", exposedName: "mcp__s__a", inputSchema: { properties: [] } })).toBeNull();
    expect(facadeToolEntry({ name: "a", exposedName: "mcp__s__a", inputSchema: { required: [1] } })).toBeNull();

    expect(
      facadeCallResult({
        ok: true,
        outcome: "ok",
        content: [],
        structuredContent: { n: 1 },
        bytes: 7,
        truncated: false,
        era: "modern",
        rounds: 0,
      }),
    ).toEqual({ content: [{ type: "text", text: '{"n":1}' }], structuredContent: { n: 1 } });
    // Ravi's note in front does not hide a structured-only result: its JSON still reaches Claude as text.
    const note = "[Ravi note, not from the MCP server] nobody was asked.";
    expect(
      facadeCallResult(
        withMcpRaviNote(
          {
            ok: true,
            outcome: "ok",
            content: [],
            structuredContent: { rows: [1, 2, 3] },
            bytes: 16,
            truncated: false,
            era: "modern",
            rounds: 0,
          },
          note,
        ),
      ).content,
    ).toEqual([
      { type: "text", text: note },
      { type: "text", text: '{"rows":[1,2,3]}' },
    ]);
    expect(facadeCallResult({ ok: false, outcome: "denied", code: "capability", reason: "no" })).toEqual({
      content: [{ type: "text", text: "no" }],
      isError: true,
    });
  });
});

const claudeLike = {
  supportsHostSessionHooks: true,
  supportsMcpServers: true,
  supportsRemoteSpawn: false,
} as RuntimeCapabilities;

function buildSession(turn: () => ContextRecord, specMode = false) {
  const attachments = buildRuntimeHostAttachments({
    runtimeCapabilities: claudeLike,
    agent: { id: AGENT, cwd: `/tmp/${AGENT}`, specMode },
    sessionName: "main-session",
    sessionCwd: `/tmp/${AGENT}`,
    streamingSession: { currentCrashRecoveryAttemptId: "attempt-1", currentTurnToolStarted: false },
    crashRecovery: { markTurnAttemptSafety: () => undefined } as unknown as Pick<
      RuntimeCrashRecoveryCoordinator,
      "markTurnAttemptSafety"
    >,
    getTurnContext: turn,
  });
  return { attachments, preToolUse: attachments.hooks?.PreToolUse ?? [] };
}

async function runPreToolUse(
  chain: RuntimeHookMatcher[],
  turn: ContextRecord,
  input: { tool_name: string; mcp_server?: { name: string; source: string } },
): Promise<string | null> {
  const toolContext: ToolContext = { agentId: AGENT, context: turn };
  return runWithContext(toolContext, async () => {
    for (const entry of chain.filter(
      (candidate) => candidate.matcher === undefined || candidate.matcher.split("|").includes(input.tool_name),
    )) {
      for (const hook of entry.hooks) {
        const result = await hook({ hook_event_name: "PreToolUse", tool_input: {}, ...input }, null, {
          signal: new AbortController().signal,
        });
        const output = result?.hookSpecificOutput;
        if (output?.permissionDecision === "deny") return String(output.permissionDecisionReason ?? "denied");
      }
    }
    return null;
  });
}

describe("Claude session wiring", () => {
  it("keeps facade names out of the host servers and rebuilds them per turn", () => {
    registerCached("open", "any", ["search"]);
    let turn = contactTurn([toolGrant("mcp__open__search")]);
    const { attachments } = buildSession(() => turn, true);
    expect(Object.keys(attachments.mcpServers ?? {})).toEqual(["spec"]);
    const facades = attachments.gatewayMcpServers!;
    // Nothing is declared before the host prepares the first turn.
    expect(facades.names()).toEqual([]);
    expect(facades.prepareTurn().map((entry) => entry.name)).toEqual(["open"]);
    expect(facades.names()).toEqual(["open"]);
    expect(Object.keys(facades.current())).toEqual(["open"]);
    for (const name of facades.names()) expect(HOST_MCP_SERVER_NAMES).not.toContain(name);
    expect(Object.keys(attachments.mcpServers ?? {})).toEqual(["spec"]);

    turn = contactTurn([]);
    expect(facades.prepareTurn()).toEqual([]);
    expect(facades.names()).toEqual([]);
  });

  it("builds no facades for a runtime without MCP servers or without a turn context", () => {
    registerCached("open", "any", ["search"]);
    const codexLike = buildRuntimeHostAttachments({
      runtimeCapabilities: { ...claudeLike, supportsMcpServers: false },
      agent: { id: AGENT, cwd: `/tmp/${AGENT}` },
      sessionName: "main-session",
      sessionCwd: `/tmp/${AGENT}`,
      streamingSession: { currentCrashRecoveryAttemptId: "attempt-1", currentTurnToolStarted: false },
      crashRecovery: { markTurnAttemptSafety: () => undefined } as never,
      getTurnContext: () => operatorTurn(),
    });
    expect(codexLike.gatewayMcpServers).toBeUndefined();
  });

  it("lets a granted facade tool through the hook and denies one without the grant", async () => {
    registerCached("open", "any", ["search", "delete"]);
    const turn = contactTurn([toolGrant("mcp__open__search"), toolGrant("ToolSearch")]);
    const { attachments, preToolUse } = buildSession(() => turn);
    attachments.gatewayMcpServers!.prepareTurn();

    const sdk = { name: "open", source: "sdk" };
    expect(await runPreToolUse(preToolUse, turn, { tool_name: "mcp__open__search", mcp_server: sdk })).toBeNull();
    expect(await runPreToolUse(preToolUse, turn, { tool_name: "mcp__open__delete", mcp_server: sdk })).toContain(
      "cannot use tool:mcp__open__delete",
    );
    // The same name from a configured server is not the facade.
    expect(
      await runPreToolUse(preToolUse, turn, {
        tool_name: "mcp__open__search",
        mcp_server: { name: "open", source: "project" },
      }),
    ).toContain("is not registered in Ravi");
  });

  it("denies a facade tool once the next turn no longer declares the server", async () => {
    registerCached("open", "any", ["search"]);
    let turn = contactTurn([toolGrant("mcp__open__search")]);
    const { attachments, preToolUse } = buildSession(() => turn);
    attachments.gatewayMcpServers!.prepareTurn();
    turn = contactTurn([toolGrant("Read")]);
    attachments.gatewayMcpServers!.prepareTurn();
    expect(
      await runPreToolUse(preToolUse, turn, {
        tool_name: "mcp__open__search",
        mcp_server: { name: "open", source: "sdk" },
      }),
    ).toContain("is not registered in Ravi");
  });

  it("forwards the runtime's report to the session", () => {
    const reports: unknown[] = [];
    const facades = createClaudeGatewayFacades({
      agentId: AGENT,
      getContext: () => undefined,
      hostMcpServers: ["spec"],
      onRuntimeReported: (report) => reports.push(report),
    });
    facades.reportRuntimeServers?.({ declared: [], reported: true, servers: [], extra: [], missing: [] });
    expect(reports).toHaveLength(1);
  });

  it("forwards a name overlap the query found, so the turn degrades instead of failing", () => {
    const overlaps: string[][] = [];
    const facades = createClaudeGatewayFacades({
      agentId: AGENT,
      getContext: () => undefined,
      hostMcpServers: ["spec"],
      onNameOverlap: (names) => overlaps.push(names),
    });
    facades.reportNameOverlap?.(["github"]);
    expect(overlaps).toEqual([["github"]]);
  });
});

describe("watchdog rule for forwarded MCP tools", () => {
  it("ignores a declared timeout for gateway tools and keeps it for host and built-in tools", () => {
    expect(isForwardedMcpToolName("mcp__open__slow")).toBe(true);
    expect(isForwardedMcpToolName("mcp__spec__enter_spec_mode")).toBe(false);
    expect(isForwardedMcpToolName("Bash")).toBe(false);
    expect(resolveToolInactivityTimeoutMs("mcp__open__slow", { timeout: 3600 })).toBe(
      DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
    );
    expect(resolveToolInactivityTimeoutMs("mcp__open__slow", { timeout: "3600" })).toBe(
      DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
    );
    expect(resolveToolInactivityTimeoutMs("mcp__spec__run", { timeout: 600 })).toBe(750_000);
    expect(resolveToolInactivityTimeoutMs("Bash", { timeout: 600 })).toBe(750_000);
    // The gateway's own budget fits inside the window it is left with.
    expect(MCP_FACADE_CALL_BUDGET_MS).toBeLessThan(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });
});

describe("runtime trace of MCP servers", () => {
  const identity = { sessionKey: "agent:main:mcp-trace", sessionName: "mcp-trace", agentId: AGENT, runId: "run-1" };

  it("records the declared host and gateway servers on the adapter request", () => {
    const servers = [
      { name: "spec", kind: "host" as const, transport: "in-process", era: null, toolCount: null, status: "attached" },
      { name: "open", kind: "gateway" as const, transport: "http", era: "modern", toolCount: 2, status: "ok" },
    ];
    const trace = recordAdapterRequestTrace({
      ...identity,
      turnId: "turn-mcp",
      provider: "claude",
      model: "haiku",
      prompt: "hello",
      systemPrompt: "system",
      cwd: "/tmp/main",
      resume: false,
      fork: false,
      hasHooks: true,
      pluginNames: [],
      mcpServerNames: ["spec", "open"],
      mcpServers: servers,
      hasRemoteSpawn: false,
    });
    expect(getSessionTraceBlob(trace!.requestBlobSha256)?.contentJson).toMatchObject({
      mcp_server_names: ["spec", "open"],
      mcp_servers: servers,
    });
  });

  it("records what the runtime reported, and a mismatch as such", () => {
    recordRuntimeMcpServersReport(
      { ...identity, turnId: "t1" },
      {
        declared: ["open"],
        reported: true,
        servers: [{ name: "open", source: "sdk", status: "connected" }],
        extra: [],
        missing: [],
      },
    );
    recordRuntimeMcpServersReport(
      { ...identity, turnId: "t2" },
      {
        declared: ["open"],
        reported: true,
        servers: [{ name: "github", source: "project", status: "pending" }],
        extra: [{ name: "github", source: "project", status: "pending" }],
        missing: ["open"],
      },
    );
    recordRuntimeMcpServersReport(
      { ...identity, turnId: "t3" },
      { declared: [], reported: false, servers: [], extra: [], missing: [] },
    );
    const events = listRecentSessionEventsByType(identity.sessionKey, "runtime.mcp_servers").reverse();
    expect(events.map((event) => event.status)).toEqual(["match", "mismatch", "unreported"]);
    expect(events[1]?.payloadJson).toEqual({
      mcp_declared: ["open"],
      mcp_runtime_reported: [{ name: "github", source: "project", status: "pending" }],
      extra: [{ name: "github", source: "project", status: "pending" }],
      missing: ["open"],
    });
    expect(events[2]?.payloadJson).toMatchObject({ mcp_runtime_reported: null });
  });

  it("records a gateway server dropped for a host name as a degraded event", () => {
    recordRuntimeMcpNameOverlap({ ...identity, turnId: "t4" }, ["github"]);
    const events = listRecentSessionEventsByType(identity.sessionKey, "runtime.mcp_name_overlap");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "degraded", payloadJson: { dropped_gateway_servers: ["github"] } });
  });
});
