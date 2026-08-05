import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runWithContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { createRuntimeContext, getContextLineage } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { maybeRunAppAliasRoute, resolveAppAliasInvocation, runAppOperation } from "./router.js";

const tempRoots: string[] = [];
const tempStateDirs: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;
const CONTEXT_ENV_KEYS = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
] as const;
const originalContextEnv = new Map<string, string | undefined>(CONTEXT_ENV_KEYS.map((key) => [key, process.env[key]]));

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-app-router-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  const stateDir = join(root, ".state");
  tempStateDirs.push(stateDir);
  process.env.RAVI_STATE_DIR = stateDir;
  for (const key of CONTEXT_ENV_KEYS) delete process.env[key];
  process.chdir(root);
  return root;
}

function writeManifest(root: string, id: string, body: Record<string, unknown>): void {
  const dir = join(root, "src", "apps", ...id.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ravi.app.json"), JSON.stringify(body, null, 2));
}

function manifest(id: string): Record<string, unknown> {
  const prefix = id.replace(/\//g, ".");
  return {
    schema: "ravi.app/v1",
    id,
    name: "Khal Tasks",
    version: "0.1.0",
    description: "Manage Khal tasks.",
    interfaces: {
      cli: {
        command: `ravi ${id.split("/").join(" ")}`,
        json: true,
        health: `ravi ${id.split("/").join(" ")} check --json`,
      },
    },
    context: {
      allow: [],
    },
    operations: {
      [`${prefix}.list`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: false,
      },
      [`${prefix}.check`]: {
        interface: "builtin",
        handler: "apps.manifest.check",
        mutating: false,
      },
      [`${prefix}.create`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: true,
        permission: `${id}:write`,
      },
      [`${prefix}.test.a`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: false,
      },
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [`${id}:write`],
    },
    health: {
      checks: [{ type: "builtin", handler: "apps.manifest.check" }],
    },
  };
}

function appCapability(permission: "use" | "execute", appId = "khal-tasks"): ContextCapability {
  return { permission, objectType: "app", objectId: appId };
}

function appToolContext(capabilities: ContextCapability[]): { agentId: string; context: ContextRecord } {
  return {
    agentId: "app-agent",
    context: {
      contextId: "ctx_app_router",
      contextKey: "ctx_key_app_router",
      kind: "test-runtime",
      agentId: "app-agent",
      capabilities,
      metadata: {},
      createdAt: 0,
    },
  };
}

function writeProviderScript(root: string): string {
  const path = join(root, "permission-provider.mjs");
  writeFileSync(
    path,
    `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const requestText = Buffer.concat(chunks).toString("utf8");
const request = requestText.trim() ? JSON.parse(requestText) : null;
if (process.env.PROVIDER_REQUEST_PATH) {
  await Bun.write(process.env.PROVIDER_REQUEST_PATH, JSON.stringify(request, null, 2));
}
if (process.env.PROVIDER_ENV_PATH) {
  await Bun.write(process.env.PROVIDER_ENV_PATH, JSON.stringify({
    RAVI_CONTEXT_KEY: process.env.RAVI_CONTEXT_KEY ?? null,
    API_TOKEN: process.env.API_TOKEN ?? null,
    SAFE_PROVIDER_FLAG: process.env.SAFE_PROVIDER_FLAG ?? null,
    PATH: process.env.PATH ? "present" : null
  }, null, 2));
}
if (process.env.PROVIDER_SLEEP_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PROVIDER_SLEEP_MS)));
}
if (process.env.PROVIDER_EXIT_CODE) {
  process.exit(Number(process.env.PROVIDER_EXIT_CODE));
}
if (process.env.PROVIDER_INVALID_JSON === "1") {
  console.log("not json");
  process.exit(0);
}
const decision = process.env.PROVIDER_DECISION || "allow";
console.log(JSON.stringify({
  schema: process.env.PROVIDER_SCHEMA || "ravi.app.permission.decision/v1",
  decision,
  reasonCode: process.env.PROVIDER_REASON_CODE || decision + "_test",
  reason: "provider test decision",
  visibility: decision === "allow" ? "visible" : "hidden",
  resource: { type: "app-operation", id: request?.operation?.id || "unknown" },
  grantSuggestion: decision === "needs_grant" ? {
    subject: { type: "contact", id: "contact_luis" },
    relation: "use",
    object: { type: "app-resource", id: "khal-tasks:list" },
    ttlSec: 900,
    reason: "test grant suggestion"
  } : null,
  audit: { policyVersion: "test", evidence: ["request:" + request?.schema] },
  cache: { ttlSec: 60 }
}));
`,
    "utf8",
  );
  return path;
}

function writeContextProbeApp(root: string): { appDir: string; scriptPath: string } {
  const appDir = join(root, "src", "apps", "probe-app");
  const scriptPath = join(appDir, "app-cli.mjs");
  const cliEntrypoint = resolve(originalCwd, "src", "cli", "index.ts");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    scriptPath,
    `
const whoami = Bun.spawnSync({
  cmd: [process.execPath, ${JSON.stringify(cliEntrypoint)}, "context", "whoami", "--json"],
  cwd: process.cwd(),
  env: process.env,
  stdout: "pipe",
  stderr: "pipe"
});
const stdout = new TextDecoder().decode(whoami.stdout).trim();
const stderr = new TextDecoder().decode(whoami.stderr).trim();
if (whoami.exitCode !== 0) {
  console.error(stderr || "context whoami failed");
  process.exit(whoami.exitCode || 1);
}
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    childContextPresent: Boolean(process.env.RAVI_CONTEXT_KEY),
    RAVI_SESSION_KEY: process.env.RAVI_SESSION_KEY ?? null,
    RAVI_SESSION_NAME: process.env.RAVI_SESSION_NAME ?? null,
    RAVI_AGENT_ID: process.env.RAVI_AGENT_ID ?? null,
    APP_SECRET: process.env.APP_SECRET ?? null,
    RAVI_APP_ID: process.env.RAVI_APP_ID ?? null,
    RAVI_APP_OPERATION_ID: process.env.RAVI_APP_OPERATION_ID ?? null,
    RAVI_APP_ROOT: process.env.RAVI_APP_ROOT ?? null
  },
  whoami: JSON.parse(stdout)
}));
`,
    "utf8",
  );
  writeManifest(root, "probe-app", {
    schema: "ravi.app/v1",
    id: "probe-app",
    name: "Context Probe App",
    version: "0.1.0",
    description: "Prove bounded Ravi App child-context execution.",
    interfaces: {
      cli: {
        command: "bun app-cli.mjs",
        json: true,
      },
    },
    context: {
      allow: ["execute:group:context"],
    },
    operations: {
      "probe-app.inspect": {
        interface: "cli",
        command: "bun app-cli.mjs inspect {args}",
        json: true,
        mutating: false,
      },
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [],
    },
    health: {
      checks: [{ type: "builtin", handler: "apps.manifest.check" }],
    },
  });
  return { appDir, scriptPath };
}

function providerManifest(root: string, id: string, options: { timeoutMs?: number } = {}): Record<string, unknown> {
  const providerScript = writeProviderScript(root);
  const base = manifest(id);
  const prefix = id.replace(/\//g, ".");
  const baseOperations = base.operations as Record<string, unknown>;
  return {
    ...base,
    operations: {
      ...baseOperations,
      [`${prefix}.list`]: {
        ...(baseOperations[`${prefix}.list`] as Record<string, unknown>),
        authorization: {
          resource: { type: "task-list", idFromOption: "project", ownerFrom: "actor" },
          input: { includeArgs: true, includeOptions: ["project"] },
        },
      },
      [`${prefix}.permissions.decide`]: {
        interface: "cli",
        command: `bun ${providerScript} --json`,
        mutating: false,
        inputSchema: "schemas/permission-request.v1.json",
        outputSchema: "schemas/permission-decision.v1.json",
      },
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [`${id}:write`],
      provider: {
        id: `${id}.local`,
        version: "2026-06-13",
        interface: "cli",
        operation: `${prefix}.permissions.decide`,
        decisionSchema: "schemas/permission-decision.v1.json",
        requestSchema: "schemas/permission-request.v1.json",
        timeoutMs: options.timeoutMs ?? 1000,
        cacheTtlSec: 30,
        failClosed: true,
        scope: ["visibility", "operation", "resource"],
      },
    },
  };
}

async function captureJson(fn: () => Promise<unknown>): Promise<unknown> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    await fn();
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
  }
}

