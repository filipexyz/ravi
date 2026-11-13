import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextCredentialsCommands } from "./commands/context.js";
import { runWithContext } from "./context.js";
import * as operatorRuntime from "./operator-runtime.js";
import { registerCommands } from "./registry.js";

const classifyInstalledOperator = operatorRuntime.usesInstalledOperatorTransport;
const firstKey = "rctx_local_fixture_first";
const secondKey = "rctx_local_fixture_second";
const candidateKey = "rctx_local_fixture_candidate";
let fixture: string;
let stateDir: string;
let clientPath: string;
let daemonPath: string;
let savedEnv: NodeJS.ProcessEnv;
let output: string[];
let requests: number;
let server: Server | undefined;

function entry(label: string) {
  return {
    context_id: `ctx_${label}`,
    agent_id: "fixture",
    label,
    kind: "test-runtime",
    issued_at: 100,
    expires_at: null,
  };
}
function writeStore(path: string, contexts: Record<string, ReturnType<typeof entry>>, defaultKey: string | null) {
  writeFileSync(path, JSON.stringify({ version: 1, default: defaultKey, contexts }), { mode: 0o600 });
}
function readStore(path = clientPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function execute(...args: string[]) {
  const program = new CommanderCommand();
  program.exitOverride();
  registerCommands(program, [ContextCredentialsCommands]);
  return program.parseAsync(["bun", "fixture", "context", "credentials", ...args, "--json"]);
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  server = createServer((request, response) => {
    requests++;
    handler(request, response);
  });
  await new Promise<void>((resolve) => server!.listen(join(stateDir, "cli-gateway.sock"), resolve));
}
function whoami() {
  return {
    contextId: "ctx_candidate",
    kind: "test-runtime",
    status: "active",
    agentId: "fixture",
    sessionKey: null,
    sessionName: null,
    createdAt: 123,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    capabilitiesCount: 1,
    parentContextId: null,
    issuedFor: null,
    issuanceMode: null,
    source: null,
    metadata: null,
    capabilities: [{ permission: "read", objectType: "context", objectId: "whoami" }],
    lineage: {
      parentContextId: null,
      parentContextKind: null,
      issuedFor: null,
      issuedAt: null,
      issuanceMode: null,
      approvalSource: null,
    },
  };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  fixture = mkdtempSync(join(tmpdir(), "ravi-cc-"));
  const accountHome = join(fixture, "home");
  stateDir = join(accountHome, ".ravi");
  mkdirSync(stateDir, { recursive: true });
  const packageRoot = join(fixture, "installed");
  const modulePath = join(packageRoot, "dist", "bundle", "index.js");
  mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "ravi.bot" }));
  writeFileSync(modulePath, "");
  clientPath = join(fixture, "client-credentials.json");
  daemonPath = join(stateDir, "credentials.json");
  // Only this isolated fixture is an operator invocation. Never alter the
  // credentials or identity used by the external test launcher.
  for (const key of Object.keys(process.env)) if (key.startsWith("RAVI_")) delete process.env[key];
  process.env.RAVI_STATE_DIR = stateDir;
  process.env.RAVI_CREDENTIALS_PATH = clientPath;
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  const provenance = { modulePath, homeDir: accountHome };
  expect(classifyInstalledOperator(process.env, provenance)).toBe(true);
  spyOn(operatorRuntime, "usesInstalledOperatorTransport").mockImplementation((env = process.env) =>
    classifyInstalledOperator(env, provenance),
  );
  writeStore(clientPath, { [firstKey]: entry("client-first"), [secondKey]: entry("client-second") }, firstKey);
  writeStore(daemonPath, { [firstKey]: entry("daemon-first"), [secondKey]: entry("daemon-second") }, firstKey);
  output = [];
  requests = 0;
  spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
  spyOn(console, "error").mockImplementation((value) => output.push(String(value)));
  spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`fixture_exit_${code}`);
  });
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  const databases = readdirSync(fixture, { recursive: true }).filter((path) => /\.(db|sqlite)(-|$)/.test(String(path)));
  mock.restore();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(fixture, { recursive: true, force: true });
  expect(databases).toEqual([]);
});

