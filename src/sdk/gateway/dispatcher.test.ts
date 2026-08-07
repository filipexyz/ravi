import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { RaviAppError } from "../../apps/types.js";
import { AppsCommands } from "../../cli/commands/apps.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../../cli/decorators.js";
import { contractFail } from "../../cli/agent-contract.js";
import { fail, getContext } from "../../cli/context.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import type { ContextCapability, ContextRecord } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dispatch, type AuditEvent } from "./dispatcher.js";

const rejectedSensitiveInput = z.string().superRefine((value, ctx) => {
  ctx.addIssue({ code: "custom", message: `Rejected sensitive input: ${value}` });
});

@Group({ name: "demo", description: "Gateway demo commands", scope: "open" })
class GatewayDemoCommands {
  @Command({ name: "negated", description: "Expose negated flag presence" })
  @CommandAccess({ kind: "read", resource: "demo", action: "negated", risk: "low", input: ["noCache"] })
  @Returns(z.object({ noCache: z.boolean() }))
  negated(@Option({ flags: "--no-cache", description: "Disable cache" }) noCache = false) {
    return { noCache };
  }

  @Command({ name: "echo", description: "Echo a name" })
  @CommandAccess({ kind: "read", resource: "demo", action: "echo", risk: "low", input: ["name", "limit"] })
  @Returns(
    z.object({
      ok: z.literal(true),
      name: z.string(),
      shout: z.boolean(),
      limit: z.string(),
    }),
  )
  echo(
    @Arg("name", { description: "Recipient" }) name: string,
    @Option({ flags: "--shout", description: "Yell" }) shout?: boolean,
    @Option({ flags: "--limit <n>", description: "Limit", defaultValue: "10" })
    limit?: string,
  ) {
    return {
      ok: true as const,
      name,
      shout: shout === true,
      limit: String(limit ?? "10"),
    };
  }

  @Command({ name: "redacted", description: "Redact sensitive command input from audits" })
  @CommandAccess({
    kind: "read",
    resource: "demo",
    action: "redacted",
    risk: "low",
    input: ["content"],
    redactions: ["content"],
  })
  @Returns(z.object({ ok: z.literal(true) }))
  redacted(@Arg("content") content: string) {
    void content;
    return { ok: true as const };
  }

  @Command({ name: "redacted-invalid", description: "Reject sensitive command input" })
  @CommandAccess({
    kind: "read",
    resource: "demo",
    action: "redacted-invalid",
    risk: "low",
    input: ["content"],
    redactions: ["content"],
  })
  redactedInvalid(@Arg("content", { schema: rejectedSensitiveInput }) content: string) {
    void content;
  }

  @Command({ name: "void", description: "Returns nothing" })
  @CommandAccess({ kind: "read", resource: "demo", action: "void", risk: "low" })
  voidNoop(): void {
    return;
  }

  @Command({ name: "context", description: "Inspect gateway tool context" })
  @CommandAccess({ kind: "read", resource: "demo", action: "context", risk: "low" })
  context() {
    console.log("human CLI output should not leak through the SDK gateway");
    return { suppressCliOutput: getContext()?.suppressCliOutput === true };
  }

  @Command({ name: "broken", description: "Returns wrong shape" })
  @CommandAccess({ kind: "read", resource: "demo", action: "broken", risk: "low" })
  @Returns(z.object({ ok: z.literal(true) }))
  broken() {
    return { ok: false } as unknown as { ok: true };
  }

  @Command({ name: "boom", description: "Throws" })
  @CommandAccess({ kind: "read", resource: "demo", action: "boom", risk: "low" })
  boom() {
    throw new Error("kaboom");
  }

  @Command({ name: "app-error", description: "Throws an app-domain expected error" })
  @CommandAccess({ kind: "read", resource: "demo", action: "app-error", risk: "low" })
  appError() {
    throw new RaviAppError("not_found", "Missing app at private-path/app-secret", [
      { kind: "manifest", detail: "private-path/app-secret" },
    ]);
  }

  @Command({ name: "legacy", description: "Throws a legacy expected failure" })
  @CommandAccess({ kind: "read", resource: "demo", action: "legacy", risk: "low" })
  legacy() {
    fail("legacy validation failed");
  }

