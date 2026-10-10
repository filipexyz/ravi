import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { StepUpHandler } from "../../link/connectors.js";
import type { ContextRecord } from "../../router/router-db.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";
import { startHostCliGateway } from "../host-cli-gateway.js";
import { buildRegistry } from "../registry-snapshot.js";
import { dispatchRemote, remoteGatewayErrorToContractError } from "../remote-gateway.js";

// The default-connection paths of `ravi gmail`: the connections list is mocked
// so each case controls what Link answers, and exec is a recording spy. The
// approval flow itself runs against a fake Worker in src/link/connectors.test.ts.
const actualConnectorsModule = await import("../../link/connectors.js");
let listedConnections: Array<Record<string, unknown>> = [];
const execCalls: Array<Record<string, unknown>> = [];
const terminalArgs: unknown[] = [];
const stepUpArgs: Array<StepUpHandler | null> = [];
let execFailure: Error | null = null;
/** When set, the spy answers as a Worker asking for a step-up first. */
let askStepUp = false;
/** Whose account the turn uses, as `resolveConnectorExecPlan` would answer. */
let plannedMode: "owner" | "person_asking" | "shared" = "owner";
const planCalls: Array<Record<string, unknown>> = [];
let listCalls = 0;
mock.module("../../link/connectors.js", () => ({
  ...actualConnectorsModule,
  resolveConnectorExecPlan: (options: Record<string, unknown>) => {
    planCalls.push(options);
    return { mode: plannedMode, agentId: plannedMode === "owner" ? null : "main" };
  },
  listConnectors: async () => {
    listCalls += 1;
    return listedConnections;
  },
  execCapabilityWithApproval: async (
    input: Record<string, unknown>,
    _deps: unknown,
    terminal: unknown,
    stepUp: StepUpHandler | null = null,
  ) => {
    execCalls.push(input);
    terminalArgs.push(terminal);
    stepUpArgs.push(stepUp);
    if (askStepUp && stepUp) {
      await stepUp({
        challengeId: "chl_1",
        verificationUrl: "https://link.test/stepup/chl_1",
        expiresAt: "2026-10-10T12:05:00.000Z",
      });
    }
    if (execFailure) throw execFailure;
    return { result: { messages: [] }, capability: String(input.capability), refreshed: false };
  },
}));
const { GmailCommands } = await import("./gmail.js");

afterAll(() => mock.restore());

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gmail-cli-test-");
  listedConnections = [];
  execCalls.length = 0;
  terminalArgs.length = 0;
  stepUpArgs.length = 0;
  execFailure = null;
  askStepUp = false;
  plannedMode = "owner";
  planCalls.length = 0;
  listCalls = 0;
});

afterEach(async () => {
  execFailure = null;
  askStepUp = false;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function captureCloudError(fn: () => Promise<unknown>): Promise<CloudAuthError> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await fn();
  } catch (error) {
    if (error instanceof CloudAuthError) return error;
    throw error;
  } finally {
    console.log = originalLog;
  }
  throw new Error("expected the command to fail");
}

