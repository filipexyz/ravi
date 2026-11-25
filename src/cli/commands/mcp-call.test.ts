/**
 * The CLI pair `ravi mcp tools` and `ravi mcp call` (spec mcp, CLI Pair).
 *
 * The commands run where the daemon runs them: requests go over a real host
 * CLI gateway socket (the path Codex and Grok take from their shell) to the
 * command class, which uses the daemon's MCP gateway against a fixture MCP
 * server. Pi's path is the runtime host services' dynamic tools. A terminal
 * without a daemon gets a message that names the daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

import {
  MCP_CALL_MAX_WAIT_S,
  MCP_CALL_TOOL_MAX_WAIT_S,
  MCP_TOOLS_DESCRIPTION_MAX_BYTES,
  applyMcpToolsBudget,
  type McpListedTool,
  mcpArgumentKeys,
  mcpToolsBudgetNote,
  parseMcpCallInput,
  parseMcpCallWait,
  projectMcpCallResult,
  remoteMcpToolName,
} from "../../mcp/cli-pair.js";
import { createMcpCall, getMcpCall, type McpCallRecord } from "../../mcp/calls-db.js";
import { getMcpGateway, startMcpGateway, stopMcpGateway } from "../../mcp/gateway.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpServer,
  recordMcpServerProbe,
  setMcpConfigChangedEmitterForTests,
  updateMcpServerConfig,
} from "../../mcp/registry-db.js";
import { writeMcpServerSecret } from "../../mcp/secrets.js";
import { type HttpFixture, startHttpFixture } from "../../mcp/test-fixtures/servers.js";
import { type McpCallTraceInput, setMcpTraceSinksForTests } from "../../mcp/trace.js";
import { setPermissionAuditPublisherForTest } from "../../permissions/denials.js";
import { type ContextCapability, type ContextRecord, dbCreateAgent, dbGetAgent } from "../../router/router-db.js";
import { ADMIN_BOOTSTRAP_KIND, createRuntimeContext } from "../../runtime/context-registry.js";
import { createRuntimeHostServices } from "../../runtime/host-services.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { type HostCliGatewayHandle, startHostCliGateway } from "../host-cli-gateway.js";
import { buildRegistry } from "../registry-snapshot.js";
import { dispatchRemote, type RemoteGatewayConfig } from "../remote-gateway.js";
import { runWithContext } from "../context.js";
import { getHostCliGatewaySocketPath } from "../../isolation/execution-plane.js";
import { McpCallsCommands, McpCommands, mcpForwardFailedBeforeSend, mcpTerminalForwardAllowed } from "./mcp.js";

const RUNTIME_ENV = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_GATEWAY_URL",
  "RAVI_SUPPRESS_AUDIT_EVENTS",
] as const;
const SECRET_ARGUMENT = "argument-value-7c1e9f";

let stateDir: string;
let savedEnv: Record<string, string | undefined> = {};
let fixture: HttpFixture | null = null;
let socket: HostCliGatewayHandle | null = null;
let config: RemoteGatewayConfig;
let calls: McpCallTraceInput[] = [];

function grant(objectId: string): ContextCapability {
  return { permission: "use", objectType: "tool", objectId, source: "test" };
}

/** The command grants of the CLI pair, as the runtime bootstrap floor gives them. */
const PAIR: ContextCapability[] = [
  { permission: "read", objectType: "mcp.tools", objectId: "list", source: "test" },
  { permission: "mutate", objectType: "mcp.tools", objectId: "call", source: "test" },
];

beforeEach(async () => {
  stateDir = (await createIsolatedRaviState("ravi-mcp-pair-")) as string;
  savedEnv = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENV) delete process.env[name];
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  setMcpConfigChangedEmitterForTests(() => {});
  setPermissionAuditPublisherForTest(() => {});
  calls = [];
  setMcpTraceSinksForTests({ call: (input) => calls.push(input), catalog: () => {} });
  for (const id of ["main", "other"]) {
    if (!dbGetAgent(id)) dbCreateAgent({ id, cwd: stateDir });
  }
});