  @Command({ name: "contract", description: "Throws a structured contract error" })
  @CommandAccess({ kind: "read", resource: "demo", action: "contract", risk: "low", input: ["exitCode"] })
  contract(@Arg("exitCode", { description: "Contract exit taxonomy code" }) exitCode: string) {
    const numericExitCode = Number(exitCode);
    const code =
      numericExitCode === 2 ? "USAGE_ERROR" : numericExitCode === 3 ? "WRITE_REQUIRES_EXECUTE" : "DEMO_NOT_FOUND";
    contractFail("demo contract", code, "contract stopped execution", {
      exitCode: numericExitCode,
      details: {
        retryable: false,
        suggestedAction: "inspect the structured response",
      },
    });
  }

  @Command({ name: "blob", description: "Returns raw binary Response" })
  @CommandAccess({ kind: "read", resource: "demo", action: "blob", risk: "low" })
  @Returns.binary()
  blob() {
    return new Response(new Uint8Array([0xff, 0x00, 0x42]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
    });
  }

  @Command({ name: "missing-blob", description: "Returns a non-success binary response" })
  @CommandAccess({ kind: "read", resource: "demo", action: "missing-blob", risk: "low" })
  @Returns.binary()
  missingBlob() {
    return Response.json(
      { error: "NotFound", detail: "private storage path and provider response" },
      { status: 404 },
    );
  }

  @Command({
    name: "wrong-blob",
    description: "Marked binary but returns plain object",
  })
  @CommandAccess({ kind: "read", resource: "demo", action: "wrong-blob", risk: "low" })
  @Returns.binary()
  wrongBlob() {
    return { not: "a response" };
  }
}

@Group({
  name: "secret",
  description: "Superadmin commands",
  scope: "superadmin",
})
class GatewaySuperadminCommands {
  @Command({ name: "ping", description: "Should be hidden by default" })
  @CommandAccess({ kind: "read", resource: "secret", action: "ping", risk: "low" })
  ping() {
    return { ok: true };
  }
}

@Group({
  name: "sessions",
  description: "Gateway session read commands",
  scope: "open",
})
class GatewaySessionsCommands {
  @Command({ name: "list", description: "Noisy polling read" })
  @CommandAccess({ kind: "read", resource: "sessions", action: "list", risk: "low" })
  list() {
    return { ok: true };
  }
}

@Group({
  name: "tasks",
  description: "Gateway task read commands",
  scope: "open",
})
class GatewayTasksCommands {
  @Command({ name: "list", description: "Noisy polling read" })
  @CommandAccess({ kind: "read", resource: "tasks", action: "list", risk: "low" })
  list() {
    return { ok: true };
  }

  @Command({ name: "show", description: "Noisy polling read" })
  @CommandAccess({ kind: "read", resource: "tasks", action: "show", risk: "low", input: ["taskId"] })
  show(@Arg("taskId", { description: "Task id" }) taskId: string) {
    if (taskId === "boom") throw new Error("task exploded");
    return { taskId };
  }
}

@Group({
  name: "gated",
  description: "Skill-gated admin commands",
  scope: "admin",
})
class GatewayGatedCommands {
  @Command({ name: "ping", description: "Gated ping" })
  @CommandAccess({ kind: "read", resource: "gated", action: "ping", risk: "low" })
  ping() {
    return { ok: true };
  }
}

const registry = buildRegistry([
  GatewayDemoCommands,
  GatewaySuperadminCommands,
  GatewaySessionsCommands,
  GatewayTasksCommands,
  GatewayGatedCommands,
]);
const appsRegistry = buildRegistry([AppsCommands]);

function findCmd(fullName: string) {
  const cmd = registry.commands.find((c) => c.fullName === fullName);
  if (!cmd) throw new Error(`fixture missing: ${fullName}`);
  return cmd;
}

function findAppCmd(fullName: string) {
  const cmd = appsRegistry.commands.find((candidate) => candidate.fullName === fullName);
  if (!cmd) throw new Error(`app fixture missing: ${fullName}`);
  return cmd;
}