describe("gmail default connection", () => {
  it("asks for a connection when the person has no active Google connection", async () => {
    listedConnections = [
      { id: "gone", provider: "google", status: "revoked_by_user", requiresReauth: false, isDefault: true },
      { id: "gh", provider: "github", status: "active", requiresReauth: false },
    ];

    const error = await captureCloudError(() =>
      new GmailCommands().list(undefined, undefined, undefined, undefined, undefined, true),
    );
    const contract = cloudErrorToContractError("gmail list", error);

    expect(error.code).toBe("CONNECTOR_CONNECTION_REQUIRED");
    expect(contract.exitCode).toBe(1);
    expect(contract.envelope()).toMatchObject({
      success: false,
      op: "gmail list",
      error: {
        code: "CONNECTOR_CONNECTION_REQUIRED",
        message:
          "You have no active Google connection. Run `ravi connectors connect google` first, or pass --connector <id>.",
        retryable: false,
        suggestedAction:
          "ask the account owner to connect one on the Console Connectors page (`ravi connectors connect google`)",
      },
    });
    expect(execCalls).toHaveLength(0);
  });

  it("asks the owner, privately, to reconnect when only expired connections remain", async () => {
    listedConnections = [{ id: "stale", provider: "google", status: "active", requiresReauth: true }];

    const error = await captureCloudError(() => new GmailCommands().read("msg_1", undefined, undefined, true));
    const contract = cloudErrorToContractError("gmail read", error);

    expect(error.code).toBe("CONNECTOR_REAUTH_REQUIRED");
    expect(contract.exitCode).toBe(1);
    expect(contract.envelope()).toMatchObject({
      op: "gmail read",
      error: {
        code: "CONNECTOR_REAUTH_REQUIRED",
        message:
          'The Gmail connection expired. Tell the account owner privately, never in a group: "Your Gmail connection expired. Reconnect: console.ravi.bot/connectors"',
        chatLine: "Your Gmail connection expired. Reconnect: https://console.ravi.bot/connectors",
        replyTo: "owner_privately",
        reconnectLink: "https://console.ravi.bot/connectors",
        suggestedAction: "tell the account owner privately to reconnect it on the Console Connectors page",
      },
    });
    expect(execCalls).toHaveLength(0);
  });

  it("uses the active connection marked default", async () => {
    listedConnections = [
      { id: "newest", provider: "google", status: "active", requiresReauth: false, createdAt: "2026-10-01T00:00:00Z" },
      {
        id: "marked",
        provider: "google",
        status: "active",
        requiresReauth: false,
        isDefault: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    const originalLog = console.log;
    console.log = () => {};
    try {
      await new GmailCommands().list(undefined, undefined, undefined, undefined, undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ connectorId: "marked", capability: "gmail.message.list" });
  });
});

describe("gmail send approvals", () => {
  it("sends the approval id when the email is sent again after the owner approved", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      await send("apr_123");
    } finally {
      console.log = originalLog;
    }

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({
      connectorId: "conn_1",
      capability: "gmail.message.send",
      approvalId: "apr_123",
    });
  });

  it("rejects an approval id that is not one", async () => {
    const error = await captureCloudError(() => send("../x"));

    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(execCalls).toHaveLength(0);
  });

  it("hands the approval answer back (exit 3) outside the operator's terminal", async () => {
    execFailure = actualConnectorsModule.connectorApprovalError(
      new CloudAuthError("CONNECTOR_APPROVAL_REQUIRED", "Ravi Link request failed (409): connector_approval_required", {
        status: 409,
        details: { approvalId: "apr_9" },
      }),
      { consoleUrl: "https://console.ravi.bot", ownerName: "Luis" },
    );

    // A runtime session, so the answer is handed back even when the test runs in a TTY.
    const previousSession = process.env.RAVI_SESSION_NAME;
    process.env.RAVI_SESSION_NAME = "agent-session";
    let error: CloudAuthError;
    try {
      error = await captureCloudError(() => send());
    } finally {
      if (previousSession === undefined) delete process.env.RAVI_SESSION_NAME;
      else process.env.RAVI_SESSION_NAME = previousSession;
    }
    const contract = cloudErrorToContractError("gmail send", error);

    expect(execCalls).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      approvalId: "apr_9",
      approvalLink: "https://console.ravi.bot/connectors/approvals/apr_9",
      retryWith: "--approval apr_9",
      replyTo: "owner_privately",
    });
  });
  it("sends --approval on list and read too, for a read tool set to Needs approval", async () => {
    await quietly(() =>
      new GmailCommands().list(undefined, undefined, undefined, undefined, "conn_1", true, "apr_list"),
    );
    await quietly(() => new GmailCommands().read("msg_1", undefined, "conn_1", true, "apr_read"));

    expect(execCalls).toMatchObject([
      { capability: "gmail.message.list", approvalId: "apr_list" },
      { capability: "gmail.message.read", approvalId: "apr_read" },
    ]);
  });

  it("waits at the operator's terminal: stdin and stdout are TTYs and there is no runtime context", async () => {
    await withTerminal({ stdin: true, stdout: true }, {}, () => quietly(() => sendHuman()));

    expect(terminalArgs).toHaveLength(1);
    expect(terminalArgs[0]).toMatchObject({ openExternal: expect.any(Function) });
  });

  it("never waits at the operator's terminal for list and read: the approval answer comes back", async () => {
    await withTerminal({ stdin: true, stdout: true }, {}, () =>
      quietly(async () => {
        await new GmailCommands().list(undefined, undefined, undefined, undefined, "conn_1", false);
        await new GmailCommands().read("msg_1", undefined, "conn_1", false);
      }),
    );

    expect(execCalls).toMatchObject([{ capability: "gmail.message.list" }, { capability: "gmail.message.read" }]);
    expect(terminalArgs).toEqual([null, null]);
  });

  it.each([
    ["stdin is not a TTY", { stdin: false, stdout: true }, {}, false],
    ["stdout is not a TTY", { stdin: true, stdout: false }, {}, false],
    ["a runtime context key is set", { stdin: true, stdout: true }, { RAVI_CONTEXT_KEY: "rctx_x" }, false],
    ["--json is set", { stdin: true, stdout: true }, {}, true],
  ] as const)("does not wait when %s", async (_label, tty, env, asJson) => {
    await withTerminal(tty, env, () => quietly(() => (asJson ? send() : sendHuman())));

    expect(terminalArgs).toEqual([null]);
  });
});

