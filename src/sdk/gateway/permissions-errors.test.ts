import "reflect-metadata";
import { serve, spawn } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { PermissionsCommands } from "../../cli/commands/permissions.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { createContact } from "../../contacts.js";
import { readAgentRuntimePermissionsConfig } from "../../permissions/agent-default-capabilities-provider.js";
import { dbCreateAgent, type ContextRecord } from "../../router/router-db.js";
import { dbGetTagDefinition } from "../../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "./server.js";

const executor = "permission-error-fixture";
const contextKey = "rctx_permission_error_fixture";
const principal: ContextRecord = {
  contextId: "ctx_permission_error_fixture",
  contextKey,
  kind: "test-runtime",
  agentId: executor,
  capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};
const gateway = createGatewayHandlerContext({
  registry: buildRegistry([PermissionsCommands]),
  auth: { resolveContext: () => principal },
});
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface ObservedFailure {
  input: Record<string, unknown>;
  status: number;
  requestId: string | null;
  body: {
    success: false;
    exitCode: number;
    outcome: string;
    error: { code: string; message: string; requestId: string; issues?: unknown };
  };
}

let stateDir: string;
let contactId: string;
let server: ReturnType<typeof serve>;
const failures: ObservedFailure[] = [];

beforeAll(async () => {
  stateDir = await createIsolatedRaviState("ravi-permission-error-transport-");
  contactId = createContact({ phone: "+15550000801", name: "Permission Error Fixture" }).id;
  dbCreateAgent({ id: executor, cwd: stateDir });
  server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.clone().json()) as Record<string, unknown>;
      const response = await handleGatewayRequest(request, gateway);
      if (!response) return new Response("Not found", { status: 404 });
      if (!response.ok) {
        failures.push({
          input,
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          body: (await response.clone().json()) as ObservedFailure["body"],
        });
      }
      return response;
    },
  });
});

afterAll(async () => {
  server?.stop(true);
  await cleanupIsolatedRaviState(stateDir);
});

async function executeCli(args: string[], asJson: boolean) {
  // Only synthetic runtime authority is passed to the subprocess. Explicit
  // isolated state and a loopback gateway keep it away from the live runtime.
  const child = spawn({
    cmd: [process.execPath, "src/cli/index.ts", ...args, ...(asJson ? ["--json"] : [])],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      RAVI_STATE_DIR: stateDir,
      RAVI_GATEWAY_URL: server.url.origin,
      RAVI_CONTEXT_KEY: contextKey,
      RAVI_HOST_CLI_GATEWAY: "0",
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      NATS_URL: "nats://127.0.0.1:1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}

async function runCli(args: string[], asJson: boolean) {
  const start = failures.length;
  const { stdout, stderr, exitCode } = await executeCli(args, asJson);
  expect(failures.length, `${stdout}\n${stderr}`).toBe(start + 1);
  const failure = failures[start]!;
  expect(failure.input.agent).toBe(executor);
  expect(failure.input.apply).not.toBe(true);
  if (failure.requestId === null) throw new Error("Gateway failure omitted x-request-id");
  expect(failure.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(failure.body.error.requestId).toBe(failure.requestId);
  expect(failure.body.error.issues).toBeUndefined();
  expect(exitCode).toBe(failure.body.exitCode);
  expect(`${stdout}\n${stderr}`).not.toContain("Remote gateway rejected the command input.");
  if (asJson) {
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      success: false,
      op: "permissions allow",
      error: {
        code: failure.body.error.code,
        message: failure.body.error.message,
        requestId: failure.requestId,
        status: failure.status,
      },
    });
  } else {
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain(failure.body.error.message);
    expect(stderr).toContain(failure.requestId);
  }
  return failure;
}

describe("permission failures through gateway and CLI with --agent", () => {
  it("resolves an existing canonical contact with --agent without applying a grant", async () => {
    const { stdout, stderr, exitCode } = await executeCli(
      ["permissions", "allow", "bootstrap", "--to", `contact:${contactId}`, "--force", "--agent", executor],
      true,
    );
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: true,
      changedCount: 0,
      targets: [{ type: "contact", id: contactId }],
      agentCeilings: [executor],
    });
    expect(dbGetTagDefinition("permission-bootstrap")).toBeNull();
    expect(readAgentRuntimePermissionsConfig(executor)).toBeNull();
  }, 20_000);

  for (const asJson of [true, false]) {
    it(`preserves unknown-profile guidance and correlation (${asJson ? "JSON" : "text"})`, async () => {
      const failure = await runCli(
        ["permissions", "allow", "missing-profile", "--to", `contact:${contactId}`, "--force", "--agent", executor],
        asJson,
      );
      expect(failure.status).toBe(400);
      expect(failure.body).toMatchObject({ exitCode: 2, outcome: "usage_error", error: { code: "USAGE_ERROR" } });
      expect(failure.body.error.message).toContain("Unknown or empty permission profile: permission-missing-profile");
      expect(failure.body.error.message).toContain("--capabilities");
    }, 20_000);

    it(`preserves an invalid contact's real error and correlation (${asJson ? "JSON" : "text"})`, async () => {
      const failure = await runCli(
        ["permissions", "allow", "bootstrap", "--to", "contact:missing-contact", "--force", "--agent", executor],
        asJson,
      );
      expect(failure.status).toBe(422);
      expect(failure.body).toMatchObject({
        exitCode: 1,
        outcome: "failed",
        error: { code: "CONTACT_NOT_FOUND", message: "Contact not found: missing-contact" },
      });
    }, 20_000);

    it(`preserves issue-less usage messages outside phrase catalogs (${asJson ? "JSON" : "text"})`, async () => {
      const failure = await runCli(
        ["permissions", "allow", "bootstrap", "--to", `contact:${contactId}`, "--chat", "current", "--agent", executor],
        asJson,
      );
      expect(failure.status).toBe(400);
      expect(failure.body).toMatchObject({
        exitCode: 2,
        outcome: "usage_error",
        error: { code: "USAGE_ERROR", message: "No current chat in this context; pass --chat <chat-id>." },
      });
    }, 20_000);
  }
});
