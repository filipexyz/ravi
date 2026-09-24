import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { serve, spawn } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRecord } from "../../router/router-db.js";
import type { HostCliGatewayHandle } from "../host-cli-gateway.js";

const stateDir = mkdtempSync(join(tmpdir(), "ravi-hook-gateway-test-"));
const previousStateDir = process.env.RAVI_STATE_DIR;
const previousAuditSuppression = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
process.env.RAVI_STATE_DIR = stateDir;
process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";

const { ContextCommands } = await import("./context.js");
const { buildRegistry } = await import("../registry-snapshot.js");
const { startHostCliGateway } = await import("../host-cli-gateway.js");
const { dispatchRemote } = await import("../remote-gateway.js");
const { redactCommandAccessInput } = await import("../command-access.js");

const registry = buildRegistry([ContextCommands]);
const socketPath = join(stateDir, "cli-gateway.sock");
const allowedContext: ContextRecord = {
  contextId: "ctx_hook_fixture",
  contextKey: "rctx_hook_fixture",
  kind: "test-runtime",
  agentId: "hook-fixture",
  capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
  createdAt: Date.now(),
};
const contexts: Record<string, ContextRecord> = {
  allowed: allowedContext,
  restricted: {
    ...allowedContext,
    contextKey: "rctx_hook_restricted",
    capabilities: [{ permission: "read", objectType: "context", objectId: "codex-bash-hook" }],
  },
  denied: { ...allowedContext, contextKey: "rctx_hook_denied", capabilities: [] },
  expired: { ...allowedContext, contextKey: "rctx_hook_expired", expiresAt: Date.now() - 1 },
  revoked: { ...allowedContext, contextKey: "rctx_hook_revoked", revokedAt: Date.now() - 1 },
};
let gateway: HostCliGatewayHandle;

beforeAll(async () => {
  gateway = (await startHostCliGateway({
    socketPath,
    gateway: {
      registry,
      auth: { resolveContext: (key) => Object.values(contexts).find((context) => context.contextKey === key) ?? null },
    },
  }))!;
});

afterAll(async () => {
  await gateway?.stop();
  if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = previousStateDir;
  if (previousAuditSuppression === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousAuditSuppression;
  rmSync(stateDir, { recursive: true, force: true });
});

async function callHook(
  stdin: string,
  options: { alias?: boolean; contextKey?: string; gatewayUrl?: string; autoGateway?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, RAVI_CONTEXT_KEY: options.contextKey ?? allowedContext.contextKey };
  if (options.autoGateway) delete env.RAVI_GATEWAY_URL;
  else env.RAVI_GATEWAY_URL = options.gatewayUrl ?? `unix://${socketPath}`;
  const child = spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "../fixtures/codex-hook-cli.ts"),
      "context",
      options.alias ? "codex-tool-hook" : "codex-bash-hook",
    ],
    env,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("rctx_");
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

function expectDeny(value: unknown) {
  expect(value).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
}

describe("Codex hook through the host gateway", () => {
  it("preserves stdin through automatic host socket dispatch", async () => {
    expect(await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), { autoGateway: true })).toEqual({});
  }, 20_000);

  it("preserves stdin through the compatibility alias and explicit gateway", async () => {
    expect(await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), { alias: true })).toEqual({});
  }, 20_000);

  for (const stdin of ["", "{invalid", "{}", "null", "[]"]) {
    it(`denies invalid hook input ${JSON.stringify(stdin)}`, async () => {
      expectDeny(await callHook(stdin));
    }, 20_000);
  }

  it("keeps Bash permission checks for a context allowed to invoke the hook", async () => {
    expectDeny(
      await callHook(JSON.stringify({ tool_input: { command: "node --version" } }), {
        contextKey: contexts.restricted!.contextKey,
      }),
    );
  }, 20_000);

  for (const kind of ["denied", "expired", "revoked", "unknown"]) {
    it(`fails closed when gateway authorization is ${kind}`, async () => {
      expectDeny(
        await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), {
          contextKey: contexts[kind]?.contextKey ?? "rctx_hook_unknown",
        }),
      );
    }, 20_000);
  }

  it("fails closed when the configured gateway is unavailable", async () => {
    expectDeny(
      await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), {
        gatewayUrl: `unix://${join(stateDir, "missing.sock")}`,
      }),
    );
  }, 20_000);

  it("fails closed on invalid gateway configuration", async () => {
    expectDeny(await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), { gatewayUrl: "invalid-gateway" }));
  }, 20_000);

  for (const body of ["not-json", '{"ok":true}', '{"hookSpecificOutput":{"permissionDecision":"allow"}}']) {
    it(`rejects a successful HTTP response with invalid hook output ${body}`, async () => {
      const server = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
      try {
        const output = await callHook(JSON.stringify({ tool_input: { command: "pwd" } }), {
          gatewayUrl: server.url.href,
        });
        expectDeny(output);
        expect(JSON.stringify(output)).not.toContain(body);
      } finally {
        await server.stop(true);
      }
    }, 20_000);
  }

  it("does not read daemon stdin when a gateway caller omits the payload", async () => {
    const result = await dispatchRemote({
      groupSegments: ["context"],
      command: "codex-bash-hook",
      body: {},
      config: { url: `unix://${socketPath}`, socketPath, source: "env" },
      contextKey: allowedContext.contextKey,
    });
    expectDeny(JSON.parse(result.body));
    expect(result.body).toContain("payload is missing");
  });

  it("redacts the transported payload from command audit", () => {
    const command = registry.commands.find((entry) => entry.fullName === "context.codex-bash-hook")!;
    const redacted = redactCommandAccessInput(command.access, { payload: "PRIVATE_HOOK_INPUT_SENTINEL" });
    expect(redacted).toEqual({ payload: "[REDACTED]" });
  });
});