function captureAudits(): {
  events: AuditEvent[];
  emit: (e: AuditEvent) => void;
} {
  const events: AuditEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function gatewayContext(capabilities: ContextCapability[], agentId = "gateway-agent"): ContextRecord {
  return {
    contextId: `ctx_${agentId}`,
    contextKey: `rctx_${agentId}`,
    kind: "test-runtime",
    agentId,
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

function executeGroup(objectId: string): ContextCapability {
  return { permission: "execute", objectType: "group", objectId, source: "test" };
}

function semanticCap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

function adminSystem(): ContextCapability {
  return { permission: "admin", objectType: "system", objectId: "*", source: "test" };
}

const demoContext = gatewayContext([executeGroup("demo")]);
const appsContext = gatewayContext([semanticCap("read", "apps", "show")], "gateway-apps");
const sessionsContext = gatewayContext([executeGroup("sessions")]);
const tasksContext = gatewayContext([executeGroup("tasks")]);
const secretContext = gatewayContext([executeGroup("secret"), adminSystem()]);

describe("dispatch — body shape (flat-only)", () => {
  it("accepts a flat body with args + options merged at top level", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.echo"),
      { name: "rafa", shout: true, limit: "5" },
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as {
      name: string;
      shout: boolean;
      limit: string;
    };
    expect(body.name).toBe("rafa");
    expect(body.shout).toBe(true);
    expect(body.limit).toBe("5");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("demo_echo");
    expect(audits.events[0]?.input).toMatchObject({
      name: "rafa",
      shout: true,
      limit: "5",
    });
  });

  it("redacts command-declared fields from gateway audits", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.redacted"),
      { content: "private message body" },
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(200);
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.input).toEqual({ content: "[REDACTED]" });
    expect(JSON.stringify(audits.events)).not.toContain("private message body");
  });

  it("rejects the wrapped {args, options} form as unknown keys", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.echo"),
      { args: ["luis"], options: { shout: true } },
      {},
      { emitAudit: audits.emit },
    );
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as {
      error: { code: string; issues: { path: string[]; code: string }[] };
    };
    expect(body.error.code).toBe("USAGE_ERROR");
    expect(body.error.issues.some((i) => i.path[0] === "args" && i.code === "unrecognized_keys")).toBe(true);
    expect(body.error.issues.some((i) => i.path[0] === "options" && i.code === "unrecognized_keys")).toBe(true);
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.outcome).toBe("usage_error");
  });

  it("rejects bodies that are JSON arrays", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), [1, 2, 3], {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(400);
    expect(audits.events).toHaveLength(1);
    const body = (await result.response.json()) as { error: { code: string; issues: { path: string[] }[] } };
    expect(body.error.code).toBe("USAGE_ERROR");
    expect(body.error.issues[0]?.path).toEqual([]);
  });

  it("rejects unknown flat keys with structured issues", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), { name: "luis", bogus: true }, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as {
      error: { code: string; issues: { path: string[]; code: string }[] };
    };
    expect(body.error.code).toBe("USAGE_ERROR");
    expect(body.error.issues.some((i) => i.path[0] === "bogus" && i.code === "unrecognized_keys")).toBe(true);
    expect(audits.events).toHaveLength(1);
  });
});