afterEach(async () => {
  process.chdir(originalCwd);
  while (tempStateDirs.length > 0) {
    await cleanupIsolatedRaviState(tempStateDirs.pop());
  }
  if (originalStateDir === undefined) {
    delete process.env.RAVI_STATE_DIR;
  } else {
    process.env.RAVI_STATE_DIR = originalStateDir;
  }
  for (const key of CONTEXT_ENV_KEYS) {
    const value = originalContextEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("Ravi app router", () => {
  it("runs builtin app operations through the canonical app route", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const result = await runAppOperation({
      appId: "khal-tasks",
      operation: "check",
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operation: "check",
      operationId: "khal-tasks.check",
      interface: "builtin",
      handler: "apps.manifest.check",
    });
    expect(result.result).toMatchObject({ ok: true, checked: 1 });
  });

  it("prefers declared operations over virtual router builtins", async () => {
    const root = makeRepo();
    const body = manifest("khal-tasks");
    (body.operations as Record<string, unknown>)["khal-tasks.show"] = {
      interface: "builtin",
      handler: "apps.stub.list",
      mutating: false,
    };
    writeManifest(root, "khal-tasks", body);

    const result = await runAppOperation({
      appId: "khal-tasks",
      operation: "show",
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operation: "show",
      operationId: "khal-tasks.show",
      interface: "builtin",
      handler: "apps.stub.list",
    });
    expect(result.result).toMatchObject({ total: 0, items: [] });
  });

  it("resolves dynamic root aliases without stealing static root commands", () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));
    writeManifest(root, "apps", manifest("apps"));

    expect(
      resolveAppAliasInvocation(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toEqual({
      appId: "khal-tasks",
      operation: "check",
      args: [],
      json: true,
    });
    expect(
      resolveAppAliasInvocation(["apps", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toBe(null);
    expect(
      resolveAppAliasInvocation(["unknown", "check"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toBe(null);
  });

  it("runs dynamic root aliases as JSON when an app id is discovered", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const payload = (await captureJson(() =>
      maybeRunAppAliasRoute(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    )) as { ok: boolean; appId: string; operationId: string };

    expect(payload).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operationId: "khal-tasks.check",
    });
  });

  it("runs relative CLI operations from the app manifest directory", async () => {
    const root = makeRepo();
    const body = manifest("khal-tasks");
    (body.operations as Record<string, unknown>)["khal-tasks.cwd"] = {
      interface: "cli",
      command: "bun cwd-probe.mjs --json",
      mutating: false,
    };
    writeManifest(root, "khal-tasks", body);

    const appDir = join(root, "src", "apps", "khal-tasks");
    writeFileSync(
      join(appDir, "cwd-probe.mjs"),
      "console.log(JSON.stringify({ cwd: process.cwd(), appRoot: process.env.RAVI_APP_ROOT }))",
    );

    const result = await runAppOperation({
      appId: "khal-tasks",
      operation: "cwd",
      json: true,
      cwd: root,
    });

    expect(result).toMatchObject({
      ok: true,
      operationId: "khal-tasks.cwd",
      result: { appRoot: appDir },
    });
    expect(realpathSync((result.result as { cwd: string }).cwd)).toBe(realpathSync(appDir));
  });

  it("runs an external CLI through the public alias with a least-privilege child context", () => {
    const root = makeRepo();
    const { appDir } = writeContextProbeApp(root);
    const cliEntrypoint = resolve(originalCwd, "src", "cli", "index.ts");
    const markerPath = join(root, "shell-injection-marker");
    const injectionArg = `$(touch ${markerPath})`;
    const parent = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      capabilities: [
        { permission: "use", objectType: "app", objectId: "probe-app" },
        { permission: "execute", objectType: "group", objectId: "context" },
      ],
    });

    const run = spawnSync(
      process.execPath,
      [cliEntrypoint, "probe-app", "inspect", injectionArg, ";", "literal value", "--json"],
      {
        cwd: root,
        env: {
          ...process.env,
          RAVI_CONTEXT_KEY: parent.contextKey,
          RAVI_SESSION_KEY: "legacy-session",
          RAVI_SESSION_NAME: "legacy-name",
          RAVI_AGENT_ID: "legacy-agent",
          APP_SECRET: "must-not-leak",
          RAVI_LOG_LEVEL: "error",
          RAVI_CLI_LOG_LEVEL: "error",
          RAVI_SUPPRESS_AUDIT_EVENTS: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("must-not-leak");
    const payload = JSON.parse(run.stdout) as {
      ok: boolean;
      callerContextId: string;
      childContextId: string;
      result: {
        argv: string[];
        cwd: string;
        env: Record<string, unknown>;
        whoami: {
          contextId: string;
          kind: string;
          capabilities: ContextCapability[];
          metadata: Record<string, unknown>;
          lineage: Record<string, unknown>;
        };
      };
    };

    expect(payload).toMatchObject({
      ok: true,
      callerContextId: parent.contextId,
      result: {
        argv: ["inspect", injectionArg, ";", "literal value"],
        env: {
          childContextPresent: true,
          RAVI_SESSION_KEY: null,
          RAVI_SESSION_NAME: null,
          RAVI_AGENT_ID: null,
          APP_SECRET: null,
          RAVI_APP_ID: "probe-app",
          RAVI_APP_OPERATION_ID: "probe-app.inspect",
          RAVI_APP_ROOT: realpathSync(appDir),
        },
        whoami: {
          kind: "app-runtime",
          capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
          metadata: {
            appId: "probe-app",
            operationId: "probe-app.inspect",
            source: "app-router",
            parentContextId: parent.contextId,
            issuedFor: "app:probe-app",
            issuanceMode: "explicit",
          },
          lineage: {
            parentContextId: parent.contextId,
            issuedFor: "app:probe-app",
            issuanceMode: "explicit",
          },
        },
      },
    });
    expect(payload.childContextId).not.toBe(parent.contextId);
    expect(payload.result.whoami.contextId).toBe(payload.childContextId);
    expect(realpathSync(payload.result.cwd)).toBe(realpathSync(appDir));
    expect(existsSync(markerPath)).toBe(false);
    expect(run.stdout).not.toContain(parent.contextKey);

    const lineage = getContextLineage(parent.contextId);
    expect(lineage?.descendants.map((context) => context.contextId)).toContain(payload.childContextId);
  }, 30_000);

  it("fails before spawning when context.allow exceeds the caller context", async () => {
    const root = makeRepo();
    const { scriptPath } = writeContextProbeApp(root);
    const markerPath = join(root, "should-not-spawn");
    writeFileSync(
      scriptPath,
      `await Bun.write(${JSON.stringify(markerPath)}, "spawned"); console.log(JSON.stringify({ ok: true }));\n`,
      "utf8",
    );
    const parent = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      capabilities: [{ permission: "use", objectType: "app", objectId: "probe-app" }],
    });

    const result = await runWithContext({ agentId: "main", context: parent }, () =>
      runAppOperation({
        appId: "probe-app",
        operation: "inspect",
        args: ["literal"],
        json: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Capability not granted by parent context: execute:group:context");
    expect(result.childContextId).toBeUndefined();
    expect(existsSync(markerPath)).toBe(false);
  });

  it("resolves dotted operation ids from whitespace-separated CLI tokens", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const payload = (await captureJson(() =>
      maybeRunAppAliasRoute(["khal-tasks", "test", "a", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    )) as { ok: boolean; appId: string; operation: string; operationId: string };

    expect(payload).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operation: "test.a",
      operationId: "khal-tasks.test.a",
    });
  });

  it("hides dynamic root aliases without app use permission", () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const denied = runWithContext({ agentId: "app-agent" }, () =>
      resolveAppAliasInvocation(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    );
    expect(denied).toBe(null);

    const allowed = runWithContext(appToolContext([appCapability("use")]), () =>
      resolveAppAliasInvocation(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    );
    expect(allowed).toEqual({
      appId: "khal-tasks",
      operation: "check",
      args: [],
      json: true,
    });
  });

  it("requires app use permission in agent context", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const denied = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "check",
        json: true,
      }),
    );

    expect(denied).toMatchObject({
      ok: false,
      appId: "khal-tasks",
    });
    expect(denied.error).toBe("App not found: khal-tasks");

    const allowed = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "check",
        json: true,
      }),
    );

    expect(allowed.ok).toBe(true);
  });

  it("does not leak invalid hidden app manifests before app use permission", async () => {
    const root = makeRepo();
    writeManifest(root, "hidden-invalid", {
      schema: "ravi.app/v1",
      id: "hidden-invalid",
      name: "Hidden Invalid",
      version: "0.1.0",
      description: "Invalid app that should stay hidden.",
      interfaces: {},
      operations: {},
    });

    const denied = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "hidden-invalid",
        operation: "check",
        json: true,
      }),
    );

    expect(denied).toMatchObject({
      ok: false,
      appId: "hidden-invalid",
    });
    expect(denied.error).toBe("App not found: hidden-invalid");
    expect(denied.error).not.toContain("App manifest is invalid");
  });

  it("requires app execute permission for mutating app operations", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const denied = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
      }),
    );

    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("requires execute on app:khal-tasks");

    const allowed = await runWithContext(appToolContext([appCapability("use"), appCapability("execute")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
      }),
    );

    expect(allowed.ok).toBe(true);
  });

  it("calls an app permission provider after core app permission allows", async () => {
    const root = makeRepo();
    const requestPath = join(root, "provider-request.json");
    const envPath = join(root, "provider-env.json");
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks"));

    const source = { channel: "whatsapp", accountId: "main", chatId: "chat_group_1" };
    const result = await runWithContext(
      {
        contextId: "ctx_test",
        agentId: "app-agent",
        sessionKey: "session_1",
        sessionName: "main",
        source,
        context: {
          contextId: "ctx_test",
          contextKey: "rctx_secret_must_not_leak",
          kind: "turn",
          agentId: "app-agent",
          sessionKey: "session_1",
          sessionName: "main",
          source,
          capabilities: [{ permission: "use", objectType: "app", objectId: "khal-tasks" }],
          metadata: {
            authorityMode: "agent",
            executorAgentId: "app-agent",
            actorPrincipal: "contact:luis",
            surfacePrincipal: "chat:chat_group_1",
            turnCapabilities: [{ permission: "use", objectType: "app", objectId: "khal-tasks" }],
          },
          createdAt: Date.now(),
        },
      },
      () =>
        runAppOperation({
          appId: "khal-tasks",
          operation: "list",
          args: ["task-123", "--project", "ravi", "--token", "token_secret_must_not_leak"],
          json: true,
          env: {
            ...process.env,
            PROVIDER_REQUEST_PATH: requestPath,
            PROVIDER_ENV_PATH: envPath,
            RAVI_CONTEXT_KEY: "rctx_env_must_not_leak",
            API_TOKEN: "token_env_must_not_leak",
            SAFE_PROVIDER_FLAG: "safe",
          },
        }),
    );

    expect(result.ok).toBe(true);
    expect(result.permissionProvider).toMatchObject({
      providerId: "khal-tasks.local",
      providerVersion: "2026-06-13",
      providerOperationId: "khal-tasks.permissions.decide",
      decision: "allow",
      reasonCode: "allow_test",
      cache: { hit: false, ttlSec: 30 },
    });

    const requestText = readFileSync(requestPath, "utf8");
    expect(requestText).not.toContain("rctx_secret_must_not_leak");
    const request = JSON.parse(requestText) as {
      schema: string;
      operation: { id: string; action: string };
      resource: { type: string; id: string; owner?: { type: string; id: string } };
      input: { args: string[]; options: Record<string, unknown>; rawArgCount: number; redacted: boolean };
      context: {
        actor: { type: string; id: string };
        surface: { type: string; id: string };
        executorAgent: { id: string };
      };
      core: { appBoundary: string; agentCeiling: string; surfaceConstraint: string };
    };
    expect(request).toMatchObject({
      schema: "ravi.app.permission.request/v1",
      operation: { id: "khal-tasks.list", action: "list" },
      resource: {
        type: "task-list",
        id: "ravi",
        owner: { type: "contact", id: "luis" },
      },
      input: {
        args: ["task-123"],
        options: { project: "ravi" },
        rawArgCount: 5,
        redacted: true,
      },
      context: {
        actor: { type: "contact", id: "luis" },
        surface: { type: "chat", id: "chat_group_1" },
        executorAgent: { id: "app-agent" },
      },
      core: { appBoundary: "allow", agentCeiling: "allow", surfaceConstraint: "allow" },
    });
    expect(requestText).not.toContain("token_secret_must_not_leak");
    expect(requestText).not.toContain("rctx_env_must_not_leak");

    const envSnapshot = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, unknown>;
    expect(envSnapshot).toMatchObject({
      RAVI_CONTEXT_KEY: null,
      API_TOKEN: null,
      SAFE_PROVIDER_FLAG: "safe",
      PATH: "present",
    });
  });

  it("does not expose the provider operation as a direct app operation", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks"));

    const direct = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "permissions.decide",
        json: true,
      }),
    );
    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("reserved for app permission provider decisions");

    const help = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "help",
        json: true,
      }),
    );
    expect(help.ok).toBe(true);
    const result = help.result as { operations: string[] };
    expect(result.operations).not.toContain("khal-tasks.permissions.decide");
  });

  it("does not call the provider when core app permission denies", async () => {
    const root = makeRepo();
    const requestPath = join(root, "provider-request.json");
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks"));

    const result = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "list",
        json: true,
        env: { ...process.env, PROVIDER_REQUEST_PATH: requestPath },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("App not found: khal-tasks");
    expect(existsSync(requestPath)).toBe(false);
    expect(result.permissionProvider).toBeUndefined();
  });

  it("does not let provider allow bypass missing execute on mutating operations", async () => {
    const root = makeRepo();
    const requestPath = join(root, "provider-request.json");
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks"));

    const result = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
        env: { ...process.env, PROVIDER_REQUEST_PATH: requestPath },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires execute on app:khal-tasks");
    expect(existsSync(requestPath)).toBe(false);
    expect(result.permissionProvider).toBeUndefined();
  });

  it("denies provider deny, needs_grant, and not_applicable decisions", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks"));

    for (const decision of ["deny", "needs_grant", "not_applicable"] as const) {
      const result = await runWithContext(appToolContext([appCapability("use")]), () =>
        runAppOperation({
          appId: "khal-tasks",
          operation: "list",
          json: true,
          env: { ...process.env, PROVIDER_DECISION: decision },
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Permission denied by app permission provider khal-tasks.local");
      expect(result.permissionProvider).toMatchObject({
        decision,
        reasonCode: `${decision}_test`,
      });
      if (decision === "needs_grant") {
        expect(result.permissionProvider?.grantSuggestion).toMatchObject({
          relation: "use",
          ttlSec: 900,
        });
      }
    }
  });

  it("fails closed on provider invalid JSON and timeout", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks", { timeoutMs: 250 }));

    const invalidJson = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "list",
        json: true,
        env: { ...process.env, PROVIDER_INVALID_JSON: "1" },
      }),
    );
    expect(invalidJson.ok).toBe(false);
    expect(invalidJson.permissionProvider).toMatchObject({
      decision: "invalid",
      reasonCode: "provider_invalid_json",
    });

    const timeout = await runWithContext(appToolContext([appCapability("use")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "list",
        json: true,
        env: { ...process.env, PROVIDER_SLEEP_MS: "1000" },
      }),
    );
    expect(timeout.ok).toBe(false);
    expect(timeout.permissionProvider).toMatchObject({
      decision: "error",
      reasonCode: "provider_timeout",
    });
  });
});
