import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, getDb, closeRouterDb } from "../router/router-db.js";
import { classifyTaskSignal, raiseTaskStallSignal } from "./producers/task.js";
import { findSignal } from "./service.js";
import type { TaskRecord } from "../tasks/types.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-task-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER, assignee_session_name TEXT, assignee_agent_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
});

afterEach(() => {
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function insertTask(input: {
  id: string;
  status?: string;
  archivedAt?: number | null;
  sessionName?: string;
  sessionEphemeral?: boolean;
  sessionExpiresAt?: number | null;
}): TaskRecord {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO tasks (id,title,instructions,status,progress,archived_at,assignee_session_name,assignee_agent_id,created_at,updated_at)
       VALUES (?,?,?,?,0,?,?,?,?,?)`,
    )
    .run(
      input.id,
      "Task",
      "none",
      input.status ?? "in_progress",
      input.archivedAt ?? null,
      input.sessionName ?? null,
      "main",
      now,
      now,
    );
  if (input.sessionName) {
    getDb().exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY, name TEXT, agent_id TEXT NOT NULL, agent_cwd TEXT NOT NULL,
      ephemeral INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO sessions (session_key,name,agent_id,agent_cwd,ephemeral,expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        `key-${input.id}`,
        input.sessionName,
        "main",
        root,
        input.sessionEphemeral ? 1 : 0,
        input.sessionExpiresAt ?? null,
        now,
        now,
      );
  }
  return {
    id: input.id,
    status: input.status ?? "in_progress",
    progress: 0,
    updatedAt: now,
    assigneeAgentId: "main",
    assigneeSessionName: input.sessionName ?? null,
  } as TaskRecord;
}

describe("task signal producer", () => {
  it("never signals an archived task, even with status=in_progress", () => {
    const task = insertTask({ id: "task-archived", archivedAt: Date.now(), sessionName: "v5-probe" });
    const result = raiseTaskStallSignal({
      task,
      observation: { turnActive: false, pendingCount: 0 },
      sourceSession: "v5-probe",
    });
    expect(result.classification.action).toBe("none");
    expect(result.raised).toBeUndefined();
    expect(findSignal("task.stalled.task-archived")).toBeNull();
    expect(findSignal("task.orphaned.task-archived")).toBeNull();
  });

  it("never signals a task whose ephemeral session ended", () => {
    const task = insertTask({
      id: "task-ephemeral",
      sessionName: "v5-probe",
      sessionEphemeral: true,
      sessionExpiresAt: Date.now() - 60_000,
    });
    const result = raiseTaskStallSignal({
      task,
      observation: { turnActive: false, pendingCount: 0 },
      sourceSession: "v5-probe",
    });
    expect(result.classification.action).toBe("none");
    expect(findSignal("task.orphaned.task-ephemeral")).toBeNull();
  });

  it("classifies an active turn with no progress as a piggyback judgment", () => {
    const task = insertTask({ id: "task-stall", sessionName: "work-session" });
    expect(classifyTaskSignal(task, { turnActive: true, pendingCount: 0 }).action).toBe("stall");
    const result = raiseTaskStallSignal({
      task,
      observation: { turnActive: true, pendingCount: 0 },
      sourceSession: "work-session",
    });
    expect(result.classification.action).toBe("stall");
    const signal = findSignal("task.stalled.task-stall");
    expect(signal?.kind).toBe("judgment");
    expect(signal?.severity).toBe("piggyback");
    expect(signal?.producerClass).toBe("task-observer");
  });

  it("classifies an inactive turn without queue as an orphan fact", () => {
    const task = insertTask({ id: "task-orphan", sessionName: "work-session" });
    const result = raiseTaskStallSignal({
      task,
      observation: { turnActive: false, pendingCount: 0 },
      sourceSession: "work-session",
    });
    expect(result.classification.action).toBe("orphan");
    const signal = findSignal("task.orphaned.task-orphan");
    expect(signal?.kind).toBe("fact");
    expect(signal?.severity).toBe("piggyback");
    expect(signal?.escalateAfterMs).toBeNull();
  });

  it("wait for a queued turn instead of calling it stalled", () => {
    const task = insertTask({ id: "task-queued", sessionName: "work-session" });
    expect(classifyTaskSignal(task, { turnActive: false, pendingCount: 2 }).action).toBe("none");
  });
});