describe("dispatch — validation", () => {
  it("defaults negated flags to false and honors explicit true over the gateway", async () => {
    const audits = captureAudits();

    const defaultResult = await dispatch(
      findCmd("demo.negated"),
      {},
      {},
      {
        contextRecord: demoContext,
        emitAudit: audits.emit,
      },
    );
    const disabledResult = await dispatch(
      findCmd("demo.negated"),
      { noCache: true },
      {},
      {
        contextRecord: demoContext,
        emitAudit: audits.emit,
      },
    );

    expect(defaultResult.response.status).toBe(200);
    expect(disabledResult.response.status).toBe(200);
    expect(await defaultResult.response.json()).toEqual({ noCache: false });
    expect(await disabledResult.response.json()).toEqual({ noCache: true });
  });

  it("preserves early validation as a usage-error contract and audit", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), {}, {}, { emitAudit: audits.emit });

    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({
      success: false,
      op: "demo echo",
      exitCode: 2,
      outcome: "usage_error",
      error: {
        code: "USAGE_ERROR",
        message: "Invalid input for demo echo.",
        retryable: false,
        suggestedAction: "Correct the request body and retry demo echo",
        issues: [{ path: ["name"], code: "invalid_type" }],
      },
    });
    expect(result.audit).not.toBeNull();
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({
      group: "demo",
      name: "echo",
      tool: "demo_echo",
      input: {},
      isError: true,
      outcome: "usage_error",
      exitCode: 2,
      errorCode: "USAGE_ERROR",
    });
  });

  it("redacts sensitive values from validation errors and their audit", async () => {
    const secret = "token-private-value";
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.redacted-invalid"),
      { content: secret },
      {},
      { emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(400);
    const body = await result.response.json();
    expect(body).toMatchObject({
      error: {
        code: "USAGE_ERROR",
        issues: [{ path: ["content"], code: "custom", message: "Invalid redacted value." }],
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(audits.events)).not.toContain(secret);
  });

  it("returns a canonical HTTP 500 contract when handler return shape is wrong", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.broken"),
      {},
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );
    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as {
      success: boolean;
      op: string;
      exitCode: number;
      outcome: string;
      error: { code: string; message: string };
    };
    expect(body).toMatchObject({
      success: false,
      op: "demo broken",
      exitCode: 1,
      outcome: "failed",
      error: { code: "RETURN_SHAPE_ERROR", message: "Command returned an invalid response shape." },
    });
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({
      isError: true,
      outcome: "failed",
      exitCode: 1,
      errorCode: "RETURN_SHAPE_ERROR",
    });
  });
});

describe("dispatch — error path", () => {
  it("preserves a real AppsCommands failure as a redacted canonical response", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findAppCmd("apps.show"),
      { id: "contract-missing-app" },
      {},
      { contextRecord: appsContext, emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(422);
    const body = await result.response.json();
    expect(body).toMatchObject({
      success: false,
      op: "apps show",
      exitCode: 1,
      outcome: "failed",
      error: { code: "not_found", message: "Ravi app was not found." },
    });
    expect(JSON.stringify(body)).not.toContain("evidence");
    expect(audits.events[0]).toMatchObject({ outcome: "failed", exitCode: 1, errorCode: "not_found" });
  });

  it("normalizes RaviAppError as a redacted canonical contract and audit", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.app-error"),
      {},
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(404);
    const body = await result.response.json();
    expect(body).toMatchObject({
      success: false,
      op: "demo app-error",
      exitCode: 1,
      outcome: "failed",
      error: { code: "not_found", message: "Ravi app was not found." },
    });
    expect(JSON.stringify(body)).not.toContain("private-path");
    expect(JSON.stringify(body)).not.toContain("app-secret");
    expect(audits.events[0]).toMatchObject({ outcome: "failed", exitCode: 1, errorCode: "not_found" });
  });

  it("preserves a legacy expected failure as a non-500 contract response", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.legacy"),
      {},
      {},
      {
        contextRecord: demoContext,
        emitAudit: audits.emit,
      },
    );

    expect(result.response.status).toBe(422);
    expect(await result.response.json()).toMatchObject({
      success: false,
      op: "demo legacy",
      exitCode: 1,
      outcome: "failed",
      error: { code: "COMMAND_FAILED", message: "legacy validation failed" },
    });
    expect(audits.events[0]).toMatchObject({ outcome: "failed", exitCode: 1, errorCode: "COMMAND_FAILED" });
  });

  it("returns a redacted canonical envelope with HTTP 500 when handler throws", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.boom"), {}, {}, { contextRecord: demoContext, emitAudit: audits.emit });
    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as {
      success: boolean;
      op: string;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(body).toMatchObject({
      success: false,
      op: "demo boom",
      exitCode: 1,
      error: { code: "UNHANDLED_ERROR", message: "Command failed unexpectedly." },
    });
    expect(JSON.stringify(body)).not.toContain("kaboom");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({ isError: true, errorCode: "UNHANDLED_ERROR", exitCode: 1 });
  });

  it.each([
    ["1", 422, "DEMO_NOT_FOUND", "failed", true],
    ["2", 400, "USAGE_ERROR", "usage_error", true],
    ["3", 409, "WRITE_REQUIRES_EXECUTE", "blocked", false],
  ])("preserves ContractError exit %s as a non-500 structured response", async (exitCode, status, code, outcome, isError) => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.contract"),
      { exitCode },
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(status);
    const body = (await result.response.json()) as {
      success: boolean;
      op: string;
      exitCode: number;
      outcome: string;
      error: { code: string; message: string; retryable: boolean; suggestedAction: string };
    };
    expect(body).toEqual({
      success: false,
      op: "demo contract",
      exitCode: Number(exitCode),
      outcome,
      error: {
        code,
        message: "contract stopped execution",
        retryable: false,
        suggestedAction: "inspect the structured response",
      },
    });
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({ isError, outcome, exitCode: Number(exitCode), errorCode: code });
  });

  it("returns 200 with empty object when handler returns undefined and no @Returns", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.void"), {}, {}, { contextRecord: demoContext, emitAudit: audits.emit });
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body).toEqual({});
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(false);
  });
});

