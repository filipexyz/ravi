import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { maybeRunAppAliasRoute, resolveAppAliasInvocation, resolveRaviCliCommand, runAppOperation } from "./router.js";

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
        safety: {
          idempotent: false,
          dryRunSupported: true,
          confirmationRequired: true,
          liveExecution: true,
          risk: "high",
        },
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
      mutating: [],
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

function providerManifest(root: string, id: string, options: { timeoutMs?: number } = {}): Record<string, unknown> {
  const providerScript = writeProviderScript(root);
  const schemaDirectory = join(root, "src", "apps", ...id.split("/"), "schemas");
  mkdirSync(schemaDirectory, { recursive: true });
  writeFileSync(join(schemaDirectory, "permission-request.v1.json"), JSON.stringify({ type: "object" }, null, 2));
  writeFileSync(join(schemaDirectory, "permission-decision.v1.json"), JSON.stringify({ type: "object" }, null, 2));
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

function writeOperationProbe(root: string): string {
  const directory = join(root, "src", "apps", "runtime-probe");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "operation-probe.mjs");
  writeFileSync(
    path,
    `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
const marker = process.env.PROBE_MARKER;
if (marker) appendFileSync(marker, mode + " " + args.join(" ") + "\\n");

if (mode === "timeout") {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (mode === "timeout-tree") {
  spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.env.PROBE_DESCENDANT_MARKER, 'orphan'), 200)"], {
    env: process.env,
    stdio: "ignore"
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (mode === "invalid-json") {
  console.log("not-json");
  process.exit(0);
}
if (mode === "retry") {
  const countPath = process.env.PROBE_COUNT;
  const count = countPath && existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  const failuresBeforeSuccess = Number(process.env.PROBE_FAIL_ATTEMPTS || "2");
  if (countPath) writeFileSync(countPath, String(count));
  if (count <= failuresBeforeSuccess) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: "upstream unavailable",
      errorDetails: {
        code: "UPSTREAM_503",
        message: "upstream unavailable",
        retryable: true,
        httpStatus: 503,
        retryAfterMs: 0,
        requestId: "req-" + count
      }
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, count }));
  process.exit(0);
}
if (mode === "nontransient") {
  const countPath = process.env.PROBE_COUNT;
  const count = countPath && existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  if (countPath) writeFileSync(countPath, String(count));
  process.stderr.write(JSON.stringify({
    ok: false,
    errorDetails: {
      code: "VALIDATION_FAILED",
      message: "invalid input",
      retryable: true
    }
  }));
  process.exit(1);
}
if (mode === "leaky-stderr") {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: "raw child error token_secret_must_not_leak",
    errorDetails: {
      code: "UPSTREAM_503",
      message: "raw upstream body token_secret_must_not_leak",
      retryable: true,
      httpStatus: 503,
      retryAfterMs: 0,
      requestId: "req-leaky",
      details: { token: "token_secret_must_not_leak" }
    }
  }));
  process.exit(1);
}
if (mode === "leaky-failure") {
  process.stdout.write(JSON.stringify({
    ok: false,
    failure: {
      version: "ravi.app.failure/v1",
      code: "TINY_HTTP_RATE_LIMITED",
      category: "rate_limit",
      message: "raw canonical failure token_secret_must_not_leak",
      retryable: true,
      exitCode: 5,
      details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 2, secret: "token_secret_must_not_leak" }
    }
  }));
  process.exit(5);
}
if (mode === "echo") {
  console.log(JSON.stringify({
    ok: true,
    customer: { id: "42", name: "Alice" },
    items: [{ id: "1", name: "First" }, { id: "2", name: "Second" }],
    total: 7,
    hidden: "x"
  }));
  process.exit(0);
}
if (mode === "schema-invalid") {
  console.log(JSON.stringify({ ok: true, customer: { id: 42 }, items: "invalid" }));
  process.exit(0);
}
if (mode === "readiness" && process.env.PROBE_READINESS_OK === "0") {
  console.log(JSON.stringify({ ok: false, reason: "dependency unavailable" }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, mode, args }));
`,
    "utf8",
  );
  return path;
}