afterEach(async () => {
  await socket?.stop();
  socket = null;
  await stopMcpGateway();
  await fixture?.close();
  fixture = null;
  setMcpTraceSinksForTests({ call: null, catalog: null });
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  for (const name of RUNTIME_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await cleanupIsolatedRaviState(stateDir);
});

/**
 * Two registrations of one fixture server: `docs` (audience operator) and
 * `pub` (audience any, no credential), both attached to `main`, catalogs
 * fetched by the daemon's gateway.
 */
async function startDaemon(): Promise<void> {
  fixture = startHttpFixture({ badToolNames: ["bad.name"] });
  for (const [name, audience] of [
    ["docs", "operator"],
    ["pub", "any"],
  ] as const) {
    createMcpServer({ name, transport: "http", url: fixture.url, authKind: "none", protocol: "2026-07-28" });
    await writeMcpServerSecret(name, { url: fixture.url });
    attachMcpServer({ agentId: "main", server: name, audience });
  }
  const gateway = await startMcpGateway({ subscribe: false, refreshTickMs: 0, closeGraceMs: 200 });
  for (const name of ["docs", "pub"]) {
    const row = await gateway.refresh(name);
    expect(row?.status).toBe("ok");
  }
  const socketPath = join(stateDir, "cli-gateway.sock");
  socket = await startHostCliGateway({ socketPath, gateway: { registry: buildRegistry([McpCommands]) } });
  expect(socket).not.toBeNull();
  config = { url: `unix://${socketPath}`, source: "env", socketPath };
}

/** The operator's own credential (the terminal's admin root), for agent `main`. */
function operatorContext(extra: ContextCapability[] = [grant("mcp__docs__*"), grant("mcp__pub__*")]): ContextRecord {
  return createRuntimeContext({
    kind: ADMIN_BOOTSTRAP_KIND,
    agentId: "main",
    capabilities: [{ permission: "admin", objectType: "system", objectId: "*", source: "test" }, ...PAIR, ...extra],
  });
}

/** A resolved contact who is not the operator, in their own direct chat with `main`. */
function contactContext(extra: ContextCapability[] = [grant("mcp__docs__*"), grant("mcp__pub__*")]): ContextRecord {
  return createRuntimeContext({
    kind: "agent-runtime",
    agentId: "main",
    sessionName: "main-ana",
    capabilities: [...PAIR, ...extra],
    metadata: {
      actorPrincipal: "contact:c_ana",
      actorResolution: "resolved",
      executorAgentId: "main",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    },
  });
}

/** A context of `main` whose speaker Ravi cannot classify. */
function unknownContext(extra: ContextCapability[], agentId = "main"): ContextRecord {
  return createRuntimeContext({ kind: "cli-runtime", agentId, capabilities: [...PAIR, ...extra], metadata: {} });
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function remote(context: ContextRecord, command: "tools" | "call", body: Record<string, unknown>) {
  const result = await dispatchRemote({
    groupSegments: ["mcp"],
    command,
    body,
    config,
    contextKey: context.contextKey,
    timeoutMs: 30_000,
  });
  return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown>, text: result.body };
}

function errorOf(answer: Answer): { code: string; exitCode: number; message: string; plan?: Record<string, unknown> } {
  expect(answer.body.success).toBe(false);
  const error = answer.body.error as Record<string, unknown>;
  return {
    code: error.code as string,
    exitCode: answer.body.exitCode as number,
    message: error.message as string,
    plan: error.plan as Record<string, unknown> | undefined,
  };
}

function toolCalls(): number {
  return (fixture?.methods ?? []).filter((method) => method === "tools/call").length;
}

describe("cli pair helpers", () => {
  it("reads --input as one JSON object and never quotes it back", () => {
    expect(parseMcpCallInput(undefined)).toEqual({ ok: true, value: {} });
    expect(parseMcpCallInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    for (const bad of [`{"token":"${SECRET_ARGUMENT}"`, "[1,2]", '"text"', "null"]) {
      const parsed = parseMcpCallInput(bad);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(SECRET_ARGUMENT);
    }
    expect(parseMcpCallInput(`"${"x".repeat(1024 * 1024)}"`).ok).toBe(false);
  });

  it("bounds --wait, and caps it below the dynamic tool limit as a runtime tool", () => {
    expect(parseMcpCallWait(undefined, false)).toEqual({ ok: true, seconds: 45, capped: false });
    expect(parseMcpCallWait("90", false)).toEqual({ ok: true, seconds: 90, capped: false });
    expect(parseMcpCallWait("90", true)).toEqual({ ok: true, seconds: MCP_CALL_TOOL_MAX_WAIT_S, capped: true });
    for (const bad of ["0", String(MCP_CALL_MAX_WAIT_S + 1), "1.5", "-3", "soon"]) {
      expect(parseMcpCallWait(bad, false).ok).toBe(false);
    }
  });

  it("takes the remote tool name or its full name, and shows keys without values", () => {
    expect(remoteMcpToolName("docs", "echo")).toBe("echo");
    expect(remoteMcpToolName("docs", "mcp__docs__echo")).toBe("echo");
    expect(remoteMcpToolName("docs", "mcp__pub__echo")).toBe("mcp__pub__echo");
    const keys = mcpArgumentKeys({ b: SECRET_ARGUMENT, a: { nested: SECRET_ARGUMENT } });
    expect(keys).toEqual({ keys: ["a", "b"], more: 0 });
    const many = mcpArgumentKeys(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i])));
    expect(many.keys).toHaveLength(64);
    expect(many.more).toBe(6);
  });
});