describe("installed operator client-local credentials", () => {
  it.each(["missing", "empty"])("lists a %s client store without requiring authentication", async (state) => {
    if (state === "missing") rmSync(clientPath);
    else writeStore(clientPath, {}, null);
    await listen((_request, response) => response.end(JSON.stringify({ daemon: true })));
    const daemonBefore = readFileSync(daemonPath, "utf8");
    await execute("list");
    expect(JSON.parse(output[0]!)).toMatchObject({
      path: clientPath,
      exists: state !== "missing",
      total: 0,
      items: [],
    });
    expect(requests).toBe(0);
    expect(readFileSync(daemonPath, "utf8")).toBe(daemonBefore);
    expect(existsSync(clientPath)).toBe(state !== "missing");
  });

  it("lists client entries without reading the distinct daemon store", async () => {
    await listen((_request, response) => response.end(JSON.stringify({ daemon: true })));
    await execute("list");
    const result = JSON.parse(output[0]!);
    expect(result.path).toBe(clientPath);
    expect(result.items.map((item: { label: string }) => item.label)).toEqual(["client-first", "client-second"]);
    expect(requests).toBe(0);
  });

  it.each(["set-default", "remove"])("%s mutates only the selected client file", async (command) => {
    const daemonBefore = readFileSync(daemonPath, "utf8");
    await listen((_request, response) => {
      // Regression sentinel: a forwarded credential command acts on the daemon store.
      writeStore(daemonPath, {}, null);
      response.end(JSON.stringify({ daemon: true }));
    });
    await execute(command, secondKey, ...(command === "remove" ? ["--execute"] : []));
    expect(requests).toBe(0);
    expect(readFileSync(daemonPath, "utf8")).toBe(daemonBefore);
    if (command === "set-default") expect(readStore().default).toBe(secondKey);
    else expect(readStore().contexts).not.toHaveProperty(secondKey);
  });

  it("keeps removal braked offline and never resolves a default through SQLite", async () => {
    const before = readFileSync(clientPath, "utf8");
    await expect(execute("remove", firstKey)).rejects.toThrow("fixture_exit_3");
    expect(output.join("\n")).toContain("WRITE_REQUIRES_EXECUTE");
    expect(readFileSync(clientPath, "utf8")).toBe(before);
    await execute("set-default", secondKey);
    expect(readStore().default).toBe(secondKey);
  });

  it.each(["RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL"])("never falls back locally with %s", async (envKey) => {
    process.env[envKey] =
      envKey === "RAVI_CONTEXT_KEY" ? "rctx_runtime_fixture" : `unix://${join(stateDir, "missing.sock")}`;
    const before = readFileSync(clientPath, "utf8");
    await expect(execute("remove", firstKey, "--execute")).rejects.toThrow("fixture_exit_1");
    expect(output.join("\n")).toContain(envKey === "RAVI_CONTEXT_KEY" ? "GATEWAY_REQUIRED" : "SERVER_UNAVAILABLE");
    expect(readFileSync(clientPath, "utf8")).toBe(before);
  });

  it("does not recognize a transport marker forged by a runtime caller", async () => {
    process.env.RAVI_CONTEXT_KEY = "rctx_runtime_fixture";
    const before = readFileSync(clientPath, "utf8");
    await runWithContext({ transport: "tool", installedOperator: true, localCredentials: true }, async () => {
      expect(operatorRuntime.isLocalCredentialOperatorContext()).toBe(false);
      await expect(execute("remove", firstKey, "--execute")).rejects.toThrow("fixture_exit_1");
    });
    expect(readFileSync(clientPath, "utf8")).toBe(before);
  });

  it.each(["missing", "existing"])(
    "validates add through whoami and persists to the %s client store only",
    async (state) => {
      if (state === "missing") rmSync(clientPath);
      const daemonBefore = readFileSync(daemonPath, "utf8");
      const seen: Array<{ url?: string; authorization?: string; body: string }> = [];
      await listen((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          seen.push({ url: request.url, authorization: request.headers.authorization, body });
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(whoami()));
        });
      });
      await execute("add", candidateKey, "--label", "candidate", "--set-default");
      expect(requests).toBe(1);
      expect(seen).toEqual([
        {
          url: "/api/v1/context/whoami",
          authorization: `Bearer ${candidateKey}`,
          body: JSON.stringify({ json: true }),
        },
      ]);
      expect(readStore().default).toBe(candidateKey);
      expect(readStore().contexts[candidateKey]).toEqual({
        context_id: "ctx_candidate",
        agent_id: "fixture",
        label: "candidate",
        kind: "test-runtime",
        issued_at: 123,
        expires_at: null,
      });
      expect(readFileSync(daemonPath, "utf8")).toBe(daemonBefore);
    },
  );

  it.each(["401", "403", "malformed", "shape", "revoked", "unavailable"])(
    "does not persist add after %s validation",
    async (failure) => {
      const before = readFileSync(clientPath, "utf8");
      const daemonBefore = readFileSync(daemonPath, "utf8");
      if (failure !== "unavailable") {
        await listen((_request, response) => {
          response.statusCode = failure === "401" || failure === "403" ? Number(failure) : 200;
          response.setHeader("Content-Type", "application/json");
          response.end(
            failure === "malformed"
              ? `not-json ${candidateKey}`
              : failure === "shape"
                ? JSON.stringify({ contextId: "ctx_partial" })
                : failure === "revoked"
                  ? JSON.stringify({ ...whoami(), status: "revoked" })
                  : JSON.stringify({ error: "Unauthorized" }),
          );
        });
      }
      await expect(execute("add", candidateKey, "--set-default")).rejects.toThrow("fixture_exit_1");
      expect(readFileSync(clientPath, "utf8")).toBe(before);
      expect(output.join("\n")).not.toContain(candidateKey);
      expect(readFileSync(daemonPath, "utf8")).toBe(daemonBefore);
      if (["malformed", "shape", "revoked"].includes(failure)) {
        expect(output.join("\n")).toContain('"code": "GATEWAY_RESPONSE_INVALID"');
        expect(output.join("\n")).not.toContain('"code": "SERVER_UNAVAILABLE"');
      }
    },
  );
});