function runtimeProbeManifest(root: string): Record<string, unknown> {
  const body = manifest("runtime-probe");
  const operations = body.operations as Record<string, unknown>;
  operations["runtime-probe.inspect"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs inspect {args}",
    json: true,
    mutating: true,
    permission: "runtime-probe:write",
    safety: {
      idempotent: false,
      dryRunSupported: true,
      confirmationRequired: true,
      liveExecution: true,
      risk: "high",
    },
    reliability: { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 0 },
    help: {
      usage: "ravi runtime-probe inspect [--dry-run] [--yes]",
      summary: "Inspect platform controls without performing a mutation.",
      options: [{ flags: "--dry-run", description: "Preview only." }],
    },
  };
  operations["runtime-probe.disabled"] = {
    ...(operations["runtime-probe.inspect"] as Record<string, unknown>),
    command: "bun ./operation-probe.mjs disabled {args}",
    safety: {
      idempotent: false,
      dryRunSupported: true,
      confirmationRequired: true,
      liveExecution: false,
      risk: "destructive",
    },
  };
  operations["runtime-probe.retry"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs retry {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
    reliability: { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 0 },
  };
  operations["runtime-probe.help-retry"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs retry {args}",
    json: true,
    mutating: false,
    help: {
      safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false },
    },
    reliability: { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 0 },
  };
  operations["runtime-probe.nontransient"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs nontransient {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
    reliability: { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 0 },
  };
  operations["runtime-probe.leaky-stderr"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs leaky-stderr {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
    reliability: { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 0 },
  };
  operations["runtime-probe.leaky-failure"] = {
    ...(operations["runtime-probe.leaky-stderr"] as Record<string, unknown>),
    command: "bun ./operation-probe.mjs leaky-failure {args}",
  };
  operations["runtime-probe.unclassified"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs inspect {args}",
    json: true,
  };
  operations["runtime-probe.timeout"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs timeout {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
    reliability: { timeoutMs: 25, maxAttempts: 1 },
  };
  operations["runtime-probe.timeout-tree"] = {
    ...(operations["runtime-probe.timeout"] as Record<string, unknown>),
    command: "bun ./operation-probe.mjs timeout-tree {args}",
  };
  operations["runtime-probe.invalid"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs invalid-json {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
  };
  operations["runtime-probe.echo"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs echo {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
    outputSchema: "schemas/echo.schema.json",
    help: {
      usage: "ravi runtime-probe echo [--fields <paths>]",
      summary: "Return a structured probe payload.",
      options: [{ flags: "--fields <paths>", description: "Select dotted fields." }],
      sourceText: "x".repeat(10_000),
      sections: [{ title: "INTERNAL", content: "x".repeat(10_000) }],
    },
  };
  operations["runtime-probe.schema-invalid"] = {
    ...(operations["runtime-probe.echo"] as Record<string, unknown>),
    command: "bun ./operation-probe.mjs schema-invalid {args}",
  };
  operations["runtime-probe.args"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs inspect {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
  };
  operations["runtime-probe.help"] = {
    interface: "cli",
    command: "bun ./operation-probe.mjs inspect {args}",
    json: true,
    mutating: false,
    safety: { idempotent: true, dryRunSupported: true, confirmationRequired: false, liveExecution: true },
  };
  body.health = {
    checks: [
      {
        id: "manifest",
        type: "builtin",
        required: true,
        sideEffectFree: true,
        handler: "apps.manifest.check",
      },
      {
        id: "probe",
        type: "cli",
        required: true,
        sideEffectFree: true,
        command: "bun ./operation-probe.mjs readiness {args}",
        timeoutMs: 1000,
      },
    ],
  };
  writeOperationProbe(root);
  const schemas = join(root, "src", "apps", "runtime-probe", "schemas");
  mkdirSync(schemas, { recursive: true });
  writeFileSync(
    join(schemas, "echo.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["ok", "customer", "items", "total", "hidden"],
      properties: {
        ok: { const: true },
        customer: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
        total: { type: "number" },
        hidden: { type: "string" },
      },
    }),
  );
  return body;
}

async function captureJson(fn: () => Promise<unknown>): Promise<unknown> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const callback = args.find((value) => typeof value === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
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
      confirmed: false,
      dryRun: false,
      fields: [],
      virtualHelp: false,
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
    expect(
      resolveAppAliasInvocation(["khal-tasks", "list", "--", "--fields", "native"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toEqual({
      appId: "khal-tasks",
      operation: "list",
      args: ["--", "--fields", "native"],
      json: false,
      confirmed: false,
      dryRun: false,
      fields: [],
      virtualHelp: false,
    });
    expect(
      resolveAppAliasInvocation(["khal-tasks", "list", "--help", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toEqual({
      appId: "khal-tasks",
      operation: "help",
      args: ["list"],
      json: true,
      confirmed: false,
      dryRun: false,
      fields: [],
      virtualHelp: true,
    });
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

  it("fails closed before spawning a mutating operation without explicit confirmation", async () => {
    const root = makeRepo();
    const marker = join(root, "probe-marker.txt");
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "inspect",
      json: true,
      env: { ...process.env, PROBE_MARKER: marker },
    });

    expect(result).toMatchObject({
      ok: false,
      operationId: "runtime-probe.inspect",
      mutating: true,
      errorDetails: { code: "APP_CONFIRMATION_REQUIRED", retryable: false },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks operations with an unknown mutation class before spawning", async () => {
    const root = makeRepo();
    const marker = join(root, "probe-marker.txt");
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "unclassified",
      json: true,
      env: { ...process.env, PROBE_MARKER: marker },
    });

    expect(result).toMatchObject({
      ok: false,
      mutating: false,
      mutationClass: "unknown",
      errorDetails: { code: "APP_MUTATION_CLASSIFICATION_REQUIRED", category: "safety" },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("forwards one dry-run flag and consumes the router confirmation flag", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "inspect",
      args: ["payload", "--yes", "--dry-run", "--dry-run"],
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      result: { ok: true, mode: "inspect", args: ["payload", "--dry-run"] },
    });
    expect(result.command).not.toContain("--yes");
  });

  it("blocks live execution disabled by the manifest even when confirmed", async () => {
    const root = makeRepo();
    const marker = join(root, "probe-marker.txt");
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "disabled",
      confirmed: true,
      json: true,
      env: { ...process.env, PROBE_MARKER: marker },
    });

    expect(result).toMatchObject({
      ok: false,
      errorDetails: { code: "APP_LIVE_EXECUTION_DISABLED", retryable: false },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("retries only a declared idempotent read and preserves typed upstream errors", async () => {
    const root = makeRepo();
    const countPath = join(root, "probe-count.txt");
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "retry",
      json: true,
      env: { ...process.env, PROBE_COUNT: countPath },
    });

    expect(result).toMatchObject({ ok: true, attempts: 3, result: { ok: true, count: 3 } });
    expect(readFileSync(countPath, "utf8")).toBe("3");
  });

  it("does not retry from help metadata or an unrecognized retryable child error", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    for (const operation of ["help-retry", "nontransient"]) {
      const countPath = join(root, `${operation}-count.txt`);
      const result = await runAppOperation({
        appId: "runtime-probe",
        operation,
        json: true,
        env: { ...process.env, PROBE_COUNT: countPath },
      });
      expect(result).toMatchObject({ ok: false, attempts: 1 });
      expect(readFileSync(countPath, "utf8")).toBe("1");
    }
  });

  it("preserves the final transient error metadata after exhausting retries", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));
    const countPath = join(root, "retry-exhausted-count.txt");

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "retry",
      json: true,
      env: { ...process.env, PROBE_COUNT: countPath, PROBE_FAIL_ATTEMPTS: "99" },
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 3,
      errorDetails: {
        code: "UPSTREAM_503",
        retryable: true,
        category: "adapter",
        httpStatus: 503,
        retryAfterMs: 0,
        requestId: "req-3",
      },
    });
    expect(readFileSync(countPath, "utf8")).toBe("3");
  });

  it("returns deterministic timeout and invalid JSON failures", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const timeout = await runAppOperation({
      appId: "runtime-probe",
      operation: "timeout",
      json: true,
    });
    expect(timeout).toMatchObject({
      ok: false,
      attempts: 1,
      timedOut: true,
      errorDetails: { code: "APP_TIMEOUT", retryable: true },
    });

    const invalid = await runAppOperation({
      appId: "runtime-probe",
      operation: "invalid",
      json: true,
    });
    expect(invalid).toMatchObject({
      ok: false,
      attempts: 1,
      errorDetails: { code: "APP_INVALID_JSON", retryable: false },
    });

    const descendantMarker = join(root, "descendant-marker.txt");
    const treeTimeout = await runAppOperation({
      appId: "runtime-probe",
      operation: "timeout-tree",
      json: true,
      env: { ...process.env, PROBE_DESCENDANT_MARKER: descendantMarker },
    });
    expect(treeTimeout).toMatchObject({
      ok: false,
      timedOut: true,
      errorDetails: { code: "APP_TIMEOUT" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(descendantMarker)).toBe(false);
  });

  it("sanitizes child stderr before publishing public failure envelopes", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "leaky-stderr",
      json: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "App operation failed.",
      failure: {
        version: "ravi.app.failure/v1",
        code: "UPSTREAM_503",
        category: "upstream",
        message: "App operation failed.",
        retryable: true,
        details: { source: "app", httpStatus: 503, retryAfterSeconds: 0 },
      },
      errorDetails: {
        code: "UPSTREAM_503",
        message: "App operation failed.",
        retryable: true,
        httpStatus: 503,
        retryAfterMs: 0,
        requestId: "req-leaky",
      },
    });
    expect(JSON.stringify(result)).not.toContain("token_secret_must_not_leak");
    expect(JSON.stringify(result)).not.toContain("raw upstream body");
    expect(JSON.stringify(result)).not.toContain("raw child error");
  });

  it("sanitizes child ravi.app.failure messages before republishing them", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "leaky-failure",
      json: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "App operation failed.",
      failure: {
        version: "ravi.app.failure/v1",
        code: "TINY_HTTP_RATE_LIMITED",
        category: "rate_limit",
        message: "App operation failed.",
        retryable: true,
        exitCode: 5,
        details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 2 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("token_secret_must_not_leak");
    expect(JSON.stringify(result)).not.toContain("raw canonical failure");
  });

  it("projects dotted fields from structured app results", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "echo",
      fields: ["customer.id", "items[].id", "total"],
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      selectedFields: ["customer.id", "items[].id", "total"],
      result: { customer: { id: "42" }, items: [{ id: "1" }, { id: "2" }], total: 7 },
    });
    expect((result.result as Record<string, unknown>).hidden).toBeUndefined();

    const unprojected = await runAppOperation({
      appId: "runtime-probe",
      operation: "echo",
      json: true,
    });
    expect(unprojected.selectedFields).toBeUndefined();
    expect(unprojected.result).toMatchObject({
      customer: { id: "42", name: "Alice" },
      items: [
        { id: "1", name: "First" },
        { id: "2", name: "Second" },
      ],
      total: 7,
      hidden: "x",
    });
  });

  it("validates declared output schemas before publishing the router envelope", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const valid = await runAppOperation({ appId: "runtime-probe", operation: "echo", json: true });
    expect(valid).toMatchObject({ schema: "ravi.app.operation-result/v1", ok: true });

    const invalid = await runAppOperation({ appId: "runtime-probe", operation: "schema-invalid", json: true });
    expect(invalid).toMatchObject({
      schema: "ravi.app.operation-result/v1",
      ok: false,
      attempts: 1,
      errorDetails: {
        code: "APP_OUTPUT_SCHEMA_MISMATCH",
        category: "adapter",
        retryable: false,
      },
    });
    expect(invalid.result).toBeUndefined();
    expect(invalid.stdout).toBeUndefined();
    expect(invalid.stderr).toBeUndefined();
  });

  it("forwards router-shaped flags after the passthrough marker", async () => {
    const root = makeRepo();
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));

    const result = await runAppOperation({
      appId: "runtime-probe",
      operation: "args",
      args: ["--", "--fields", "native", "--yes"],
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { ok: true, mode: "inspect", args: ["--fields", "native", "--yes"] },
    });
    expect(result.selectedFields).toBeUndefined();
  });

  it("keeps check and help side-effect free and executes health only through readiness", async () => {
    const root = makeRepo();
    const marker = join(root, "probe-marker.txt");
    writeManifest(root, "runtime-probe", runtimeProbeManifest(root));
    const env = { ...process.env, PROBE_MARKER: marker };

    const check = await runAppOperation({ appId: "runtime-probe", operation: "check", json: true, env });
    expect(check.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const help = await runAppOperation({
      appId: "runtime-probe",
      operation: "help",
      args: ["echo"],
      json: true,
      forceVirtualHelp: true,
      env,
    });
    expect(help).toMatchObject({
      ok: true,
      handler: "apps.help",
      result: {
        operation: {
          id: "runtime-probe.echo",
          name: "echo",
          help: {
            usage: "ravi runtime-probe echo [--fields <paths>]",
            summary: "Return a structured probe payload.",
          },
        },
      },
    });
    const helpPayload = (help.result as { operation: { help: Record<string, unknown> } }).operation.help;
    expect(helpPayload.sourceText).toBeUndefined();
    expect(helpPayload.sections).toBeUndefined();
    expect(existsSync(marker)).toBe(false);

    const aliasHelp = (await captureJson(() =>
      maybeRunAppAliasRoute(["runtime-probe", "echo", "--help", "--json"], {
        staticRootCommands: new Set(["apps"]),
        env,
      }),
    )) as { ok: boolean; handler: string; result: { operation: { id: string } } };
    expect(aliasHelp).toMatchObject({
      ok: true,
      handler: "apps.help",
      result: { operation: { id: "runtime-probe.echo" } },
    });
    expect(existsSync(marker)).toBe(false);

    const readiness = await runAppOperation({
      appId: "runtime-probe",
      operation: "readiness",
      args: ["--", "--tenant", "acme"],
      json: true,
      env,
    });
    expect(readiness).toMatchObject({
      ok: true,
      result: { ok: true, status: "ready", checked: 2 },
    });
    expect(readFileSync(marker, "utf8")).toContain("readiness --tenant acme");
  });

  it("distinguishes required, optional, and undeclared readiness states", async () => {
    const root = makeRepo();
    const marker = join(root, "probe-marker.txt");
    const requiredBody = runtimeProbeManifest(root);
    writeManifest(root, "runtime-probe", requiredBody);

    const notReady = await runAppOperation({
      appId: "runtime-probe",
      operation: "readiness",
      json: true,
      env: { ...process.env, PROBE_MARKER: marker, PROBE_READINESS_OK: "0" },
    });
    expect(notReady).toMatchObject({
      ok: false,
      errorDetails: { code: "APP_NOT_READY", category: "readiness" },
      result: { ok: false, status: "not_ready", checked: 2, executed: 2 },
    });

    const optionalBody = runtimeProbeManifest(root);
    const optionalChecks = (optionalBody.health as { checks: Array<Record<string, unknown>> }).checks;
    optionalChecks[1]!.required = false;
    writeManifest(root, "runtime-probe", optionalBody);
    const degraded = await runAppOperation({
      appId: "runtime-probe",
      operation: "readiness",
      json: true,
      env: { ...process.env, PROBE_READINESS_OK: "0" },
    });
    expect(degraded).toMatchObject({ ok: true, result: { ok: true, status: "degraded" } });

    const legacyBody = runtimeProbeManifest(root);
    const legacyChecks = (legacyBody.health as { checks: Array<Record<string, unknown>> }).checks;
    delete legacyChecks[1]!.id;
    delete legacyChecks[1]!.required;
    delete legacyChecks[1]!.sideEffectFree;
    writeManifest(root, "runtime-probe", legacyBody);
    writeFileSync(marker, "");
    const unknown = await runAppOperation({
      appId: "runtime-probe",
      operation: "readiness",
      json: true,
      env: { ...process.env, PROBE_MARKER: marker },
    });
    expect(unknown).toMatchObject({
      ok: false,
      result: { ok: false, status: "unknown", checked: 2, executed: 1 },
    });
    expect(readFileSync(marker, "utf8")).toBe("");
  });

  it("runs Ravi CLI app operations through the current installation", () => {
    expect(
      resolveRaviCliCommand("ravi yt health --json", {
        execPath: "/opt/bun/bin/bun",
        entrypoint: "/opt/ravi current/dist/bundle/index.js",
      }),
    ).toBe("/opt/bun/bin/bun '/opt/ravi current/dist/bundle/index.js' yt health --json");
    expect(
      resolveRaviCliCommand("bun local-app.mjs --json", {
        execPath: "/opt/bun/bin/bun",
        entrypoint: "/opt/ravi/dist/bundle/index.js",
      }),
    ).toBe("bun local-app.mjs --json");
    expect(
      resolveRaviCliCommand("ravi yt info --json", {
        execPath: "/opt/bun/bin/bun",
        entrypoint: "dist/bundle/index.js",
      }),
    ).toBe(`/opt/bun/bin/bun ${join(process.cwd(), "dist/bundle/index.js")} yt info --json`);
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
      confirmed: false,
      dryRun: false,
      fields: [],
      virtualHelp: false,
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
        confirmed: true,
      }),
    );

    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("requires execute on app:khal-tasks");

    const allowed = await runWithContext(appToolContext([appCapability("use"), appCapability("execute")]), () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
        confirmed: true,
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
    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks", { timeoutMs: 1000 }));

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

    writeManifest(root, "khal-tasks", providerManifest(root, "khal-tasks", { timeoutMs: 250 }));
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