describe("gmail for the person asking or a shared account", () => {
  it("lets the Worker pick the account: no connections list, no connection id, the planned mode pinned", async () => {
    plannedMode = "person_asking";

    await quietly(() => new GmailCommands().list(undefined, undefined, undefined, undefined, undefined, true));
    await quietly(() => send(undefined, { connector: null }));

    expect(listCalls).toBe(0);
    expect(planCalls).toEqual([{ provider: "google" }, { provider: "google" }]);
    expect(execCalls).toHaveLength(2);
    for (const call of execCalls) {
      expect(call.connectorId).toBeUndefined();
      expect(call.expectedMode).toBe("person_asking");
      expect(call.useShared).toBeUndefined();
    }
  });

  it("refuses --connector, which would name one of the owner's own connections", async () => {
    plannedMode = "shared";

    const error = await captureCloudError(() => new GmailCommands().read("msg_1", undefined, "conn_1", true));

    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("without --connector");
    expect(execCalls).toHaveLength(0);
  });

  it("passes --shared to the plan and to the exec", async () => {
    plannedMode = "shared";

    await quietly(() => send(undefined, { connector: null, shared: true }));

    expect(planCalls).toEqual([{ provider: "google", useShared: true }]);
    expect(execCalls[0]).toMatchObject({ capability: "gmail.message.send", expectedMode: "shared", useShared: true });
    expect(execCalls[0]?.connectorId).toBeUndefined();
  });

  it("keeps the owner's default connection and pins owner mode on the owner's own turn", async () => {
    listedConnections = [{ id: "mine", provider: "google", status: "active", requiresReauth: false }];

    await quietly(() => new GmailCommands().read("msg_1", undefined, undefined, true));

    expect(listCalls).toBe(1);
    expect(execCalls[0]).toMatchObject({ connectorId: "mine", expectedMode: "owner" });
  });

  it("still brakes send without --execute before it looks at the turn", async () => {
    const error = await quietly(async () =>
      new GmailCommands()
        .send("bob@example.com", undefined, undefined, "Oi", "Corpo", undefined, undefined, undefined, true)
        .then(
          () => null,
          (e: unknown) => e,
        ),
    );

    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).exitCode).toBe(3);
    expect(planCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });
});