describe("cli pair: listing budget", () => {
  const tool = (server: string, name: string, description = "d"): McpListedTool => ({
    server,
    name: `mcp__${server}__${name}`,
    tool: name,
    description,
    inputSchema: { type: "object" },
  });

  it("lets servers take turns, keeps stable order and counts what it left out", () => {
    const big = Array.from({ length: 10 }, (_, index) => tool("big", `t${String(index).padStart(2, "0")}`));
    const small = [tool("alpha", "one"), tool("alpha", "two")];
    const first = applyMcpToolsBudget([...big, ...small].reverse(), { maxTools: 4, maxBytes: 1_000_000 });
    expect(first.kept.map((item) => item.name)).toEqual([
      "mcp__alpha__one",
      "mcp__alpha__two",
      "mcp__big__t00",
      "mcp__big__t01",
    ]);
    expect(first.omitted).toEqual([{ server: "big", count: 8 }]);
    // The same input in any order gives the same cut.
    expect(applyMcpToolsBudget([...small, ...big], { maxTools: 4, maxBytes: 1_000_000 })).toEqual(first);
  });

  it("cuts by bytes too, skipping an entry that does not fit and trying the next", () => {
    const tools = [tool("a", "huge", "x".repeat(2_000)), tool("a", "small"), tool("b", "small")];
    const cut = applyMcpToolsBudget(tools, { maxTools: 100, maxBytes: 600 });
    expect(cut.kept.map((item) => item.name)).toEqual(["mcp__a__small", "mcp__b__small"]);
    expect(cut.omitted).toEqual([{ server: "a", count: 1 }]);
  });

  it("writes a note only when something was left out, and says how to narrow", () => {
    expect(mcpToolsBudgetNote([], {})).toBeNull();
    const note = mcpToolsBudgetNote([{ server: "big", count: 8 }], {});
    expect(note).toContain("8 more tools left out by the listing budget");
    expect(note).toContain("big (8)");
    expect(note).toContain("ravi mcp tools <server>");
    expect(mcpToolsBudgetNote([{ server: "big", count: 1 }], { server: "big" })).toContain("narrow with --query");
  });
});

describe("cli pair: background calls", () => {
  it("projects a detached call with its call id, and every other outcome with none", () => {
    const base = {
      content: [{ type: "text" as const, text: "handle" }],
      bytes: 0,
      truncated: false,
      era: "modern" as const,
      rounds: 0,
    };
    const call = { server: "docs", tool: "long", name: "mcp__docs__long", waitSeconds: 45 };
    expect(
      projectMcpCallResult({ ok: true, outcome: "detached", callId: "mc_01jd8x00000000000000000000", ...base }, call),
    ).toMatchObject({ outcome: "detached", callId: "mc_01jd8x00000000000000000000" });
    expect(projectMcpCallResult({ ok: true, outcome: "ok", ...base }, call).callId).toBeNull();
  });
});

