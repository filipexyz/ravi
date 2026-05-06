import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { getContext } from "../../cli/context.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { createAgent, dbUpsertSkillGateRule, getOrCreateSession, getSession } from "../../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dispatch, type AuditEvent } from "./dispatcher.js";

@Group({ name: "demo", description: "Gateway demo commands", scope: "open" })
class GatewayDemoCommands {
  @Command({ name: "echo", description: "Echo a name" })
  @Returns(z.object({ ok: z.literal(true), name: z.string(), shout: z.boolean(), limit: z.string() }))
  echo(
    @Arg("name", { description: "Recipient" }) name: string,
    @Option({ flags: "--shout", description: "Yell" }) shout?: boolean,
    @Option({ flags: "--limit <n>", description: "Limit", defaultValue: "10" }) limit?: string,
  ) {
    return { ok: true as const, name, shout: shout === true, limit: String(limit ?? "10") };
  }

  @Command({ name: "void", description: "Returns nothing" })
  voidNoop(): void {
    return;
  }

  @Command({ name: "context", description: "Inspect gateway tool context" })
  context() {
    console.log("human CLI output should not leak through the SDK gateway");
    return { suppressCliOutput: getContext()?.suppressCliOutput === true };
  }

  @Command({ name: "broken", description: "Returns wrong shape" })
  @Returns(z.object({ ok: z.literal(true) }))
  broken() {
    return { ok: false } as unknown as { ok: true };
  }

  @Command({ name: "boom", description: "Throws" })
  boom() {
    throw new Error("kaboom");
  }

  @Command({ name: "blob", description: "Returns raw binary Response" })
  @Returns.binary()
  blob() {
    return new Response(new Uint8Array([0xff, 0x00, 0x42]), {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "3" },
    });
  }

  @Command({ name: "wrong-blob", description: "Marked binary but returns plain object" })
  @Returns.binary()
  wrongBlob() {
    return { not: "a response" };
  }
}

@Group({ name: "secret", description: "Superadmin commands", scope: "superadmin" })
class GatewaySuperadminCommands {
  @Command({ name: "ping", description: "Should be hidden by default" })
  ping() {
    return { ok: true };
  }
}

@Group({ name: "sessions", description: "Gateway session read commands", scope: "open" })
class GatewaySessionsCommands {
  @Command({ name: "list", description: "Noisy polling read" })
  list() {
    return { ok: true };
  }
}

@Group({ name: "tasks", description: "Gateway task read commands", scope: "open" })
class GatewayTasksCommands {
  @Command({ name: "list", description: "Noisy polling read" })
  list() {
    return { ok: true };
  }

  @Command({ name: "show", description: "Noisy polling read" })
  show(@Arg("taskId", { description: "Task id" }) taskId: string) {
    if (taskId === "boom") throw new Error("task exploded");
    return { taskId };
  }
}