describe("gmail send for an agent, through the host gateway", () => {
  const APPROVAL_ID = "3f2c8a1e-5b6d-4c7e-9f00-1a2b3c4d5e6f";
  const agentContext: ContextRecord = {
    contextId: "ctx_gmail_agent",
    contextKey: "rctx_gmail_agent",
    kind: "test-runtime",
    agentId: "main",
    capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
    createdAt: Date.now(),
  };

  it("has a gateway route, so an agent turn (which always goes through the gateway) can run it", () => {
    const routes = buildRouteTable(buildRegistry([GmailCommands])).byPath;

    expect(routes.has("/api/v1/gmail/send")).toBe(true);
    expect(routes.has("/api/v1/gmail/list")).toBe(true);
    expect(routes.has("/api/v1/gmail/read")).toBe(true);
  });

  it("exits 3 with the approval id, page, expiry and re-run flag when the owner must approve", async () => {
    execFailure = actualConnectorsModule.connectorApprovalError(
      new CloudAuthError("CONNECTOR_APPROVAL_REQUIRED", "Ravi Link request failed (409): connector_approval_required", {
        status: 409,
        details: { approvalId: APPROVAL_ID, expiresAt: "2026-10-10T12:15:00.000Z" },
      }),
      { consoleUrl: "https://console.ravi.bot", ownerName: "Luis" },
    );
    const socketPath = join(stateDir!, "gmail-gateway.sock");
    const gateway = await startHostCliGateway({
      socketPath,
      gateway: {
        registry: buildRegistry([GmailCommands]),
        auth: { resolveContext: (key) => (key === agentContext.contextKey ? agentContext : null) },
      },
    });
    if (!gateway) throw new Error("the host CLI gateway did not start");
    let answer: Awaited<ReturnType<typeof dispatchRemote>>;
    let child: { code: number; stdout: string; stderr: string };
    try {
      answer = await dispatchRemote({
        groupSegments: ["gmail"],
        command: "send",
        body: {
          to: "bob@example.com",
          subject: "Oi",
          body: "Corpo",
          connector: "conn_1",
          execute: true,
        },
        config: { url: `unix://${socketPath}`, source: "env", socketPath },
        contextKey: agentContext.contextKey,
      });
      // The same call as an agent shell makes it: a CLI process with the
      // turn's context key, dispatched by the registry to the host gateway.
      child = await runAgentCli(socketPath, agentContext.contextKey, [
        "gmail",
        "send",
        "--to",
        "bob@example.com",
        "--subject",
        "Oi",
        "--body",
        "Corpo",
        "--connector",
        "conn_1",
        "--execute",
        "--json",
      ]);
    } finally {
      await gateway.stop();
    }
    const error = remoteGatewayErrorToContractError("gmail send", answer);

    // The gateway is never the operator's own terminal: the answer comes back.
    expect(terminalArgs).toEqual([null, null]);
    expect(execCalls).toMatchObject([
      { connectorId: "conn_1", capability: "gmail.message.send" },
      { connectorId: "conn_1", capability: "gmail.message.send" },
    ]);
    expect(error?.exitCode).toBe(3);
    expect(error?.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      approvalId: APPROVAL_ID,
      approvalLink: `https://console.ravi.bot/connectors/approvals/${APPROVAL_ID}`,
      expiresAt: "2026-10-10T12:15:00.000Z",
      retryWith: `--approval ${APPROVAL_ID}`,
      replyTo: "owner_privately",
    });
    expect(error?.message).toContain("never in a group");

    expect(child.code).toBe(3);
    expect(child.stderr).not.toContain("rctx_");
    expect(JSON.parse(child.stdout)).toMatchObject({
      success: false,
      op: "gmail send",
      error: {
        code: "CONNECTOR_APPROVAL_REQUIRED",
        approvalId: APPROVAL_ID,
        approvalLink: `https://console.ravi.bot/connectors/approvals/${APPROVAL_ID}`,
        retryWith: `--approval ${APPROVAL_ID}`,
      },
    });
  }, 20_000);

  it("never answers a step-up from a runtime turn: no browser, no stdin, exit 3", async () => {
    askStepUp = true;
    let error: unknown;
    await withTerminal({ stdin: true, stdout: true }, { RAVI_SESSION_NAME: "agent-session" }, () =>
      quietly(async () => {
        error = await send().catch((e) => e);
      }),
    );

    expect(stepUpArgs[0]).toBeFunction();
    expect(error).toBeInstanceOf(ContractError);
    expect(error).toMatchObject({ code: "INTERACTIVE_ONLY", exitCode: 3 });
  });
});

/** Run `ravi <args>` in a child process the way an agent shell does, against the host gateway socket. */
async function runAgentCli(
  socketPath: string,
  contextKey: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(stateDir!, "gmail-agent-cli.ts");
  writeFileSync(
    entry,
    [
      'import "reflect-metadata";',
      'import { Command } from "commander";',
      `import { GmailCommands } from ${JSON.stringify(join(import.meta.dir, "gmail.ts"))};`,
      `import { registerCommands } from ${JSON.stringify(join(import.meta.dir, "../registry.ts"))};`,
      "const program = new Command();",
      "registerCommands(program, [GmailCommands]);",
      "await program.parseAsync();",
    ].join("\n"),
  );
  const child = spawn({
    cmd: [process.execPath, entry, ...args],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, RAVI_CONTEXT_KEY: contextKey, RAVI_GATEWAY_URL: `unix://${socketPath}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function send(approval?: string, options: { connector?: string | null; shared?: boolean } = {}) {
  return new GmailCommands().send(
    "bob@example.com",
    undefined,
    undefined,
    "Oi",
    "Corpo",
    undefined,
    undefined,
    options.connector === null ? undefined : (options.connector ?? "conn_1"),
    true,
    approval,
    options.shared,
    true,
  );
}

function sendHuman() {
  return new GmailCommands().send(
    "bob@example.com",
    undefined,
    undefined,
    "Oi",
    "Corpo",
    undefined,
    undefined,
    "conn_1",
    false,
    undefined,
    undefined,
    true,
  );
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const RUNTIME_ENV = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_TRIGGER_ID",
  "RAVI_AUTOMATION_PRINCIPAL",
];

async function withTerminal<T>(
  tty: { stdin: boolean; stdout: boolean },
  env: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  for (const name of RUNTIME_ENV) delete process.env[name];
  Object.assign(process.env, env);
  Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restoreProperty(process.stdin, "isTTY", stdinTty);
    restoreProperty(process.stdout, "isTTY", stdoutTty);
  }
}

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete (target as Record<string, unknown>)[key];
}