describe("dispatch — scope and superadmin gating", () => {
  it("refuses superadmin commands when allowSuperadmin is off", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("secret.ping"), {}, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as {
      error: string;
      reason: string;
    };
    expect(body.error).toBe("PermissionDenied");
    expect(body.reason).toContain("superadmin");
    expect(audits.events).toHaveLength(0);
  });

  it("admits superadmin commands when allowSuperadmin is on and context has system admin", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("secret.ping"),
      {},
      {},
      {
        allowSuperadmin: true,
        contextRecord: secretContext,
        emitAudit: audits.emit,
      },
    );
    expect(result.response.status).toBe(200);
    expect(audits.events).toHaveLength(1);
  });

  it("denies unauthorized gateway calls before invoking the handler", async () => {
    const stateDir = await createIsolatedRaviState("gateway-api-denial-");
    try {
      const audits = captureAudits();
      const result = await dispatch(
        findCmd("gated.ping"),
        {},
        {},
        { contextRecord: gatewayContext([], "locked"), emitAudit: audits.emit },
      );

      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as {
        success: boolean;
        op: string;
        exitCode: number;
        outcome: string;
        error: { code: string; message: string };
      };
      expect(body).toMatchObject({
        success: false,
        op: "gated ping",
        exitCode: 1,
        outcome: "denied",
        error: { code: "PERMISSION_DENIED" },
      });
      expect(body.error.message).toContain("cannot execute");
      expect(audits.events).toHaveLength(1);
      expect(audits.events[0]).toMatchObject({ tool: "gated_ping", outcome: "denied", errorCode: "PERMISSION_DENIED" });
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("authorizes gateway calls through command access capabilities without legacy group grants", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("gated.ping"),
      {},
      {},
      {
        contextRecord: gatewayContext([semanticCap("read", "gated", "ping")], "profile-runtime"),
        emitAudit: audits.emit,
      },
    );

    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ ok: true });
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("gated_ping");
    expect(audits.events[0]?.isError).toBe(false);
  });

  it("does not enforce runtime skill gates for API dispatches", async () => {
    const stateDir = await createIsolatedRaviState("gateway-api-no-skill-gate-");
    try {
      const context = gatewayContext([executeGroup("tasks")], "gateway-agent");

      const audits = captureAudits();
      const result = await dispatch(findCmd("tasks.list"), {}, {}, { contextRecord: context, emitAudit: audits.emit });

      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toEqual({ ok: true });
      expect(result.audit).toBeNull();
      expect(audits.events).toHaveLength(0);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});

describe("dispatch — audit", () => {
  it("emits exactly one audit per request, with tool=<group>_<command>", async () => {
    const audits = captureAudits();
    await dispatch(findCmd("demo.echo"), { name: "x" }, {}, { contextRecord: demoContext, emitAudit: audits.emit });
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("demo_echo");
    expect(audits.events[0]?.group).toBe("demo");
    expect(audits.events[0]?.name).toBe("echo");
  });

  it("emits exactly one audit even on internal error", async () => {
    const audits = captureAudits();
    await dispatch(findCmd("demo.boom"), {}, {}, { contextRecord: demoContext, emitAudit: audits.emit });
    expect(audits.events).toHaveLength(1);
  });

  it("emits one usage_error audit when input validation rejects before the handler", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), {}, {}, { emitAudit: audits.emit });
    expect(audits.events).toHaveLength(1);
    expect(result.audit).toEqual(audits.events[0]);
    expect(audits.events[0]).toMatchObject({ outcome: "usage_error", exitCode: 2, errorCode: "USAGE_ERROR" });
  });

  it("suppresses successful high-frequency read audits", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("sessions.list"),
      {},
      {},
      {
        contextRecord: sessionsContext,
        emitAudit: audits.emit,
      },
    );
    expect(result.audit).toBeNull();
    expect(audits.events).toHaveLength(0);
  });

  it("still emits audit when a high-frequency read fails", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("tasks.show"),
      { taskId: "boom" },
      {},
      {
        contextRecord: tasksContext,
        emitAudit: audits.emit,
      },
    );
    expect(result.response.status).toBe(500);
    expect(result.audit?.tool).toBe("tasks_show");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(true);
  });
});

