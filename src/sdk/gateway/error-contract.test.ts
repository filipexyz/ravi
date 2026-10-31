import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { ContractError } from "../../cli/agent-contract.js";
import { CronCommands } from "../../cli/commands/cron.js";
import { WorkflowRunCommands } from "../../cli/commands/workflows.js";
import { ArtifactsCommands } from "../../cli/commands/artifacts.js";
import { ContactsCommands } from "../../cli/commands/contacts.js";
import { TaskCommands } from "../../cli/commands/tasks.js";
import { Command, CommandAccess, Group } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { remoteGatewayErrorToContractError, remoteNextStepLine } from "../../cli/remote-gateway.js";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../../test/ravi-state.js";
import type { ContextRecord } from "../../router/router-db.js";
import { logGatewayFailure } from "./diagnostics.js";
import { gatewayRequestContext, withGatewayRequest } from "./request-context.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "./server.js";

let stateDir: string;
beforeAll(async () => {
  stateDir = await createIsolatedRaviState("ravi-error-contract-");
});
afterAll(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

@Group({ name: "failure", description: "Error boundary fixture", scope: "admin" })
class FailureCommands {
  @Command({ name: "internal", description: "Error boundary fixture" })
  @CommandAccess({ kind: "read", resource: "failure", action: "internal", risk: "low" })
  internal() {
    throw new Error("Database lookup failed", { cause: new Error("no such table: fixture_table") });
  }

  @Command({ name: "circular", description: "Error boundary fixture" })
  @CommandAccess({ kind: "read", resource: "failure", action: "circular", risk: "low" })
  circular() {
    const value: { self?: unknown } = {};
    value.self = value;
    return value;
  }

  @Command({ name: "expected", description: "Error boundary fixture" })
  @CommandAccess({ kind: "read", resource: "failure", action: "expected", risk: "low" })
  expected() {
    throw new ContractError(
      "failure expected",
      "FIXTURE_NOT_FOUND",
      "Fixture not found. Select an existing fixture.",
      1,
      {
        suggestedAction: "List the available fixtures before retrying",
      },
    );
  }
}

const principal: ContextRecord = {
  contextId: "ctx_error_fixture",
  contextKey: "rctx_error_fixture",
  kind: "test-runtime",
  agentId: "error-fixture",
  capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};
const registry = buildRegistry([
  TaskCommands,
  FailureCommands,
  CronCommands,
  WorkflowRunCommands,
  ArtifactsCommands,
  ContactsCommands,
]);
const ctx = createGatewayHandlerContext({ registry, auth: { resolveContext: () => principal } });

function request(path: string, body = "{}", method = "POST", authenticated = true) {
  return new Request(`http://fixture/api/v1/${path}`, {
    method,
    headers: {
      ...(authenticated ? { authorization: "Bearer rctx_error_fixture" } : {}),
      // Caller input must never become the correlation id.
      "x-request-id": "password=caller-secret",
    },
    ...(method === "POST" ? { body } : {}),
  });
}

async function relay(response: Response, op: string) {
  return remoteGatewayErrorToContractError(op, {
    status: response.status,
    ok: response.ok,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  })!;
}

describe("gateway error contract end to end", () => {
  it("names --instructions in the real tasks create 422 and CLI output", async () => {
    const response = (await handleGatewayRequest(
      request("tasks/create", JSON.stringify({ title: "Probe", priority: "low" })),
      ctx,
    ))!;
    expect(response.status).toBe(422);
    const remote = await relay(response, "tasks create");
    expect(remote).toMatchObject({
      code: "VALIDATION_ERROR",
      exitCode: 2,
      details: {
        field: "instructions",
        argument: "--instructions",
        retryable: false,
        issues: [{ path: ["instructions"], code: "required", message: "--instructions is required." }],
      },
    });
    expect(remote.message).toContain("--instructions is required");
    expect(remote.details.requestId).toBe(response.headers.get("x-request-id"));
    expect(remoteNextStepLine(remote)).toContain(String(remote.details.requestId));
  });

  it.each([
    ["cron/add", { name: "Probe", every: "1h" }, "message"],
    ["workflows/runs/task-create", { runId: "probe", nodeKey: "probe" }, "title"],
    ["artifacts/restore", { id: "probe" }, "version"],
    ["contacts/link", { contact: "probe" }, "channel"],
  ] as const)("fixes the same required-field defect at %s", async (path, body, field) => {
    const response = (await handleGatewayRequest(request(path, JSON.stringify(body)), ctx))!;
    expect(response.status).toBe(422);
    const remote = await relay(response, path.replaceAll("/", " "));
    expect(remote).toMatchObject({ code: "VALIDATION_ERROR", exitCode: 2, details: { field, argument: `--${field}` } });
    expect(remote.message).toContain(`--${field} is required`);
  });

  it("preserves actionable public messages and actions across every command group", async () => {
    const response = (await handleGatewayRequest(request("failure/expected"), ctx))!;
    const remote = await relay(response, "failure expected");
    expect(remote.message).toBe("Fixture not found. Select an existing fixture.");
    expect(remote.details.suggestedAction).toBe("List the available fixtures before retrying");
  });

  it("correlates a private stack/cause with a safe HTTP 500 and CLI requestId", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      const response = (await handleGatewayRequest(request("failure/internal"), ctx))!;
      expect(response.status).toBe(500);
      const remote = await relay(response, "failure internal");
      const log = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(log).toContain(String(remote.details.requestId));
      expect(log).toContain("stack=");
      expect(log).toContain("fixture_table");
      expect(log).toContain("error-contract.test.ts");
      expect(remote.code).toBe("UNHANDLED_ERROR");
      expect(remote.details.retryable).toBe(false);
      expect(JSON.stringify(remote.envelope())).not.toContain("fixture_table");
      expect(log).not.toContain("caller-secret");
    } finally {
      stderr.mockRestore();
    }
  });

  it("catches serialization failures after the handler", async () => {
    const response = (await handleGatewayRequest(request("failure/circular"), ctx))!;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "UNHANDLED_ERROR", requestId: response.headers.get("x-request-id") },
    });
  });

  it("links a repeated HTTP failure to the first logged request", async () => {
    const error = new Error("repeatable lookup failure");
    const handler = spyOn(FailureCommands.prototype, "internal").mockImplementation(() => {
      throw error;
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      const first = (await handleGatewayRequest(request("failure/internal"), ctx))!;
      const second = (await handleGatewayRequest(request("failure/internal"), ctx))!;
      const remote = await relay(second, "failure internal");
      expect(remote.details.diagnosticRequestId).toBe(first.headers.get("x-request-id"));
      expect(remote.details.requestId).not.toBe(remote.details.diagnosticRequestId);
      expect(remoteNextStepLine(remote)).toContain(String(remote.details.diagnosticRequestId));
      expect(
        stderr.mock.calls
          .map((call) => String(call[0]))
          .join("")
          .match(/Gateway command exception/g),
      ).toHaveLength(1);
    } finally {
      handler.mockRestore();
      stderr.mockRestore();
    }
  });

  it("catches failures before dispatch, including authentication resolution", async () => {
    const broken = createGatewayHandlerContext({
      registry,
      auth: {
        resolveContext: () => {
          throw new Error("auth storage unavailable");
        },
      },
    });
    const response = (await handleGatewayRequest(request("failure/expected"), broken))!;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "UNHANDLED_ERROR", requestId: response.headers.get("x-request-id") },
    });
  });

  it.each([
    ["missing/route", "{}", "POST", true, 404, "ROUTE_NOT_FOUND"],
    ["failure/expected", "{}", "GET", true, 405, "METHOD_NOT_ALLOWED"],
    ["failure/expected", "{}", "POST", false, 401, "AUTH_REQUIRED"],
    ["failure/expected", "not json", "POST", true, 400, "BAD_REQUEST"],
    ["failure/expected", "x".repeat(200), "POST", true, 413, "PAYLOAD_TOO_LARGE"],
    ["tasks/create", "{}", "POST", true, 400, "USAGE_ERROR"],
  ] as const)("envelopes %s (%s / %s / %s)", async (path, body, method, authenticated, status, code) => {
    const response = (await handleGatewayRequest(request(path, body, method, authenticated), {
      ...ctx,
      maxBodyBytes: 100,
    }))!;
    expect(response.status).toBe(status);
    const remote = await relay(response, path.replaceAll("/", " "));
    expect(remote.code).toBe(code);
    expect(remote.details.requestId).toBe(response.headers.get("x-request-id"));
    expect(remote.message).not.toContain("Remote command failed");
    expect(remote.details.suggestedAction).not.toContain("Inspect redacted remote logs");
  });

  it("isolates request ids during concurrent failures", async () => {
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => handleGatewayRequest(request("failure/expected"), ctx)),
    );
    const ids = await Promise.all(
      replies.map(async (reply) => {
        const body = (await reply!.json()) as { error: { requestId: string } };
        expect(body.error.requestId).toBe(reply!.headers.get("x-request-id")!);
        return body.error.requestId;
      }),
    );
    expect(new Set(ids).size).toBe(12);
  });

  it("logs first cause, suppresses repeats, reports counts after window, and redacts secrets", () => {
    const cause = new Error(
      'database password="not-for-logs" token=opaque-secret access_token=opaque-access apiKey=opaque-key ctx_fixture_secret https://user:pass@host/query?key=secret',
    );
    const error = Object.assign(new Error("Cannot load fixture", { cause }), { body: "DO_NOT_LOG_BODY" });
    const stderr = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      const run = (now: number) =>
        withGatewayRequest("diagnostics fixture", () => {
          logGatewayFailure(error, "FIXTURE_FAILED", now);
          return gatewayRequestContext().requestId;
        });
      const first = run(1);
      run(2);
      run(3);
      const second = run(60_001);
      const logs = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(logs.match(/Gateway command exception/g)).toHaveLength(2);
      expect(logs).toContain(first);
      expect(logs).toContain(second);
      expect(logs).toContain("suppressed=2");
      for (const secret of [
        "not-for-logs",
        "opaque-secret",
        "user:pass",
        "opaque-access",
        "opaque-key",
        "ctx_fixture_secret",
        "DO_NOT_LOG_BODY",
      ])
        expect(logs).not.toContain(secret);
    } finally {
      stderr.mockRestore();
    }
  });
});
