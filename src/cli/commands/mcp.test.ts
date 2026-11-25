/**
 * `ravi mcp` management commands (spec mcp, Management CLI). Runs the real
 * command class against an isolated Ravi state: the registry rows and the
 * credentials-store entries it writes, or does not write, are the ones the
 * gateway reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createMcpServer,
  getMcpAttachment,
  getMcpServer,
  listMcpAttachments,
  type McpConfigChangedEvent,
  recordMcpServerProbe,
  setMcpConfigChangedEmitterForTests,
} from "../../mcp/registry-db.js";
import { hasMcpServerSecret, readMcpServerSecret, writeMcpServerSecret } from "../../mcp/secrets.js";
import { type ContextCapability, dbCreateAgent, dbUpdateAgent } from "../../router/router-db.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin } from "../../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { startOAuthFixture } from "../../mcp/test-fixtures/oauth-server.js";
import { createMcpCall, getMcpCall, recordMcpServerRateLimit, updateMcpCall } from "../../mcp/calls-db.js";
import { canUseToolInContext, evaluateBashPermission } from "../../bash/hook.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import { enforceCliCommandAccess } from "../command-access.js";
import { extractTools } from "../tools-export.js";
import { AgentsCommands } from "./agents.js";
import {
  McpCallsCommands,
  McpCommands,
  McpSkillsCommands,
  mcpToolSearchWarnings,
  setMcpLoginDepsForTests,
  setMcpStdinReaderForTests,
} from "./mcp.js";

const RUNTIME_ENV = ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"] as const;
const TOKEN_URL = "https://mcp.example.com/bridge/abcdefghijklmnopqrstuvwxyz0123/mcp?key=qwertyuiopasdfgh";

let stateDir: string | null = null;

/** A Claude agent whose runtime permission profile is set, as `ravi agents permissions` stores it. */
function claudeAgentWithProfile(id: string, runtimePermissions: { profile: string; capabilities?: string[] }): void {
  dbCreateAgent({ id, cwd: stateDir as string, provider: "claude" });
  dbUpdateAgent(id, { defaults: { runtimePermissions } });
}
let savedEnv: Record<string, string | undefined> = {};
let events: McpConfigChangedEvent[] = [];
let fetchCalls = 0;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-cli-");
  savedEnv = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENV) delete process.env[name];
  events = [];
  setMcpConfigChangedEmitterForTests((event) => void events.push(event));
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setMcpStdinReaderForTests(null);
  setMcpLoginDepsForTests(null);
  setMcpConfigChangedEmitterForTests(null);
  for (const name of RUNTIME_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

type Outcome = { result?: Record<string, unknown>; error?: unknown; out: string[] };

async function capture(fn: (commands: McpCommands) => unknown): Promise<Outcome> {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...items: unknown[]) => void out.push(items.map(String).join(" "));
  console.error = (...items: unknown[]) => void out.push(items.map(String).join(" "));
  try {
    const result = (await fn(new McpCommands())) as Record<string, unknown> | undefined;
    return { result, out };
  } catch (error) {
    return { error, out };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

interface AddOptions {
  url?: string;
  urlStdin?: boolean;
  command?: string;
  args?: string[];
  env?: string[];
  auth?: string;
  protocol?: string;
  agents?: string[];
  execute?: boolean;
}

function add(name: string, options: AddOptions): Promise<Outcome> {
  return capture((commands) =>
    commands.add(
      name,
      options.url,
      options.urlStdin,
      options.command,
      options.args,
      options.env,
      options.auth,
      options.protocol,
      options.agents,
      true,
      options.execute,
    ),
  );
}

function contractOf(outcome: Outcome): ContractError {
  expect(outcome.result).toBeUndefined();
  expect(outcome.error).toBeInstanceOf(ContractError);
  return outcome.error as ContractError;
}

function stdin(text: string): void {
  setMcpStdinReaderForTests(async () => text);
}

/** Every byte of ravi.db and its WAL, to prove a secret never reached them. */
function stateDbBytes(): string {
  const dir = stateDir as string;
  return readdirSync(dir)
    .filter((file) => file.startsWith("ravi.db"))
    .map((file) => readFileSync(join(dir, file)).toString("latin1"))
    .join("\n");
}

function useContext(metadata: Record<string, unknown>, capabilities?: ContextCapability[]): void {
  const context = createRuntimeContext({
    kind: "turn-runtime",
    agentId: "main",
    sessionName: "main-session",
    metadata,
    ...(capabilities ? { capabilities } : {}),
  });
  process.env.RAVI_CONTEXT_KEY = context.contextKey;
}

/** A resolved contact who is not the operator, in their own direct chat. */
function useContactTurn(capabilities?: ContextCapability[]): void {
  useContext(
    {
      actorPrincipal: "contact:c_ana",
      actorResolution: "resolved",
      executorAgentId: "main",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    },
    capabilities,
  );
}

/** The operator's own `ravi sessions send`: an operator turn without admin on system:*. */
function useOperatorRelayTurn(): void {
  useContext({
    actorPrincipal: "automation:operator:local",
    actorResolution: "resolved",
    executorAgentId: "main",
    agentIdentityCompartment: "workspace:default",
    turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
  });
}

async function registerDocs(extra: AddOptions = {}): Promise<void> {
  const outcome = await add("docs", { url: "https://mcp.example.com/mcp", execute: true, ...extra });
  expect(outcome.error).toBeUndefined();
}

describe("ravi mcp add", () => {
  it("is a dry run by default: exit 3, the plan, nothing written, no connection", async () => {
    const outcome = await add("docs", { url: "https://mcp.example.com/mcp", agents: ["main"] });

    const contract = contractOf(outcome);
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(contract.details.plan).toMatchObject({
      name: "docs",
      transport: "http",
      agents: ["main"],
      audience: "operator",
      connects: false,
    });
    expect(String(contract.details.plan && (contract.details.plan as Record<string, unknown>).urlDisplay)).toStartWith(
      "https://mcp.example.com",
    );
    expect(JSON.parse(outcome.out.join("\n"))).toMatchObject({
      success: false,
      op: "mcp add",
      error: { code: "WRITE_REQUIRES_EXECUTE" },
    });
    expect(getMcpServer("docs")).toBeNull();
    expect(hasMcpServerSecret("docs")).toBe(false);
    expect(events).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it("registers an http server with --execute, keeps the URL in the credentials store and attaches agents", async () => {
    const outcome = await add("docs", { url: "https://mcp.example.com/mcp", agents: ["main"], execute: true });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toMatchObject({
      server: { name: "docs", transport: "http", urlDisplay: "https://mcp.example.com/mcp", authKind: "none" },
      attached: ["main"],
      secretStored: true,
    });
    expect(getMcpServer("docs")).toMatchObject({ createdBy: "terminal", protocol: "auto", enabled: true });
    expect(getMcpAttachment("main", "docs")).toMatchObject({ audience: "operator", uploads: false });
    expect(await readMcpServerSecret("docs")).toEqual({ url: "https://mcp.example.com/mcp" });
    expect(events.every((event) => event.reason === "mcp_servers" && event.change === "config")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(fetchCalls).toBe(0);
  });

  it("refuses a token-bearing URL on the command line (exit 2) and takes it from stdin", async () => {
    const inline = await add("console", { url: TOKEN_URL, auth: "oauth", execute: true });
    const contract = contractOf(inline);
    expect(contract.exitCode).toBe(2);
    expect(contract.code).toBe("INLINE_SECRET");
    expect(inline.out.join("\n")).not.toContain("abcdefghijklmnop");
    expect(getMcpServer("console")).toBeNull();

    stdin(`${TOKEN_URL}\n`);
    const dryRun = await add("console", { urlStdin: true, auth: "oauth" });
    expect(contractOf(dryRun).details.plan).toMatchObject({
      urlDisplay: "https://mcp.example.com/bridge/…/mcp",
      fromStdin: ["url"],
    });
    expect(dryRun.out.join("\n")).not.toContain("abcdefghijklmnop");
    expect(dryRun.out.join("\n")).not.toContain("qwertyuiop");
    expect(getMcpServer("console")).toBeNull();
    expect(await readMcpServerSecret("console")).toBeNull();

    stdin(`${TOKEN_URL}\n`);
    const piped = await add("console", { urlStdin: true, auth: "oauth", execute: true });
    expect(piped.error).toBeUndefined();
    expect(piped.result).toMatchObject({
      server: { urlDisplay: "https://mcp.example.com/bridge/…/mcp", authKind: "oauth" },
    });
    expect(piped.out.join("\n")).not.toContain("abcdefghijklmnop");
    expect(piped.out.join("\n")).not.toContain("qwertyuiop");
    expect(await readMcpServerSecret("console")).toEqual({ url: TOKEN_URL });
    expect(stateDbBytes()).not.toContain("abcdefghijklmnop");
    expect(stateDbBytes()).not.toContain("qwertyuiop");

    const shown = await capture((commands) => commands.show("console", true));
    expect(JSON.stringify(shown.result)).not.toContain("abcdefghijklmnop");
    const listed = await capture((commands) => commands.list(undefined, "50", "0", true));
    expect(JSON.stringify(listed.result)).not.toContain("abcdefghijklmnop");
  });

  it("reads and checks stdin in the dry run too: the plan --execute would carry out, or the refusal it would get", async () => {
    stdin("notaurl\n");
    const badUrl = contractOf(await add("x1", { urlStdin: true }));
    expect(badUrl).toMatchObject({ exitCode: 2, code: "INVALID_URL" });
    expect(badUrl.message).not.toContain("notaurl");

    stdin(`${TOKEN_URL}\n${TOKEN_URL}\n`);
    expect(contractOf(await add("x1", { urlStdin: true })).exitCode).toBe(2);

    stdin("WRONG=1\n");
    const badEnv = contractOf(await add("x2", { command: "foo", env: ["FILES_TOKEN"] }));
    expect(badEnv).toMatchObject({ exitCode: 2, code: "USAGE_ERROR" });

    stdin("FILES_TOKEN=s3cr3t-value-123\nOTHER=two\n");
    const planned = await add("x2", { command: "foo", env: ["OTHER", "FILES_TOKEN"] });
    expect(contractOf(planned).details.plan).toMatchObject({
      envKeys: ["FILES_TOKEN", "OTHER"],
      fromStdin: ["env FILES_TOKEN", "env OTHER"],
    });
    expect(planned.out.join("\n")).not.toContain("s3cr3t");
    expect(getMcpServer("x1")).toBeNull();
    expect(getMcpServer("x2")).toBeNull();
    expect(await readMcpServerSecret("x2")).toBeNull();
    expect(stateDbBytes()).not.toContain("s3cr3t-value-123");
  });

  it("refuses an invalid or plain-http URL without repeating it (exit 2)", async () => {
    const plain = contractOf(await add("docs", { url: "http://mcp.example.com/mcp", execute: true }));
    expect(plain.exitCode).toBe(2);
    expect(plain.code).toBe("INVALID_URL");
    expect(plain.message).not.toContain("mcp.example.com");
    expect(contractOf(await add("docs", { url: "not a url", execute: true })).code).toBe("INVALID_URL");
  });

  it("registers a stdio server with env values read from stdin, never stored in ravi.db", async () => {
    stdin("# comment\nFILES_TOKEN=s3cr3t-value-123\n\nOTHER=two=parts\n");
    const outcome = await add("files", {
      command: "npx",
      args: ["-y", "@scope/files-server"],
      env: ["OTHER", "FILES_TOKEN"],
      execute: true,
    });

    expect(outcome.error).toBeUndefined();
    expect(getMcpServer("files")).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/files-server"],
      envKeys: ["FILES_TOKEN", "OTHER"],
    });
    expect(await readMcpServerSecret("files")).toEqual({
      env: { FILES_TOKEN: "s3cr3t-value-123", OTHER: "two=parts" },
    });
    expect(outcome.out.join("\n")).not.toContain("s3cr3t");
    expect(stateDbBytes()).not.toContain("s3cr3t-value-123");
  });

  it("refuses inline secret values with exit 2 and writes nothing", async () => {
    const env = contractOf(await add("files", { command: "npx", env: ["FILES_TOKEN=abc"], execute: true }));
    expect(env.exitCode).toBe(2);
    expect(env.code).toBe("INLINE_SECRET");

    for (const args of [
      ["--token=abc123"],
      ["--api-key", "abc123"],
      ["GITHUB_TOKEN=abc123"],
      ["https://example.com/x/abcdefghijklmnopqrstuvwxyz"],
    ]) {
      const contract = contractOf(await add("files", { command: "npx", args, execute: true }));
      expect(contract.exitCode).toBe(2);
      expect(contract.code).toBe("INLINE_SECRET");
      expect(contract.message).not.toContain("abc123");
    }
    expect(getMcpServer("files")).toBeNull();
    expect(hasMcpServerSecret("files")).toBe(false);
  });

  it("refuses bad stdin env values: a missing key, an undeclared key, a repeated key", async () => {
    for (const text of ["A_KEY=one\n", "A_KEY=one\nB_KEY=two\nC_KEY=three\n", "A_KEY=one\nA_KEY=two\nB_KEY=x\n"]) {
      stdin(text);
      const contract = contractOf(await add("files", { command: "npx", env: ["A_KEY", "B_KEY"], execute: true }));
      expect(contract.exitCode).toBe(2);
      expect(contract.message).not.toContain("one");
    }
    expect(getMcpServer("files")).toBeNull();
    expect(hasMcpServerSecret("files")).toBe(false);
  });

  it("refuses stdin where only the daemon's gateway runs the command (exit 2)", async () => {
    const outcome = await capture(() =>
      runWithContext({ transport: "gateway" }, () =>
        new McpCommands().add(
          "files",
          undefined,
          undefined,
          "npx",
          undefined,
          ["A_KEY"],
          undefined,
          undefined,
          undefined,
          true,
          true,
        ),
      ),
    );
    const contract = contractOf(outcome);
    expect(contract.exitCode).toBe(2);
    expect(contract.message).toContain("stdin");
    expect(getMcpServer("files")).toBeNull();
  });

  it("refuses usage errors: no transport, two transports, a bad name, a reserved name, --auth on stdio", async () => {
    expect(contractOf(await add("docs", {})).exitCode).toBe(2);
    expect(contractOf(await add("docs", { url: "https://a.example.com", command: "npx" })).exitCode).toBe(2);
    const underscore = contractOf(await add("my_docs", { url: "https://a.example.com" }));
    expect(underscore).toMatchObject({ exitCode: 2, code: "INVALID_NAME" });
    expect(contractOf(await add("ravi", { url: "https://a.example.com" }))).toMatchObject({
      exitCode: 2,
      code: "RESERVED_NAME",
    });
    expect(contractOf(await add("spec", { url: "https://a.example.com" })).code).toBe("RESERVED_NAME");
    expect(contractOf(await add("files", { command: "npx", auth: "oauth" })).exitCode).toBe(2);
    expect(contractOf(await add("docs", { url: "https://a.example.com", auth: "magic" })).exitCode).toBe(2);
  });

  it("refuses a duplicate name and an unknown agent (exit 1) before the brake", async () => {
    await registerDocs();
    expect(contractOf(await add("docs", { url: "https://a.example.com" }))).toMatchObject({
      exitCode: 1,
      code: "ALREADY_REGISTERED",
    });
    const agent = contractOf(await add("other", { url: "https://a.example.com", agents: ["mian"] }));
    expect(agent).toMatchObject({ exitCode: 1, code: "AGENT_NOT_FOUND" });
    expect(agent.details.suggestions).toContain("main");
  });

  it("leaves the secret of a server registered concurrently under the same name alone", async () => {
    // Another add of "docs" wins while this one waits on stdin, after this one's duplicate check.
    const winner = "https://winner.example.com/mcp";
    setMcpStdinReaderForTests(async () => {
      createMcpServer({ name: "docs", transport: "http", url: winner });
      await writeMcpServerSecret("docs", { url: winner });
      return `${TOKEN_URL}\n`;
    });
    const lost = contractOf(await add("docs", { urlStdin: true, agents: ["main"], execute: true }));
    expect(lost.exitCode).toBe(1);
    expect(lost.message).toContain("already registered");
    expect(await readMcpServerSecret("docs")).toEqual({ url: winner });
    expect(getMcpServer("docs")?.urlDisplay).toBe(winner);
    expect(getMcpAttachment("main", "docs")).toBeNull();
  });

  it("stores the secret after the row and then tells the daemon the credential changed", async () => {
    events = [];
    await registerDocs();
    expect(getMcpServer("docs")?.credentialRev).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a contact turn with exit 3 even with --execute, and writes nothing", async () => {
    useContactTurn();
    const outcome = await add("docs", { url: "https://mcp.example.com/mcp", execute: true });

    const contract = contractOf(outcome);
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("OPERATOR_TURN_REQUIRED");
    expect(getMcpServer("docs")).toBeNull();
    expect(hasMcpServerSecret("docs")).toBe(false);
  });

  it("lets the operator's relay register an http server but not a stdio one without admin on system:*", async () => {
    useOperatorRelayTurn();
    const http = await add("docs", { url: "https://mcp.example.com/mcp", execute: true });
    expect(http.error).toBeUndefined();

    const stdio = contractOf(await add("files", { command: "npx", execute: true }));
    expect(stdio.code).toBe("PERMISSION_DENIED");
    expect(stdio.exitCode).toBe(1);
    expect(getMcpServer("files")).toBeNull();
  });

  it("refuses to attach a stdio server to a remote agent", async () => {
    dbCreateAgent({ id: "far", cwd: stateDir as string, remote: "worker.example" });
    const contract = contractOf(await add("files", { command: "npx", agents: ["far"], execute: true }));
    expect(contract).toMatchObject({ exitCode: 3, code: "REMOTE_SPAWN_STDIO" });
    expect(getMcpServer("files")).toBeNull();
  });
});

describe("ravi mcp attach and detach", () => {
  it("brakes attach, then attaches with --execute; a second attach changes nothing", async () => {
    await registerDocs();
    dbCreateAgent({ id: "helper", cwd: stateDir as string });

    const dry = contractOf(await capture((commands) => commands.attach("docs", "helper", true)));
    expect(dry).toMatchObject({ exitCode: 3, code: "WRITE_REQUIRES_EXECUTE" });
    expect(getMcpAttachment("helper", "docs")).toBeNull();

    const done = await capture((commands) => commands.attach("docs", "helper", true, true));
    expect(done.result).toEqual({
      server: "docs",
      agentId: "helper",
      audience: "operator",
      uploads: false,
      created: true,
      warnings: [],
    });

    const again = await capture((commands) => commands.attach("docs", "helper", true));
    expect(again.result).toMatchObject({ created: false });
  });

  it("refuses attach on a contact turn (exit 3) and for a stdio server on a remote agent", async () => {
    await registerDocs();
    dbCreateAgent({ id: "far", cwd: stateDir as string, remote: "worker.example" });
    stdin("");
    expect((await add("files", { command: "npx", execute: true })).error).toBeUndefined();

    const remote = contractOf(await capture((commands) => commands.attach("files", "far", true, true)));
    expect(remote).toMatchObject({ exitCode: 3, code: "REMOTE_SPAWN_STDIO" });

    useContactTurn();
    const contact = contractOf(await capture((commands) => commands.attach("docs", "far", true, true)));
    expect(contact).toMatchObject({ exitCode: 3, code: "OPERATOR_TURN_REQUIRED" });
    expect(getMcpAttachment("far", "docs")).toBeNull();
  });

  it("detaches at once, even on a contact turn, and reports a missing attachment (exit 1)", async () => {
    await registerDocs({ agents: ["main"] });
    useContactTurn();

    const done = await capture((commands) => commands.detach("docs", "main", true));
    expect(done.result).toEqual({ server: "docs", agentId: "main", detached: true, skillPinsDropped: 0 });
    expect(getMcpAttachment("main", "docs")).toBeNull();

    expect(contractOf(await capture((commands) => commands.detach("docs", "main", true)))).toMatchObject({
      exitCode: 1,
      code: "NOT_ATTACHED",
    });
    expect(contractOf(await capture((commands) => commands.detach("nope", "main", true))).code).toBe(
      "MCP_SERVER_NOT_FOUND",
    );
  });
});

describe("ravi mcp set", () => {
  function set(
    name: string,
    options: { audience?: string; uploads?: string; agent?: string; protocol?: string; execute?: boolean },
  ): Promise<Outcome> {
    return capture((commands) =>
      commands.set(name, options.audience, options.uploads, options.agent, options.protocol, true, options.execute),
    );
  }

  it("brakes widening and applies narrowing at once", async () => {
    await registerDocs({ agents: ["main"] });

    const dry = contractOf(await set("docs", { audience: "any" }));
    expect(dry).toMatchObject({ exitCode: 3, code: "WRITE_REQUIRES_EXECUTE" });
    expect(dry.details.plan).toMatchObject({ server: "docs", agents: ["main"], audience: "any" });
    expect(getMcpAttachment("main", "docs")?.audience).toBe("operator");

    const widened = await set("docs", { audience: "any", execute: true });
    expect(widened.result).toMatchObject({ changed: true, attachments: [{ agentId: "main", audience: "any" }] });

    const uploadsDry = contractOf(await set("docs", { uploads: "on", agent: "main" }));
    expect(uploadsDry.exitCode).toBe(3);
    expect((await set("docs", { uploads: "on", agent: "main", execute: true })).result).toMatchObject({
      attachments: [{ agentId: "main", uploads: true }],
    });

    useContactTurn();
    const narrowed = await set("docs", { audience: "operator", uploads: "off" });
    expect(narrowed.error).toBeUndefined();
    expect(getMcpAttachment("main", "docs")).toMatchObject({ audience: "operator", uploads: false });

    const unchanged = await set("docs", { audience: "operator" });
    expect(unchanged.result).toMatchObject({ changed: false });
  });

  it("refuses widening on a contact turn with exit 3", async () => {
    await registerDocs({ agents: ["main"] });
    useContactTurn();

    for (const options of [
      { audience: "any", execute: true },
      { uploads: "on", agent: "main", execute: true },
      { protocol: "legacy", execute: true },
    ]) {
      expect(contractOf(await set("docs", options))).toMatchObject({ exitCode: 3, code: "OPERATOR_TURN_REQUIRED" });
    }
    expect(getMcpAttachment("main", "docs")).toMatchObject({ audience: "operator", uploads: false });
    expect(getMcpServer("docs")?.protocol).toBe("auto");
  });

  it("refuses audience any for a legacy credentialed row until the modern protocol is known", async () => {
    stdin("https://console.example.com/mcp\n");
    expect((await add("console", { urlStdin: true, auth: "oauth", agents: ["main"], execute: true })).error).toBe(
      undefined,
    );

    expect(contractOf(await set("console", { audience: "any", execute: true }))).toMatchObject({
      exitCode: 3,
      code: "AUDIENCE_LEGACY",
    });
    // A pin of 2026-07-28 with no legacy verdict is not the legacy leg, so pinning and widening together pass.
    const pinned = await set("console", { protocol: "2026-07-28", audience: "any", execute: true });
    expect(pinned.error).toBeUndefined();
    expect(getMcpServer("console")?.protocol).toBe("2026-07-28");
    expect(getMcpAttachment("main", "console")?.audience).toBe("any");

    await set("console", { audience: "operator" });
    recordMcpServerProbe("console", { status: "ok", era: "legacy" });
    expect(contractOf(await set("console", { audience: "any", execute: true })).code).toBe("AUDIENCE_LEGACY");
  });

  it("refuses audience any for a row whose URL carries a token, even with auth none", async () => {
    stdin(`${TOKEN_URL}\n`);
    expect((await add("bridge", { urlStdin: true, agents: ["main"], execute: true })).error).toBeUndefined();
    expect(getMcpServer("bridge")).toMatchObject({ authKind: "none", urlSecret: true });

    expect(contractOf(await set("bridge", { audience: "any", execute: true }))).toMatchObject({
      exitCode: 3,
      code: "AUDIENCE_LEGACY",
    });
    recordMcpServerProbe("bridge", { status: "ok", era: "legacy" });
    expect(contractOf(await set("bridge", { audience: "any", execute: true })).code).toBe("AUDIENCE_LEGACY");
    expect(getMcpAttachment("main", "bridge")?.audience).toBe("operator");

    // A plain URL holds no credential: widening is only braked.
    await registerDocs({ agents: ["main"] });
    expect(getMcpServer("docs")?.urlSecret).toBe(false);
    recordMcpServerProbe("docs", { status: "ok", era: "legacy" });
    expect((await set("docs", { audience: "any", execute: true })).error).toBeUndefined();
  });

  it("refuses audience any for a stdio row with stored env values, and widens one without env keys", async () => {
    stdin("FILES_TOKEN=s3cr3t-value-123\n");
    expect((await add("files", { command: "npx", env: ["FILES_TOKEN"], agents: ["main"], execute: true })).error).toBe(
      undefined,
    );
    expect(getMcpServer("files")).toMatchObject({ authKind: "none", urlSecret: false, envKeys: ["FILES_TOKEN"] });

    const refused = await set("files", { audience: "any", execute: true });
    expect(contractOf(refused)).toMatchObject({ exitCode: 3, code: "AUDIENCE_LEGACY" });
    expect(refused.out.join("\n")).not.toContain("s3cr3t");
    recordMcpServerProbe("files", { status: "ok", era: "legacy" });
    expect(contractOf(await set("files", { audience: "any", execute: true })).code).toBe("AUDIENCE_LEGACY");
    expect(getMcpAttachment("main", "files")?.audience).toBe("operator");
    // Pinning the modern revision lifts the legacy rule, as for a login.
    expect((await set("files", { protocol: "2026-07-28", audience: "any", execute: true })).error).toBeUndefined();
    expect(getMcpAttachment("main", "files")?.audience).toBe("any");

    expect((await add("plain", { command: "npx", agents: ["main"], execute: true })).error).toBeUndefined();
    expect(getMcpServer("plain")?.envKeys).toEqual([]);
    recordMcpServerProbe("plain", { status: "ok", era: "legacy" });
    expect((await set("plain", { audience: "any", execute: true })).error).toBeUndefined();
    expect(getMcpAttachment("main", "plain")?.audience).toBe("any");
  });

  it("brakes every protocol change and resets what the daemon probed", async () => {
    await registerDocs();
    recordMcpServerProbe("docs", { status: "ok", era: "modern" });

    expect(contractOf(await set("docs", { protocol: "legacy" })).details.plan).toMatchObject({
      protocol: { from: "auto", to: "legacy" },
    });
    const done = await set("docs", { protocol: "legacy", execute: true });
    expect(done.result).toMatchObject({ changed: true, protocol: { from: "auto", to: "legacy" } });
    expect(getMcpServer("docs")).toMatchObject({ protocol: "legacy", era: null, status: "unknown" });
  });

  it("refuses usage errors and a missing attachment", async () => {
    await registerDocs();
    stdin("");
    expect((await add("files", { command: "npx", agents: ["main"], execute: true })).error).toBeUndefined();

    expect(contractOf(await set("docs", {})).exitCode).toBe(2);
    expect(contractOf(await set("docs", { audience: "everyone" })).exitCode).toBe(2);
    expect(contractOf(await set("docs", { uploads: "on" })).exitCode).toBe(2);
    expect(contractOf(await set("docs", { audience: "any" })).code).toBe("NOT_ATTACHED");
    expect(contractOf(await set("docs", { audience: "any", agent: "main" })).code).toBe("NOT_ATTACHED");
    expect(contractOf(await set("files", { uploads: "on", agent: "main", execute: true })).code).toBe(
      "UPLOADS_NOT_SUPPORTED",
    );
  });
});

describe("ravi mcp enable, disable and remove", () => {
  it("disables at once and brakes enable", async () => {
    await registerDocs();
    useContactTurn();
    const disabled = await capture((commands) => commands.disable("docs", true));
    expect(disabled.result).toMatchObject({ changed: true, server: { enabled: false } });

    expect(contractOf(await capture((commands) => commands.enable("docs", true, true)))).toMatchObject({
      exitCode: 3,
      code: "OPERATOR_TURN_REQUIRED",
    });

    delete process.env.RAVI_CONTEXT_KEY;
    expect(contractOf(await capture((commands) => commands.enable("docs", true))).code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(getMcpServer("docs")?.enabled).toBe(false);
    const enabled = await capture((commands) => commands.enable("docs", true, true));
    expect(enabled.result).toMatchObject({ changed: true, server: { enabled: true } });
  });

  it("removes at once: the row, its attachments, its secret", async () => {
    stdin("A_KEY=secret-one\n");
    expect((await add("files", { command: "npx", env: ["A_KEY"], agents: ["main"], execute: true })).error).toBe(
      undefined,
    );
    const secretDir = join(stateDir as string, "credential-secrets");
    expect(readdirSync(secretDir)).toHaveLength(1);

    useContactTurn();
    const removed = await capture((commands) => commands.remove("files", true));
    expect(removed.result).toMatchObject({
      removed: { name: "files" },
      detachedAgents: ["main"],
      secretDeleted: true,
      secretDeleteFailed: false,
    });
    expect(getMcpServer("files")).toBeNull();
    expect(listMcpAttachments({ server: "files" })).toEqual([]);
    expect(hasMcpServerSecret("files")).toBe(false);
    expect(existsSync(secretDir) ? readdirSync(secretDir) : []).toEqual([]);

    expect(contractOf(await capture((commands) => commands.remove("files", true)))).toMatchObject({
      exitCode: 1,
      code: "MCP_SERVER_NOT_FOUND",
    });
  });
});

describe("ravi mcp list and show", () => {
  it("lists servers with their attachments, filters by agent and paginates", async () => {
    await registerDocs({ agents: ["main"] });
    expect((await add("other", { url: "https://other.example.com", execute: true })).error).toBeUndefined();

    const all = await capture((commands) => commands.list(undefined, "1", "0", true));
    expect(all.result).toMatchObject({
      total: 2,
      pagination: { returned: 1, hasMore: true, nextOffset: 1, nextCommand: "ravi mcp list --limit 1 --offset 1" },
      items: [{ name: "docs", attachments: [{ agentId: "main", audience: "operator", uploads: false }] }],
    });
    const forMain = await capture((commands) => commands.list("main", "50", "0", true));
    expect(((forMain.result?.items ?? []) as Array<{ name: string }>).map((item) => item.name)).toEqual(["docs"]);

    expect(contractOf(await capture((commands) => commands.list(undefined, "0", "0", true))).exitCode).toBe(2);
  });

  it("shows status, era, extensions, tools, dropped tools and login state", async () => {
    stdin("https://console.example.com/mcp\n");
    await add("console", { urlStdin: true, auth: "oauth", execute: true });
    recordMcpServerProbe("console", {
      status: "needs_login",
      statusDetail: "run ravi mcp login console",
      era: "modern",
      extensions: { "io.modelcontextprotocol/tasks": {} },
      catalog: {
        tools: [{ name: "search", exposedName: "mcp__console__search", description: "Search" }],
        dropped: [{ name: "bad.tool", reason: "the tool name holds characters other than letters" }],
      },
      catalogFingerprint: "sha256:abc",
    });

    const shown = await capture((commands) => commands.show("console", true));
    expect(shown.result).toMatchObject({
      server: {
        name: "console",
        urlDisplay: "https://console.example.com/mcp",
        status: "needs_login",
        era: "modern",
        extensions: { "io.modelcontextprotocol/tasks": {} },
        tools: [{ name: "search", exposedName: "mcp__console__search" }],
        dropped: [{ name: "bad.tool" }],
        toolCount: 1,
        droppedCount: 1,
        secretStored: true,
        login: "needs_login",
      },
    });

    const missing = contractOf(await capture((commands) => commands.show("consle", true)));
    expect(missing).toMatchObject({ exitCode: 1, code: "MCP_SERVER_NOT_FOUND" });
    expect(missing.details.suggestions).toContain("console");
    const rendered = await capture((commands) => commands.show("consle", true));
    expect(JSON.parse(rendered.out.join("\n"))).toMatchObject({
      success: false,
      op: "mcp show",
      error: { code: "MCP_SERVER_NOT_FOUND", message: expect.any(String) },
    });
  });
});

interface LoginOptions {
  clientId?: string;
  port?: string;
  tokenStdin?: boolean;
  paste?: boolean;
  execute?: boolean;
}

function login(name: string, options: LoginOptions = {}): Promise<Outcome> {
  return capture((commands) =>
    commands.login(name, options.clientId, options.port, options.tokenStdin, options.paste, true, options.execute),
  );
}

async function registerAuth(name: string, auth: "oauth" | "bearer", url = "https://console.example.com/mcp") {
  createMcpServer({ name, transport: "http", url, authKind: auth });
  await writeMcpServerSecret(name, { url });
}

describe("ravi mcp login", () => {
  it("is a dry run by default: exit 3, the plan, no connection and no listener", async () => {
    await registerAuth("console", "oauth");
    const contract = contractOf(await login("console", { port: "40123" }));
    expect(contract).toMatchObject({ exitCode: 3, code: "WRITE_REQUIRES_EXECUTE" });
    expect(contract.details.plan).toMatchObject({
      server: "console",
      authKind: "oauth",
      redirectUri: "http://127.0.0.1:40123/callback",
      listens: true,
      opensBrowser: true,
      clientRegistration: "dynamic",
      connects: false,
    });
    expect(fetchCalls).toBe(0);
    const pasted = contractOf(await login("console", { paste: true, clientId: "manual" }));
    expect(pasted.details.plan).toMatchObject({
      listens: false,
      opensBrowser: false,
      clientRegistration: "preregistered",
    });
  });

  it("is refused inside a runtime turn, even with --execute", async () => {
    await registerAuth("console", "oauth");
    useOperatorRelayTurn();
    const contract = contractOf(await login("console", { execute: true }));
    expect(contract).toMatchObject({ exitCode: 2, code: "CLI_ONLY_COMMAND" });
    expect(fetchCalls).toBe(0);

    delete process.env.RAVI_CONTEXT_KEY;
    const gateway = await capture((commands) =>
      runWithContext({ transport: "gateway" }, () =>
        commands.login("console", undefined, undefined, undefined, undefined, true, true),
      ),
    );
    expect(contractOf(gateway)).toMatchObject({ code: "CLI_ONLY_COMMAND" });

    // A shell cron, shell trigger or job process is not the operator's terminal either.
    for (const [name, value] of [
      ["RAVI_AUTOMATION_PRINCIPAL", "automation:cron:job_0123"],
      ["RAVI_TRIGGER_ID", "t1"],
    ] as const) {
      const previous = process.env[name];
      process.env[name] = value;
      try {
        expect(contractOf(await login("console", { execute: true }))).toMatchObject({ code: "CLI_ONLY_COMMAND" });
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
    expect(fetchCalls).toBe(0);
  });

  it("checks the flags against the server's auth before anything else", async () => {
    await registerAuth("console", "oauth");
    await registerAuth("search", "bearer");
    createMcpServer({ name: "docs", transport: "http", url: "https://docs.example.com/mcp" });
    const cases: Array<[string, LoginOptions, string]> = [
      ["console", { tokenStdin: true }, "uses OAuth"],
      ["search", {}, "--token-stdin"],
      ["search", { tokenStdin: true, paste: true }, "OAuth servers only"],
      ["docs", {}, "needs no login"],
      ["console", { port: "80" }, "--port"],
      ["console", { clientId: "two words" }, "--client-id"],
    ];
    for (const [name, options, message] of cases) {
      const contract = contractOf(await login(name, { ...options, execute: true }));
      expect(contract.exitCode).toBe(2);
      expect(contract.message).toContain(message);
    }
    expect(contractOf(await login("nope"))).toMatchObject({ exitCode: 1, code: "MCP_SERVER_NOT_FOUND" });
    expect(fetchCalls).toBe(0);
  });

  it("reads and checks the bearer token in the dry run too, and stores nothing", async () => {
    await registerAuth("search", "bearer");
    stdin("two words\n");
    const refused = contractOf(await login("search", { tokenStdin: true }));
    expect(refused).toMatchObject({ exitCode: 2, code: "INVALID_OPTION" });
    expect(refused.message).not.toContain("words");

    stdin("bearer-token-value-123\n");
    const planned = await login("search", { tokenStdin: true });
    expect(contractOf(planned).details.plan).toMatchObject({
      authKind: "bearer",
      readsStdin: true,
      tokenReceived: true,
      connects: false,
    });
    expect(planned.out.join("\n")).not.toContain("bearer-token-value-123");
    expect((await readMcpServerSecret("search"))?.bearer).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it("refuses an invalid client metadata document setting", async () => {
    await registerAuth("console", "oauth");
    const saved = process.env.RAVI_MCP_CLIENT_METADATA_URL;
    process.env.RAVI_MCP_CLIENT_METADATA_URL = "http://client.example.com/c.json";
    try {
      const contract = contractOf(await login("console"));
      expect(contract).toMatchObject({ exitCode: 2, code: "INVALID_OPTION" });
    } finally {
      if (saved === undefined) delete process.env.RAVI_MCP_CLIENT_METADATA_URL;
      else process.env.RAVI_MCP_CLIENT_METADATA_URL = saved;
    }
  });

  it("signs in with a bearer token from stdin and never prints it", async () => {
    globalThis.fetch = originalFetch;
    const fixture = startOAuthFixture();
    try {
      await registerAuth("search", "bearer", fixture.url);
      const token = fixture.mintAccessToken();
      stdin(`${token}\n`);
      setMcpLoginDepsForTests({ prompt: () => {} });
      const outcome = await login("search", { tokenStdin: true, execute: true });
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toMatchObject({ server: "search", authKind: "bearer", toolCount: 2 });
      expect((await readMcpServerSecret("search"))?.bearer).toBe(token);
      expect(outcome.out.join("\n")).not.toContain(token);
      expect(stateDbBytes()).not.toContain(token);

      stdin("wrong-token");
      const refused = contractOf(await login("search", { tokenStdin: true, execute: true }));
      expect(refused).toMatchObject({ exitCode: 3, code: "TOKEN_REFUSED" });
      expect((await readMcpServerSecret("search"))?.bearer).toBe(token);
    } finally {
      await fixture.close();
    }
  });
});

describe("ravi mcp show: login state", () => {
  it("reports the stored login without token material: logged in with its expiry, needs login, not needed", async () => {
    const now = Date.now();
    await registerAuth("console", "oauth");
    await writeMcpServerSecret("console", {
      url: "https://console.example.com/mcp",
      oauth: {
        tokens: {
          access_token: "access-token-value-1",
          refresh_token: "refresh-token-value-1",
          expires_in: 3600,
          obtained_at: now,
        },
      },
    });
    const oauth = await capture((commands) => commands.show("console", true));
    expect((oauth.result as { server: Record<string, unknown> }).server).toMatchObject({
      login: "logged_in",
      loginExpiresAt: now + 3_600_000,
      loginRenews: true,
    });
    expect(JSON.stringify(oauth.result)).not.toContain("token-value-1");

    await registerAuth("expired", "oauth");
    await writeMcpServerSecret("expired", {
      url: "https://console.example.com/mcp",
      oauth: { tokens: { access_token: "access-token-value-2", expires_in: 60, obtained_at: now - 120_000 } },
    });
    const lapsed = await capture((commands) => commands.show("expired", true));
    expect((lapsed.result as { server: Record<string, unknown> }).server).toMatchObject({
      login: "needs_login",
      loginRenews: false,
    });

    await registerAuth("search", "bearer");
    const missing = await capture((commands) => commands.show("search", true));
    expect((missing.result as { server: Record<string, unknown> }).server).toMatchObject({ login: "needs_login" });
    await writeMcpServerSecret("search", { url: "https://console.example.com/mcp", bearer: "bearer-value-3" });
    const bearer = await capture((commands) => commands.show("search", true));
    expect((bearer.result as { server: Record<string, unknown> }).server).toMatchObject({
      login: "logged_in",
      loginExpiresAt: null,
    });
    expect(JSON.stringify(bearer.result)).not.toContain("bearer-value-3");
    const text = await capture((commands) => commands.show("console"));
    expect(text.out.join("\n")).toContain("login: logged_in (access token expires");
    expect(text.out.join("\n")).not.toContain("token-value-1");

    await registerDocs();
    const open = await capture((commands) => commands.show("docs", true));
    expect((open.result as { server: Record<string, unknown> }).server).toMatchObject({ login: "not_needed" });
  });
});

describe("ravi mcp logout", () => {
  it("applies at once, keeps the URL and needs no operator turn", async () => {
    await registerAuth("search", "bearer");
    await writeMcpServerSecret("search", { url: "https://console.example.com/mcp", bearer: "stored-bearer-token" });
    useContactTurn();
    const outcome = await capture((commands) => commands.logout("search", true));
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({
      server: "search",
      removed: true,
      revocation: "not_offered",
      status: "needs_login",
    });
    expect(await readMcpServerSecret("search")).toEqual({ url: "https://console.example.com/mcp" });
    expect(outcome.out.join("\n")).not.toContain("stored-bearer-token");

    const again = await capture((commands) => commands.logout("search", true));
    expect(again.result).toMatchObject({ removed: false });
  });
});

describe("ravi mcp calls", () => {
  function newCall(sessionName: string, state: "running" | "task" = "task") {
    return createMcpCall({
      server: "docs",
      tool: "search",
      agentId: "main",
      sessionName,
      origin: { contextId: "ctx_x", contactId: "c_secret_person", operatorOwn: false },
      surface: "cli",
      detachReason: state === "task" ? "task" : "budget",
      state,
      ...(state === "task" ? { remoteTaskId: "mct_remote", taskStatus: "working", nextPollAt: Date.now() } : {}),
      expiresAt: Date.now() + 60_000,
    });
  }

  async function calls(fn: (commands: McpCallsCommands) => unknown): Promise<Outcome> {
    return capture(() => fn(new McpCallsCommands()));
  }

  /** `docs` open to anyone's turn on `main`, and a contact's turn granted its tools. */
  async function useDocsAsContact(): Promise<void> {
    await registerDocs({ agents: ["main"] });
    expect(
      (await capture((commands) => commands.set("docs", "any", undefined, "main", undefined, true, true))).error,
    ).toBeUndefined();
    useContactTurn([{ permission: "use", objectType: "tool", objectId: "mcp__docs__*", source: "test" }]);
  }

  it("lists every call for the operator and only the session's own calls for another turn, never a result", async () => {
    const mine = newCall("main-session");
    const other = newCall("other-session");
    updateMcpCall(mine.id, { result: { outcome: "ok", text: "remote secret text", truncated: false } }, {});

    const all = await calls((commands) => commands.list(undefined, undefined, undefined, "50", "0", true));
    expect(all.result).toMatchObject({ scope: "all", total: 2 });
    expect(JSON.stringify(all.result)).not.toContain("remote secret text");
    expect(JSON.stringify(all.result)).not.toContain("c_secret_person");

    await useDocsAsContact();
    const own = await calls((commands) => commands.list("open", undefined, "other-session", "50", "0", true));
    expect(own.result).toMatchObject({ scope: "session", total: 1, calls: [{ id: mine.id, state: "task" }] });

    const usage = contractOf(await calls((commands) => commands.list("maybe", undefined, undefined, "50", "0", true)));
    expect(usage).toMatchObject({ exitCode: 2, code: "USAGE_ERROR" });
    expect(other.id).not.toBe(mine.id);
  });

  it("cancels a call of the turn's own session at once; another session's call reads as not found", async () => {
    const mine = newCall("main-session");
    const other = newCall("other-session", "running");
    await useDocsAsContact();
    const cancelled = await calls((commands) => commands.cancel(mine.id, true));
    expect(cancelled.result).toMatchObject({ cancelRequested: true, call: { id: mine.id } });
    expect(getMcpCall(mine.id)?.cancelRequestedAt).not.toBeNull();

    const again = await calls((commands) => commands.cancel(mine.id, true));
    expect(again.result).toMatchObject({ cancelRequested: false });

    expect(contractOf(await calls((commands) => commands.cancel(other.id, true)))).toMatchObject({
      exitCode: 1,
      code: "MCP_CALL_NOT_FOUND",
    });
    expect(getMcpCall(other.id)?.cancelRequestedAt).toBeNull();
    expect(contractOf(await calls((commands) => commands.cancel("../x", true)))).toMatchObject({ exitCode: 2 });

    delete process.env.RAVI_CONTEXT_KEY;
    const operator = await calls((commands) => commands.cancel(other.id, true));
    expect(operator.result).toMatchObject({ cancelRequested: true });
    updateMcpCall(mine.id, { state: "delivered", outcome: "cancelled" }, {});
    const finished = await calls((commands) => commands.cancel(mine.id, true));
    expect(finished.result).toMatchObject({ cancelRequested: false, call: { state: "delivered" } });
  });

  it("refuses a turn that names no session, unless it is the operator's", async () => {
    newCall("main-session");
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      metadata: { actorPrincipal: "contact:c_ana", actorResolution: "resolved", executorAgentId: "main" },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    expect(
      contractOf(await calls((commands) => commands.list(undefined, undefined, undefined, "50", "0", true))),
    ).toMatchObject({ exitCode: 3, code: "OPERATOR_TURN_REQUIRED" });
  });

  it("show reports open calls and the last rate limit; remove ends the server's open calls", async () => {
    await registerDocs({ agents: ["main"] });
    const open = newCall("main-session");
    recordMcpServerRateLimit("docs", "tools/call", 2_000, 1_000);
    const shown = await capture((commands) => commands.show("docs", true));
    expect(shown.result).toMatchObject({
      calls: { open: 1, lastRateLimitedAt: 1_000, rateLimitedUntil: 2_000, rateLimitedMethod: "tools/call" },
    });
    const removed = await capture((commands) => commands.remove("docs", true));
    expect(removed.result).toMatchObject({ callsCancelled: 1 });
    expect(getMcpCall(open.id)?.cancelRequestedAt).not.toBeNull();
  });
});

describe("ravi mcp warnings and uploads", () => {
  it("warns about an agent on Claude without use tool:ToolSearch, and only that one", () => {
    const agents: Record<string, { provider?: string | null }> = {
      claudeAgent: { provider: "claude" },
      granted: { provider: "claude" },
      codexAgent: { provider: "codex" },
      byDefault: { provider: null },
    };
    const deps = {
      getAgent: (id: string) => agents[id] ?? null,
      defaultProvider: () => "claude",
      can: (id: string) => id === "granted",
    };
    const warnings = mcpToolSearchWarnings(["codexAgent", "granted", "claudeAgent", "byDefault", "missing"], deps);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toStartWith("Agent byDefault runs on Claude without use tool:ToolSearch");
    expect(warnings[1]).toStartWith("Agent claudeAgent runs on Claude");
    expect(mcpToolSearchWarnings(["byDefault"], { ...deps, defaultProvider: () => "codex" })).toEqual([]);
    expect(
      mcpToolSearchWarnings(["claudeAgent"], {
        ...deps,
        can: () => {
          throw new Error("unreadable");
        },
      }),
    ).toEqual([]);
  });

  it("reads the ToolSearch grant from each agent's own ceiling, without an injected checker", () => {
    dbCreateAgent({ id: "plain", cwd: stateDir as string, provider: "claude" });
    claudeAgentWithProfile("narrow", { profile: "explicit-only", capabilities: ["use:tool:mcp__docs__*"] });
    claudeAgentWithProfile("searcher", {
      profile: "explicit-only",
      capabilities: ["use:tool:ToolSearch", "use:tool:mcp__docs__*"],
    });
    claudeAgentWithProfile("broad", { profile: "full-access" });
    const warnings = mcpToolSearchWarnings(["plain", "narrow", "searcher", "broad"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("Agent narrow runs on Claude without use tool:ToolSearch");
  });

  it("show and attach carry the warnings; show reports the upload catalog and pinned skills", async () => {
    await registerDocs();
    claudeAgentWithProfile("helper", { profile: "explicit-only", capabilities: ["use:tool:mcp__docs__*"] });
    const dry = contractOf(await capture((commands) => commands.attach("docs", "helper", true)));
    expect(dry.exitCode).toBe(3);
    expect(JSON.stringify(dry.details)).toContain("use tool:ToolSearch");
    const attached = await capture((commands) => commands.attach("docs", "helper", true, true));
    expect(((attached.result?.warnings ?? []) as string[])[0]).toContain("Agent helper runs on Claude");

    recordMcpServerProbe("docs", {
      status: "ok",
      era: "modern",
      extensions: { "io.modelcontextprotocol/files": { upload: {} } },
      catalog: { tools: [{ name: "publish", exposedName: "mcp__docs__publish" }], dropped: [] },
      filesCatalog: {
        tools: [
          {
            name: "publish",
            exposedName: "mcp__docs__publish",
            fileArguments: [{ name: "files", multiple: true, maxItems: 10 }],
          },
        ],
        dropped: [{ name: "odd", reason: "the input schema has a file argument in a shape Ravi cannot map" }],
      },
    });
    const shown = await capture((commands) => commands.show("docs", true));
    expect(shown.result).toMatchObject({
      uploadCatalog: {
        tools: [{ name: "publish", exposedName: "mcp__docs__publish", fileArguments: ["files"] }],
        dropped: [{ name: "odd" }],
      },
      skills: [],
    });
    expect(JSON.stringify(shown.result)).toContain("Agent helper runs on Claude");
  });

  it("refuses uploads for a remote-spawn agent", async () => {
    await registerDocs();
    dbCreateAgent({ id: "far", cwd: stateDir as string, remote: "worker.example" });
    expect((await capture((commands) => commands.attach("docs", "far", true, true))).error).toBeUndefined();
    const refused = contractOf(
      await capture((commands) => commands.set("docs", undefined, "on", "far", undefined, true, true)),
    );
    expect(refused).toMatchObject({ exitCode: 3, code: "REMOTE_SPAWN_UPLOADS" });
    expect(getMcpAttachment("far", "docs")?.uploads).toBe(false);
  });
});

/**
 * The explicit-only examples the docs print for each runtime family (docs
 * guides/permissions and guides/mcp): applied with the real `ravi agents
 * permissions`, then checked with the same permission engine a turn meets
 * (the tool check, the Bash check and the command access check).
 */
describe("the documented explicit-only MCP examples", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const DOC_LINE = /^ravi agents permissions support explicit-only --capabilities '([^']+)' --execute$/;
  const CLAUDE_SHELL_ADDITION =
    "use:tool:Bash,execute:executable:ravi,read:mcp.calls:list,mutate:mcp.calls:cancel,read:mcp.skills:read";
  const MCP_TOOLS = extractTools([McpCommands, McpCallsCommands, McpSkillsCommands]);

  function documentedExamples(file: string): Record<string, string> {
    const lines = readFileSync(join(REPO, file), "utf8").split("\n");
    const examples: Record<string, string> = {};
    for (let index = 1; index < lines.length; index++) {
      const match = DOC_LINE.exec(lines[index] as string);
      const label = lines[index - 1] as string;
      if (match && label.startsWith("# ")) examples[label.slice(2)] = match[1] as string;
    }
    return examples;
  }

  async function applyExplicitOnly(agentId: string, provider: string, capabilities: string): Promise<void> {
    dbCreateAgent({ id: agentId, cwd: stateDir as string, provider });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await new AgentsCommands().permissions(agentId, "explicit-only", capabilities, true, undefined, true);
    } finally {
      console.log = originalLog;
    }
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      sessionName: `${agentId}-session`,
      capabilities: materializeSubjectCapabilities("agent", agentId),
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
  }

  function commandAllowed(toolName: string): boolean {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`no command exported as ${toolName}`);
    return enforceCliCommandAccess({
      group: tool.metadata.group,
      command: tool.metadata.command,
      access: tool.metadata.access,
      source: "cli",
    }).allowed;
  }

  function ceilingAllows(agentId: string, capability: string): boolean {
    const [permission, objectType, ...objectId] = capability.split(":");
    return canWithCapabilities(
      materializeSubjectCapabilities("agent", agentId),
      permission as string,
      objectType as string,
      objectId.join(":"),
    );
  }

  const FOLLOW = ["mcp_tools", "mcp_call", "mcp_calls_list", "mcp_calls_cancel"];

  it("prints the same three lines in both guides", () => {
    const permissions = documentedExamples("docs/guides/permissions.mdx");
    expect(Object.keys(permissions)).toEqual(["Claude Code", "Codex or Grok", "Pi"]);
    expect(documentedExamples("docs/guides/mcp.mdx")).toEqual(permissions);
    expect(readFileSync(join(REPO, "docs/guides/permissions.mdx"), "utf8")).toContain(CLAUDE_SHELL_ADDITION);
    for (const name of [...FOLLOW, "mcp_skills_read"]) {
      expect(MCP_TOOLS.find((tool) => tool.name === name)?.metadata.scope).toBe("open");
    }
  });

  it("Codex or Grok: a shell that runs ravi, the MCP commands and the github tools, nothing more", async () => {
    const line = documentedExamples("docs/guides/permissions.mdx")["Codex or Grok"] as string;
    for (const provider of ["codex", "grok"]) {
      const agentId = `${provider}-agent`;
      await applyExplicitOnly(agentId, provider, line);
      expect(canUseToolInContext({ agentId }, "Bash")).toBe(true);
      for (const command of [
        "ravi mcp tools github --json",
        `ravi mcp call github search_issues --input '{"q":"bug"}' --execute --json`,
        "ravi mcp calls list --state open --json",
        "ravi mcp calls cancel mc_0123 --json",
      ]) {
        expect(evaluateBashPermission(command, { agentId }).allowed).toBe(true);
      }
      expect(evaluateBashPermission("cat /etc/hosts", { agentId }).allowed).toBe(false);
      for (const name of FOLLOW) expect(commandAllowed(name)).toBe(true);
      expect(commandAllowed("mcp_skills_read")).toBe(false);
      expect(commandAllowed("mcp_attach")).toBe(false);
      expect(ceilingAllows(agentId, "use:tool:mcp__github__search_issues")).toBe(true);
      expect(ceilingAllows(agentId, "use:tool:mcp__slack__post")).toBe(false);
    }
  });

  it("Pi: its MCP tools and commands and the github tools, no shell", async () => {
    const line = documentedExamples("docs/guides/permissions.mdx").Pi as string;
    await applyExplicitOnly("pi-agent", "pi", line);
    for (const name of FOLLOW) {
      expect(ceilingAllows("pi-agent", `use:tool:${name}`)).toBe(true);
      expect(commandAllowed(name)).toBe(true);
    }
    expect(ceilingAllows("pi-agent", "use:tool:mcp_skills_read")).toBe(false);
    expect(ceilingAllows("pi-agent", "use:tool:Bash")).toBe(false);
    expect(ceilingAllows("pi-agent", "use:tool:mcp__github__search_issues")).toBe(true);
    expect(ceilingAllows("pi-agent", "use:tool:mcp__slack__post")).toBe(false);
  });

  it("Claude Code: ToolSearch and the github tools; the shell addition follows calls and reads skills", async () => {
    const line = documentedExamples("docs/guides/permissions.mdx")["Claude Code"] as string;
    await applyExplicitOnly("claude-agent", "claude", line);
    expect(ceilingAllows("claude-agent", "use:tool:ToolSearch")).toBe(true);
    expect(ceilingAllows("claude-agent", "use:tool:mcp__github__search_issues")).toBe(true);
    expect(ceilingAllows("claude-agent", "use:tool:Bash")).toBe(false);
    expect(mcpToolSearchWarnings(["claude-agent"])).toEqual([]);

    await applyExplicitOnly("claude-shell", "claude", `${line},${CLAUDE_SHELL_ADDITION}`);
    expect(canUseToolInContext({ agentId: "claude-shell" }, "Bash")).toBe(true);
    for (const command of [
      "ravi mcp calls cancel mc_0123 --json",
      "ravi mcp skills read docs/weekly --agent claude-shell --json",
    ]) {
      expect(evaluateBashPermission(command, { agentId: "claude-shell" }).allowed).toBe(true);
    }
    for (const name of ["mcp_calls_list", "mcp_calls_cancel", "mcp_skills_read"])
      expect(commandAllowed(name)).toBe(true);
  });

  it("without the command grants the floor would give, a Codex agent is refused before the MCP check", async () => {
    await applyExplicitOnly("bare", "codex", "use:tool:Bash,execute:executable:ravi,use:tool:mcp__github__*");
    expect(evaluateBashPermission("ravi mcp tools github --json", { agentId: "bare" }).allowed).toBe(true);
    expect(commandAllowed("mcp_tools")).toBe(false);
    expect(commandAllowed("mcp_call")).toBe(false);
  });
});