describe("ravi mcp call through the host gateway socket", () => {
  it("calls a tool on the operator's own turn and returns text and structured content", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "call", {
      server: "docs",
      tool: "echo",
      input: JSON.stringify({ text: "hi" }),
      execute: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      server: "docs",
      tool: "echo",
      name: "mcp__docs__echo",
      outcome: "ok",
      content: [{ type: "text", text: "echo: hi" }],
      structuredContent: { echoed: "hi" },
      era: "modern",
      waitSeconds: 45,
    });
    expect(answer.text).not.toContain("example.com/steer");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ server: "docs", tool: "echo", surface: "cli", outcome: "ok" });
    expect(JSON.stringify(calls)).not.toContain('hi"');
  });

  it("accepts the full tool name and reports an image by type and size, never its bytes", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "call", { server: "docs", tool: "mcp__docs__mixed", execute: true });
    expect(answer.status).toBe(200);
    const content = answer.body.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "head" });
    expect(content).toContainEqual({ type: "omitted", contentType: "image", mimeType: "image/png", bytes: 9 });
    expect(answer.text).not.toContain(Buffer.from("png-bytes").toString("base64"));
  });

  it("returns a tool error as a result (outcome tool_error, exit 0)", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "call", { server: "pub", tool: "fail", execute: true });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "tool_error", content: [{ type: "text", text: "it broke" }] });
  });

  it("is a dry run without --execute: exit 3, argument keys and never their values, nothing sent", async () => {
    await startDaemon();
    const before = toolCalls();
    const answer = await remote(operatorContext(), "call", {
      server: "docs",
      tool: "echo",
      input: JSON.stringify({ text: SECRET_ARGUMENT, token: SECRET_ARGUMENT }),
    });
    const error = errorOf(answer);
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(error.plan).toMatchObject({
      server: "docs",
      tool: "echo",
      name: "mcp__docs__echo",
      argumentKeys: ["text", "token"],
      connects: false,
    });
    expect(answer.text).not.toContain(SECRET_ARGUMENT);
    expect(toolCalls()).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid --input (exit 2) without quoting it", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "call", {
      server: "docs",
      tool: "echo",
      input: `{"text":"${SECRET_ARGUMENT}"`,
      execute: true,
    });
    const error = errorOf(answer);
    expect(error.exitCode).toBe(2);
    expect(answer.text).not.toContain(SECRET_ARGUMENT);
  });

  it("denies by the authorization matrix before any call reaches the server", async () => {
    await startDaemon();
    const before = toolCalls();
    const cases: Array<{
      name: string;
      context: () => ContextRecord;
      body: Record<string, unknown>;
      code: string;
      exit: number;
    }> = [
      {
        name: "operator audience on a contact's turn",
        context: () => contactContext(),
        body: { server: "docs", tool: "echo" },
        code: "MCP_AUDIENCE",
        exit: 3,
      },
      {
        name: "operator audience on a turn Ravi cannot classify",
        context: () => unknownContext([grant("mcp__docs__*")]),
        body: { server: "docs", tool: "echo" },
        code: "MCP_AUDIENCE",
        exit: 3,
      },
      {
        name: "a tool the turn is not granted",
        context: () => contactContext([grant("mcp__pub__echo")]),
        body: { server: "pub", tool: "fail" },
        code: "MCP_CAPABILITY",
        exit: 3,
      },
      {
        name: "a tool name that cannot be exposed",
        context: () => operatorContext(),
        body: { server: "pub", tool: "bad.name" },
        code: "MCP_CAPABILITY",
        exit: 3,
      },
      {
        name: "a server not attached to the agent",
        context: () => unknownContext([grant("mcp__pub__*")], "other"),
        body: { server: "pub", tool: "echo" },
        code: "MCP_NOT_ATTACHED",
        exit: 3,
      },
      {
        name: "a server that is not registered",
        context: () => operatorContext(),
        body: { server: "nope", tool: "echo" },
        code: "MCP_SERVER_NOT_FOUND",
        exit: 1,
      },
      {
        name: "another agent's servers named with --agent",
        context: () => unknownContext([grant("mcp__pub__*")], "other"),
        body: { server: "pub", tool: "echo", agent: "main" },
        code: "MCP_NO_TURN",
        exit: 3,
      },
    ];
    for (const item of cases) {
      for (const execute of [false, true]) {
        const answer = await remote(item.context(), "call", { ...item.body, ...(execute ? { execute: true } : {}) });
        const error = errorOf(answer);
        expect({ name: item.name, execute, code: error.code, exit: error.exitCode }).toEqual({
          name: item.name,
          execute,
          code: item.code,
          exit: item.exit,
        });
      }
    }
    expect(toolCalls()).toBe(before);
  });

  it("lets a contact's turn call a server widened to any, and denies a disabled or logged-out one", async () => {
    await startDaemon();
    const contact = contactContext();
    const ok = await remote(contact, "call", { server: "pub", tool: "echo", input: '{"text":"x"}', execute: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outcome: "ok", content: [{ type: "text", text: "echo: x" }] });

    updateMcpServerConfig("pub", { enabled: false });
    expect(errorOf(await remote(contact, "call", { server: "pub", tool: "echo", execute: true }))).toMatchObject({
      code: "MCP_DISABLED",
      exitCode: 3,
    });

    const operator = operatorContext();
    recordMcpServerProbe("docs", { status: "needs_login", statusDetail: "run ravi mcp login docs" });
    const login = errorOf(await remote(operator, "call", { server: "docs", tool: "echo", execute: true }));
    expect(login).toMatchObject({ code: "MCP_NEEDS_LOGIN", exitCode: 1 });
    expect(login.message).toContain("run ravi mcp login docs --execute");
  });

  it("runs the command grant first: a context without it is refused before any MCP check", async () => {
    await startDaemon();
    const ungranted = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: "main",
      capabilities: [grant("mcp__docs__*")],
    });
    for (const [command, body] of [
      ["tools", { server: "docs" }],
      ["call", { server: "docs", tool: "echo", execute: true }],
    ] as const) {
      const answer = await remote(ungranted, command, body);
      expect(errorOf(answer).code).toBe("PERMISSION_DENIED");
    }
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear error when the daemon's MCP gateway is not running", async () => {
    await startDaemon();
    await stopMcpGateway();
    expect(getMcpGateway()).toBeNull();
    const error = errorOf(await remote(operatorContext(), "call", { server: "docs", tool: "echo", execute: true }));
    expect(error).toMatchObject({ code: "MCP_GATEWAY_UNAVAILABLE", exitCode: 1 });
  });
});

