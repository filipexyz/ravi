import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, getDb, closeRouterDb } from "../router/router-db.js";
import type { RaiseSignalInput } from "./types.js";
import {
  effectiveSeverity,
  evaluateClearExpression,
  normalizeScope,
  parseClearExpression,
  validateClearWhen,
} from "./validation.js";
import { ackSignal, listSignals, muteSignal, raiseSignal, resolveSignal, unmuteSignal } from "./service.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-model-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
});

afterEach(() => {
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function factInput(overrides: Partial<RaiseSignalInput> = {}): RaiseSignalInput {
  return {
    key: "test.fact",
    kind: "fact" as const,
    producerId: "test.code",
    producerClass: "code" as const,
    producerType: "code" as const,
    scopeType: "fleet" as const,
    scopeId: "fleet",
    severity: "piggyback" as const,
    title: "Test fact",
    clearWhen: { type: "producer_resolve" as const, ttl_ms: 60_000 },
    ...overrides,
  };
}

describe("signals validation", () => {
  it("parses fleet and typed scopes", () => {
    expect(normalizeScope("fleet")).toEqual({ scopeType: "fleet", scopeId: "fleet" });
    expect(normalizeScope("agent:main")).toEqual({ scopeType: "agent", scopeId: "main" });
    expect(() => normalizeScope("nope:main")).toThrow();
  });

  it("caps severity by kind and producer class", () => {
    expect(effectiveSeverity("interrupt", "judgment", "task-observer")).toBe("piggyback");
    expect(effectiveSeverity("interrupt", "judgment", "observer")).toBe("piggyback");
    expect(effectiveSeverity("nudge", "fact", "task-observer")).toBe("nudge");
    expect(effectiveSeverity("page", "fact", "code")).toBe("page");
  });

  it("evaluates a tiny left-to-right expression", () => {
    expect(evaluateClearExpression("free_pct >= 20", { free_pct: 20 })).toBe(true);
    expect(evaluateClearExpression("a > 1 and b < 3", { a: 2, b: 2 })).toBe(true);
    expect(evaluateClearExpression("a > 1 or b < 3", { a: 0, b: 4 })).toBe(false);
    expect(() => parseClearExpression("a > 1 and b < 2 and c == 3 and d == 4")).toThrow();
  });

  it("rejects judgment probe rules and fact decay rules", () => {
    expect(() =>
      validateClearWhen(
        { type: "probe", probe: "host.disk", expr: "free_pct >= 20", recheck_ms: 60_000, grace_ms: 0 },
        "judgment",
      ),
    ).toThrow();
    expect(() => validateClearWhen({ type: "decay", after_ms: 1000 }, "fact")).toThrow();
  });
});

describe("signals service", () => {
  it("rejects a judgment above its ceiling", () => {
    expect(() =>
      raiseSignal({
        ...factInput(),
        kind: "judgment",
        producerType: "agent",
        producerClass: "agent",
        severity: "interrupt",
        clearWhen: { type: "decay", after_ms: 60_000 },
      }),
    ).toThrow();
  });

  it("rejects a fact raised by an agent", () => {
    expect(() => raiseSignal({ ...factInput(), producerType: "agent" })).toThrow();
  });

  it("upserts the same key instead of duplicating", () => {
    const first = raiseSignal(factInput());
    const second = raiseSignal(factInput({ title: "Updated title", evidence: { value: 2 } }));
    expect(second.signal.id).toBe(first.signal.id);
    expect(second.updated).toBe(true);
    expect(listSignals({ state: "non_terminal" })).toHaveLength(1);
  });

  it("ack, mute, unmute, and resolve preserve state machine invariants", () => {
    const { signal } = raiseSignal(factInput({ key: "test.lifecycle" }));
    const acked = ackSignal({ idOrKey: signal.id, by: "agent:main", note: "seen" });
    expect(acked.state).toBe("acknowledged");

    const muted = muteSignal({ idOrKey: signal.id, forMs: 60_000, reason: "noise" });
    expect(muted.state).toBe("muted");
    expect(muted.previousState).toBe("acknowledged");

    const unmuted = unmuteSignal({ idOrKey: signal.id });
    expect(unmuted.state).toBe("acknowledged");

    const resolved = resolveSignal({ idOrKey: signal.id, reason: "verified", by: "operator:luis" });
    expect(resolved.state).toBe("resolved");
    expect(resolved.closeReason).toBe("operator");
  });

  it("rejects a subject that is terminal", () => {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER, assignee_session_name TEXT, assignee_agent_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO tasks (id,title,instructions,status,progress,archived_at,created_at,updated_at)
       VALUES ('task-archived','Archived','none','in_progress',0,?,?,?)`,
    ).run(Date.now(), Date.now(), Date.now());
    expect(() =>
      raiseSignal({
        ...factInput({ key: "task.orphaned.task-archived" }),
        subjectType: "task",
        subjectId: "task-archived",
        clearWhen: { type: "producer_resolve", ttl_ms: 60_000 },
      }),
    ).toThrow();
  });
});