@Group({ name: "gated", description: "Skill-gated admin commands", scope: "admin" })
class GatewayGatedCommands {
  @Command({ name: "ping", description: "Gated ping" })
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

function findCmd(fullName: string) {
  const cmd = registry.commands.find((c) => c.fullName === fullName);
  if (!cmd) throw new Error(`fixture missing: ${fullName}`);
  return cmd;
}

function captureAudits(): { events: AuditEvent[]; emit: (e: AuditEvent) => void } {
  const events: AuditEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function writeCodexSkill(root: string, name: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\nUse this skill before running the tool.\n`,
  );
}

describe("dispatch — body shape (flat-only)", () => {
  it("accepts a flat body with args + options merged at top level", async () => {
    const audits = captureAudits();
    const result = await dispatch(
      findCmd("demo.echo"),
      { name: "rafa", shout: true, limit: "5" },
      {},
      { emitAudit: audits.emit },
    );
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as { name: string; shout: boolean; limit: string };
    expect(body.name).toBe("rafa");
    expect(body.shout).toBe(true);
    expect(body.limit).toBe("5");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("demo_echo");
    expect(audits.events[0]?.input).toMatchObject({ name: "rafa", shout: true, limit: "5" });
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
    const body = (await result.response.json()) as { error: string; issues: { path: string[]; code: string }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues.some((i) => i.path[0] === "args" && i.code === "unrecognized_keys")).toBe(true);
    expect(body.issues.some((i) => i.path[0] === "options" && i.code === "unrecognized_keys")).toBe(true);
    expect(audits.events).toHaveLength(0);
  });

  it("rejects bodies that are JSON arrays", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), [1, 2, 3], {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(400);
    expect(audits.events).toHaveLength(0);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe("BadRequest");
  });

  it("rejects unknown flat keys with structured issues", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), { name: "luis", bogus: true }, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string; issues: { path: string[]; code: string }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues.some((i) => i.path[0] === "bogus" && i.code === "unrecognized_keys")).toBe(true);
    expect(audits.events).toHaveLength(0);
  });
});

describe("dispatch — validation", () => {
  it("returns 400 ValidationError when required arg is missing", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.echo"), {}, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues[0]?.path[0]).toBe("name");
    expect(audits.events).toHaveLength(0);
  });

  it("returns 500 ReturnShapeError when handler return shape is wrong", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.broken"), {}, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe("ReturnShapeError");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(true);
  });
});

describe("dispatch — error path", () => {
  it("returns 500 InternalError when handler throws", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.boom"), {}, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as { error: string; message: string };
    expect(body.error).toBe("InternalError");
    expect(body.message).toContain("kaboom");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(true);
  });

  it("returns 200 with empty object when handler returns undefined and no @Returns", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.void"), {}, {}, { emitAudit: audits.emit });
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
    const body = (await result.response.json()) as { error: string; reason: string };
    expect(body.error).toBe("PermissionDenied");
    expect(body.reason).toContain("superadmin");
    expect(audits.events).toHaveLength(0);
  });

  it("admits superadmin commands when allowSuperadmin is on (anonymous local-host bypass)", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("secret.ping"), {}, {}, { allowSuperadmin: true, emitAudit: audits.emit });
    expect(result.response.status).toBe(200);
    expect(audits.events).toHaveLength(1);
  });

  it("checks scope before delivering a required skill", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const stateDir = await createIsolatedRaviState("gateway-skill-gate-");

    try {
      process.env.CODEX_HOME = join(stateDir, "codex");
      writeCodexSkill(process.env.CODEX_HOME, "demo-skill");
      dbUpsertSkillGateRule({ id: "gated", pattern: "^gated(?:[._]|$)", skill: "demo-skill" });
      createAgent({ id: "locked", cwd: stateDir });
      getOrCreateSession("agent:locked:main", "locked", stateDir, {
        name: "locked-session",
        runtimeProvider: "codex",
        providerSessionId: "thread-1",
        runtimeSessionDisplayId: "thread-1",
      });
      const context = createRuntimeContext({
        kind: "agent-runtime",
        agentId: "locked",
        sessionKey: "agent:locked:main",
        sessionName: "locked-session",
      });

      const audits = captureAudits();
      const result = await dispatch(
        findCmd("gated.ping"),
        {},
        { agentId: "locked", sessionKey: "agent:locked:main", sessionName: "locked-session" },
        { contextRecord: context, emitAudit: audits.emit },
      );

      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string; reason: string };
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toContain("requires execute");
      expect(getSession("agent:locked:main")?.runtimeSessionParams?.skillVisibility).toBeUndefined();
      expect(audits.events).toHaveLength(1);
      expect(audits.events[0]?.tool).toBe("gated_ping");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});

describe("dispatch — audit", () => {
  it("emits exactly one audit per request, with tool=<group>_<command>", async () => {
    const audits = captureAudits();
    await dispatch(findCmd("demo.echo"), { name: "x" }, {}, { emitAudit: audits.emit });
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.tool).toBe("demo_echo");
    expect(audits.events[0]?.group).toBe("demo");
    expect(audits.events[0]?.name).toBe("echo");
  });

  it("emits exactly one audit even on internal error", async () => {
    const audits = captureAudits();
    await dispatch(findCmd("demo.boom"), {}, {}, { emitAudit: audits.emit });
    expect(audits.events).toHaveLength(1);
  });

  it("does not emit audit for validation errors (request never reached the handler)", async () => {
    const audits = captureAudits();
    await dispatch(findCmd("demo.echo"), {}, {}, { emitAudit: audits.emit });
    expect(audits.events).toHaveLength(0);
  });

  it("suppresses successful high-frequency read audits", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("sessions.list"), {}, {}, { emitAudit: audits.emit });
    expect(result.audit).toBeNull();
    expect(audits.events).toHaveLength(0);
  });

  it("still emits audit when a high-frequency read fails", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("tasks.show"), { taskId: "boom" }, {}, { emitAudit: audits.emit });
    expect(result.response.status).toBe(500);
    expect(result.audit?.tool).toBe("tasks_show");
    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(true);
  });
});

describe("dispatch — CLI output", () => {
  it("marks gateway command context to suppress human CLI output", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.context"), {}, {}, { emitAudit: audits.emit });
    const body = (await result.response.json()) as { suppressCliOutput: boolean };
    expect(body.suppressCliOutput).toBe(true);
  });
});

describe("dispatch — @Returns.binary() escape hatch", () => {
  it("passes through a raw Response without JSON serialization", async () => {
    const audits = captureAudits();
    const result = await dispatch(findCmd("demo.blob"), {}, {}, { emitAudit: audits.emit });

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
    const result = await dispatch(findCmd("demo.wrong-blob"), {}, {}, { emitAudit: audits.emit });

    expect(result.response.status).toBe(500);
    const body = (await result.response.json()) as { error: string; issues: { message: string }[] };
    expect(body.error).toBe("ReturnShapeError");
    expect(body.issues[0]?.message).toContain("@Returns.binary()");
    expect(body.issues[0]?.message).toContain("instead of a Response");

    expect(audits.events).toHaveLength(1);
    expect(audits.events[0]?.isError).toBe(true);
  });
});