describe("ravi mcp tools through the host gateway socket", () => {
  it("lists the granted tools of every listable server in stable order, with schemas", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "tools", {});
    expect(answer.status).toBe(200);
    const tools = answer.body.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("mcp__docs__echo");
    expect(names).toContain("mcp__pub__echo");
    expect(names.some((name) => String(name).includes("bad"))).toBe(false);
    expect(tools.find((tool) => tool.name === "mcp__docs__echo")).toMatchObject({
      server: "docs",
      tool: "echo",
      description: "Echo text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    });
    expect(answer.body).toMatchObject({
      agentId: "main",
      total: tools.length,
      omitted: [],
      note: null,
      unavailable: [],
    });
  });

  it("shows a contact's turn only what it may call, and says why a server is unavailable", async () => {
    await startDaemon();
    const answer = await remote(contactContext([grant("mcp__pub__echo")]), "tools", {});
    expect((answer.body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["mcp__pub__echo"]);
    expect(answer.body.unavailable).toEqual([
      { server: "docs", code: "audience", reason: expect.stringContaining("operator") },
    ]);

    const named = errorOf(await remote(contactContext(), "tools", { server: "docs" }));
    expect(named).toMatchObject({ code: "MCP_AUDIENCE", exitCode: 3 });
  });

  it("filters with --query and caps descriptions at 1 KB", async () => {
    await startDaemon();
    const catalog = getMcpServer("pub")?.catalog;
    recordMcpServerProbe("pub", {
      status: "ok",
      catalog: {
        tools: [
          ...(catalog?.tools ?? []),
          {
            name: "long",
            exposedName: "mcp__pub__long",
            description: "é".repeat(4000),
            inputSchema: { type: "object" },
          },
        ],
        dropped: [],
      },
    });
    const queried = await remote(operatorContext(), "tools", { server: "pub", query: "ECHO" });
    expect((queried.body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["mcp__pub__echo"]);

    const long = await remote(operatorContext(), "tools", { server: "pub", query: "long" });
    const description = (long.body.tools as Array<{ description: string }>)[0]!.description;
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(MCP_TOOLS_DESCRIPTION_MAX_BYTES + 3);
    expect(description.endsWith("…")).toBe(true);
  });
});

describe("Pi's dynamic tools", () => {
  function piServices(context: ContextRecord) {
    return createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "main-session",
      toolContext: { contextId: context.contextId, context, agentId: "main", sessionName: "main-session" },
    } as Parameters<typeof createRuntimeHostServices>[0]);
  }

  it("lists mcp_tools and mcp_call only when use:tool grants them", () => {
    const names = (context: ContextRecord) =>
      piServices(context)
        .listDynamicTools()
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("mcp_"));
    expect(names(unknownContext([]))).toEqual([]);
    expect(names(unknownContext([grant("mcp_call")]))).toEqual(["mcp_call"]);
    expect(names(unknownContext([grant("mcp_tools"), grant("mcp_call")])).sort()).toEqual(["mcp_call", "mcp_tools"]);
    // Neither is ever granted by the name of an MCP tool alone.
    expect(names(unknownContext([grant("mcp__pub__*")]))).toEqual([]);
  });

  it("runs mcp_call in the daemon's gateway under the same check", async () => {
    await startDaemon();
    const context = contactContext([grant("mcp_call"), grant("mcp__pub__echo")]);
    const services = piServices(context);
    const ok = await services.executeDynamicTool({
      toolName: "mcp_call",
      arguments: { server: "pub", tool: "echo", input: '{"text":"pi"}', execute: true, json: true },
    } as Parameters<typeof services.executeDynamicTool>[0]);
    expect(ok.success).toBe(true);
    const text = ok.contentItems.map((item) => ("text" in item ? item.text : "")).join("\n");
    expect(text).toContain("echo: pi");
    expect(calls.at(-1)).toMatchObject({ server: "pub", tool: "echo", surface: "cli", outcome: "ok" });

    const denied = await services.executeDynamicTool({
      toolName: "mcp_call",
      arguments: { server: "docs", tool: "echo", input: "{}", execute: true, json: true },
    } as Parameters<typeof services.executeDynamicTool>[0]);
    // A policy refusal (exit 3) comes back as the contract envelope, like every blocked dynamic tool.
    const refusal = JSON.parse(denied.contentItems.map((item) => ("text" in item ? item.text : "")).join("\n"));
    expect(refusal).toMatchObject({ success: false, op: "mcp call", error: { code: "MCP_AUDIENCE" } });
  });
});