describe("dispatch — CLI output", () => {
  it("marks gateway command context to suppress human CLI output", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.context"),
      {},
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );
    const body = (await result.response.json()) as {
      suppressCliOutput: boolean;
    };
    expect(body.suppressCliOutput).toBe(true);
  });

  it("does not render a ContractError into gateway process logs", async () => {
    const rendered: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => rendered.push(args.map(String).join(" "));
    try {
      const result = await dispatch(
        findCmd("demo.contract"),
        { exitCode: "2" },
        {},
        { contextRecord: demoContext, emitAudit: captureAudits().emit },
      );
      expect(result.response.status).toBe(400);
      expect(rendered).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("dispatch — @Returns.binary() escape hatch", () => {
  it("passes through a raw Response without JSON serialization", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.blob"), {}, {}, { contextRecord: demoContext, emitAudit: audits.emit });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("application/octet-stream");
    expect(result.response.headers.get("content-length")).toBe("3");

    const bytes = new Uint8Array(await result.response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0xff, 0x00, 0x42]);

    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("demo_blob");
    expect(audits.events[0]?.isError).toBe(false);
  });

  it("registers binary=true in the registry entry", () => {
    const cmd = findCmd("demo.blob");
    expect(cmd.binary).toBe(true);
    expect(cmd.returns).toBeUndefined();
  });

  it("rejects handlers marked binary that return non-Response values", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.wrong-blob"),
      {},
      {},
      {
        contextRecord: demoContext,
        emitAudit: audits.emit,
      },
    );

    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as {
      success: boolean;
      op: string;
      exitCode: number;
      outcome: string;
      error: { code: string; message: string; issues: { message: string }[] };
    };
    expect(body).toMatchObject({
      success: false,
      op: "demo wrong-blob",
      exitCode: 1,
      outcome: "failed",
      error: { code: "RETURN_SHAPE_ERROR", message: "Command returned an invalid response shape." },
    });
    expect(body.error.issues[0]?.message).toContain("@Returns.binary()");
    expect(body.error.issues[0]?.message).toContain("instead of a Response");

    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({
      isError: true,
      outcome: "failed",
      exitCode: 1,
      errorCode: "RETURN_SHAPE_ERROR",
    });
  });

  it("normalizes non-2xx binary responses and audits them as failed", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.missing-blob"),
      {},
      {},
      { contextRecord: demoContext, emitAudit: audits.emit },
    );

    expect(result.response.status).toBe(404);
    const body = (await result.response.json()) as {
      success: boolean;
      op: string;
      exitCode: number;
      outcome: string;
      error: { code: string; message: string };
    };
    expect(body).toMatchObject({
      success: false,
      op: "demo missing-blob",
      exitCode: 1,
      outcome: "failed",
      error: { code: "RESOURCE_NOT_FOUND", message: "Binary resource was not found." },
    });
    expect(JSON.stringify(body)).not.toContain("private storage path");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]).toMatchObject({
      isError: true,
      outcome: "failed",
      exitCode: 1,
      errorCode: "RESOURCE_NOT_FOUND",
    });
  });
});