describe("from a terminal", () => {
  async function terminal(fn: (commands: McpCommands) => unknown) {
    const out: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    console.error = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    try {
      return { result: await fn(new McpCommands()), out };
    } catch (error) {
      return { error, out };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  it("fails with a message naming the daemon when no daemon runs, and connects to nothing", async () => {
    fixture = startHttpFixture();
    createMcpServer({ name: "docs", transport: "http", url: fixture.url, authKind: "none" });
    await writeMcpServerSecret("docs", { url: fixture.url });
    attachMcpServer({ agentId: "main", server: "docs" });

    for (const run of [
      (commands: McpCommands) => commands.tools(undefined, undefined, "main", true),
      (commands: McpCommands) => commands.call("docs", "echo", '{"text":"x"}', undefined, "main", true, true),
    ]) {
      const outcome = await terminal(run);
      expect(outcome.error).toBeInstanceOf(ContractError);
      const error = outcome.error as ContractError;
      expect(error.code).toBe("MCP_DAEMON_REQUIRED");
      expect(error.exitCode).toBe(1);
      expect(error.message).toContain("daemon");
      expect(outcome.out.join("\n")).toContain("MCP_DAEMON_REQUIRED");
    }
    expect(fixture.methods).toEqual([]);
  });

  it("never invites a resend when the daemon took a call and the connection dropped", async () => {
    // A daemon socket that reads the request and drops the connection without answering.
    const socketPath = getHostCliGatewaySocketPath();
    const received: string[] = [];
    const server = createNetServer((connection) => {
      connection.on("data", (chunk) => {
        received.push(chunk.toString("utf8"));
        connection.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      process.env.RAVI_CONTEXT_KEY = operatorContext().contextKey;

      const called = await terminal((commands) =>
        commands.call("docs", "echo", '{"text":"t"}', undefined, undefined, true, true),
      );
      const error = called.error as ContractError;
      expect(error).toBeInstanceOf(ContractError);
      expect(error.code).toBe("MCP_CALL_OUTCOME_UNKNOWN");
      expect(error.exitCode).toBe(1);
      const printed = called.out.join("\n");
      expect(printed).toContain('"retryable": false');
      expect(printed).toContain("Do not call it again blindly");
      expect(received.join("")).toContain("POST /api/v1/mcp/call");

      // A read-only listing has no outcome to lose: it stays retryable.
      const listed = await terminal((commands) => commands.tools(undefined, undefined, undefined, true));
      expect((listed.error as ContractError).code).toBe("MCP_DAEMON_REQUIRED");
      expect(listed.out.join("\n")).toContain('"retryable": true');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Before anything is sent (no socket, a refused connection) a call is safe to retry.
    expect(mcpForwardFailedBeforeSend(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(mcpForwardFailedBeforeSend(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(true);
    expect(mcpForwardFailedBeforeSend(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(mcpForwardFailedBeforeSend(new Error("Host CLI gateway request timed out"))).toBe(false);
  });

  it("goes through the daemon's socket with the terminal's context credential", async () => {
    await startDaemon();
    // The daemon's default socket of this state directory, which the terminal finds on its own.
    await socket?.stop();
    socket = await startHostCliGateway({ gateway: { registry: buildRegistry([McpCommands]) } });

    const missing = await terminal((commands) => commands.tools(undefined, undefined, undefined, true));
    expect((missing.error as ContractError).code).toBe("MCP_CONTEXT_REQUIRED");

    process.env.RAVI_CONTEXT_KEY = operatorContext().contextKey;
    const listed = await terminal((commands) => commands.tools("docs", undefined, undefined, true));
    expect(listed.error).toBeUndefined();
    expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain(
      "mcp__docs__echo",
    );

    const dry = await terminal((commands) =>
      commands.call("docs", "echo", JSON.stringify({ text: SECRET_ARGUMENT }), undefined, undefined, true, false),
    );
    expect((dry.error as ContractError).exitCode).toBe(3);
    expect(dry.out.join("\n")).not.toContain(SECRET_ARGUMENT);

    const called = await terminal((commands) =>
      commands.call("docs", "echo", '{"text":"t"}', "30", undefined, true, true),
    );
    expect(called.error).toBeUndefined();
    expect(called.result).toMatchObject({
      outcome: "ok",
      content: [{ type: "text", text: "echo: t" }],
      waitSeconds: 30,
    });
  });

  it("forwards only from a terminal: a session's process without its key, or code with a context of its own, is refused", async () => {
    expect(mcpTerminalForwardAllowed(undefined, {})).toBe(true);
    expect(mcpTerminalForwardAllowed({ context: {}, contextOrigin: "default-credential" }, {})).toBe(true);
    expect(mcpTerminalForwardAllowed({ context: {} }, {})).toBe(false);
    expect(mcpTerminalForwardAllowed({ context: {} }, { RAVI_CONTEXT_KEY: "k" })).toBe(false);
    expect(mcpTerminalForwardAllowed(undefined, { RAVI_SESSION_KEY: "agent:main:main" })).toBe(false);
    expect(mcpTerminalForwardAllowed(undefined, { RAVI_AGENT_ID: "main" })).toBe(false);
    expect(mcpTerminalForwardAllowed(undefined, { RAVI_SESSION_NAME: "s", RAVI_CONTEXT_KEY: "k" })).toBe(true);
    // A shell cron, a shell trigger and a job carry the automation principal (a trigger also its id): never the terminal.
    const cron = { RAVI_AUTOMATION_PRINCIPAL: "automation:cron:job_0123" };
    const trigger = { RAVI_AUTOMATION_PRINCIPAL: "automation:trigger:t1", RAVI_TRIGGER_ID: "t1" };
    const job = { RAVI_AUTOMATION_PRINCIPAL: "automation:job:job_0123456789" };
    for (const env of [
      cron,
      trigger,
      job,
      { RAVI_TRIGGER_ID: "t1" },
      { RAVI_AUTOMATION_PRINCIPAL: "not-a-principal" },
      // A marker blanked by an assignment prefix (`RAVI_SESSION_KEY= RAVI_AGENT_ID= ravi mcp call ...`) still counts.
      { RAVI_SESSION_KEY: "", RAVI_SESSION_NAME: "", RAVI_AGENT_ID: "" },
      { RAVI_SESSION_KEY: " " },
      { RAVI_AUTOMATION_PRINCIPAL: "" },
      { RAVI_CONTEXT_KEY: "", RAVI_TRIGGER_ID: "" },
    ]) {
      expect(mcpTerminalForwardAllowed(undefined, env)).toBe(false);
      expect(mcpTerminalForwardAllowed({ context: {}, contextOrigin: "default-credential" }, env)).toBe(false);
    }

    await startDaemon();
    await socket?.stop();
    socket = await startHostCliGateway({ gateway: { registry: buildRegistry([McpCommands]) } });

    const inProcess = await terminal((commands) =>
      runWithContext({ context: operatorContext(), agentId: "main" }, () =>
        commands.call("docs", "echo", '{"text":"x"}', undefined, undefined, true, true),
      ),
    );
    expect((inProcess.error as ContractError).code).toBe("MCP_NO_TURN");
    expect((inProcess.error as ContractError).exitCode).toBe(3);

    const previous = process.env.RAVI_SESSION_KEY;
    process.env.RAVI_SESSION_KEY = "agent:main:main";
    try {
      const keyless = await terminal((commands) => commands.tools(undefined, undefined, "main", true));
      expect((keyless.error as ContractError).code).toBe("MCP_NO_TURN");
      expect((keyless.error as ContractError).exitCode).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.RAVI_SESSION_KEY;
      else process.env.RAVI_SESSION_KEY = previous;
    }
    // A job's process (the operator's default credential, no context key) is refused the same way.
    const previousPrincipal = process.env.RAVI_AUTOMATION_PRINCIPAL;
    process.env.RAVI_AUTOMATION_PRINCIPAL = "automation:job:job_0123456789";
    try {
      const automation = await terminal((commands) =>
        commands.call("docs", "echo", '{"text":"x"}', undefined, "main", true, true),
      );
      expect((automation.error as ContractError).code).toBe("MCP_NO_TURN");
      expect((automation.error as ContractError).exitCode).toBe(3);
    } finally {
      if (previousPrincipal === undefined) delete process.env.RAVI_AUTOMATION_PRINCIPAL;
      else process.env.RAVI_AUTOMATION_PRINCIPAL = previousPrincipal;
    }
    expect(fixture?.methods.filter((method) => method === "tools/call") ?? []).toEqual([]);
  });
});

describe("background calls through the daemon: what a turn may see and cancel", () => {
  /** The calls commands of the bootstrap floor, as `@CommandAccess` asks them. */
  const CALLS: ContextCapability[] = [
    { permission: "read", objectType: "mcp.calls", objectId: "list", source: "test" },
    { permission: "mutate", objectType: "mcp.calls", objectId: "cancel", source: "test" },
  ];

  async function startCallsGateway(): Promise<void> {
    // `ops` is for the operator's own turns only; `pub` is for anyone. Neither is contacted here.
    for (const [name, audience] of [
      ["ops", "operator"],
      ["pub", "any"],
    ] as const) {
      createMcpServer({ name, transport: "http", url: "https://mcp.example.com/mcp", authKind: "none" });
      attachMcpServer({ agentId: "main", server: name, audience });
    }
    const socketPath = join(stateDir, "cli-gateway.sock");
    socket = await startHostCliGateway({ socketPath, gateway: { registry: buildRegistry([McpCallsCommands]) } });
    expect(socket).not.toBeNull();
    config = { url: `unix://${socketPath}`, source: "env", socketPath };
  }

  function backgroundCall(server: string, tool: string, sessionName: string): McpCallRecord {
    return createMcpCall({
      server,
      tool,
      agentId: "main",
      sessionName,
      origin: { contextId: "ctx_x", contactId: null, operatorOwn: false },
      surface: "cli",
      detachReason: "task",
      state: "task",
      remoteTaskId: "mct_remote",
      taskStatus: "working",
      nextPollAt: Date.now() + 60_000,
      expiresAt: Date.now() + 600_000,
    });
  }

  function turnContext(metadata: Record<string, unknown>, tools: string[]): ContextRecord {
    return createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionName: "main-ana",
      capabilities: [...CALLS, ...tools.map(grant)],
      metadata: { actorResolution: "resolved", executorAgentId: "main", ...metadata },
    });
  }

  const contactTurn = (tools: string[]) =>
    turnContext(
      {
        actorPrincipal: "contact:c_ana",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      },
      tools,
    );

  async function callsRemote(context: ContextRecord, command: "list" | "cancel", body: Record<string, unknown>) {
    const result = await dispatchRemote({
      groupSegments: ["mcp", "calls"],
      command,
      body,
      config,
      contextKey: context.contextKey,
      timeoutMs: 30_000,
    });
    return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown>, text: result.body };
  }

  async function listedIds(context: ContextRecord): Promise<string[]> {
    const answer = await callsRemote(context, "list", {});
    expect(answer.body.success, answer.text).not.toBe(false);
    const payload = answer.body as unknown as { total: number; calls: Array<{ id: string }> };
    expect(payload.total).toBe(payload.calls.length);
    return payload.calls.map((call) => call.id).sort();
  }

  it("a contact's turn sees and cancels only its session's calls to servers and tools it may use", async () => {
    await startCallsGateway();
    const allowed = backgroundCall("pub", "search", "main-ana");
    const operatorOnly = backgroundCall("ops", "search", "main-ana");
    const ungranted = backgroundCall("pub", "admin", "main-ana");
    const otherSession = backgroundCall("pub", "search", "main-bob");
    const contact = contactTurn(["mcp__pub__search", "mcp__ops__*"]);

    expect(await listedIds(contact)).toEqual([allowed.id]);

    for (const hidden of [operatorOnly, ungranted, otherSession]) {
      const refused = await callsRemote(contact, "cancel", { id: hidden.id });
      expect(refused.body.success).toBe(false);
      expect((refused.body.error as { code: string }).code).toBe("MCP_CALL_NOT_FOUND");
      expect(getMcpCall(hidden.id)?.cancelRequestedAt).toBeNull();
    }
    const cancelled = await callsRemote(contact, "cancel", { id: allowed.id });
    expect(cancelled.body).toMatchObject({ cancelRequested: true });
    expect(getMcpCall(allowed.id)?.cancelRequestedAt).not.toBeNull();
  });

  it("the delivery turn of a call sees that call, even on an operator-only server, and nothing it may not use", async () => {
    await startCallsGateway();
    const delivered = backgroundCall("ops", "search", "main-ana");
    const sibling = backgroundCall("ops", "search", "main-ana");
    const usable = backgroundCall("pub", "search", "main-ana");
    const delivery = turnContext({ actorPrincipal: `automation:mcp-call:${delivered.id}` }, [
      "mcp__pub__*",
      "mcp__ops__*",
    ]);

    expect(await listedIds(delivery)).toEqual([delivered.id, usable.id].sort());
    const refused = await callsRemote(delivery, "cancel", { id: sibling.id });
    expect((refused.body.error as { code: string }).code).toBe("MCP_CALL_NOT_FOUND");
    const cancelled = await callsRemote(delivery, "cancel", { id: delivered.id });
    expect(cancelled.body).toMatchObject({ cancelRequested: true });
  });

  it("the operator's own turn keeps every call; a turn without the calls grant is refused", async () => {
    await startCallsGateway();
    const ids = [backgroundCall("ops", "search", "main-ana").id, backgroundCall("pub", "admin", "main-bob").id].sort();
    const operator = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: "main",
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*", source: "test" }, ...CALLS],
    });
    expect(await listedIds(operator)).toEqual(ids);

    const bare = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionName: "main-ana",
      capabilities: [grant("mcp__pub__*")],
      metadata: { actorPrincipal: "contact:c_ana", actorResolution: "resolved", executorAgentId: "main" },
    });
    const denied = await callsRemote(bare, "list", {});
    expect(denied.body.success).toBe(false);
  });
});
