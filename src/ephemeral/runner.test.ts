import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { nats } from "../nats.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOrCreateSession, getSessionByName, setSessionEphemeral } from "../router/sessions.js";
import { getDb } from "../router/router-db.js";
import { dbBlockTask, dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";
import { PRUNE_BOOT_DELAY_MS, runEphemeralCleanupTick, startEphemeralRunner, stopEphemeralRunner } from "./runner.js";

function insertStaleSessionEvents(count: number): void {
  // Recent enough that startup rollup does not walk from 1970, old enough to
  // be past the 7-day session_events TTL when prune finally runs.
  const staleAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const stmt = getDb().prepare(`
    INSERT INTO session_events (session_key, seq, event_type, event_group, timestamp, created_at)
    VALUES ('agent:dev:ttl-boot', ?, 'turn.complete', 'runtime', ?, ?)
  `);
  for (let index = 0; index < count; index += 1) {
    stmt.run(index + 1, staleAt, staleAt);
  }
}

function countSessionEvents(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS c FROM session_events").get() as { c: number }).c);
}

describe("ephemeral orphan task reap", () => {
  let stateDir: string | null = null;

  afterEach(async () => {
    await stopEphemeralRunner();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("expires an ephemeral task-work session when the task is blocked", async () => {
    stateDir = await createIsolatedRaviState("ravi-ephemeral-orphan-blocked-");
    const created = dbCreateTask({
      title: "Blocked orphan reap",
      instructions: "Blocked work sessions should be reaped",
      createdBy: "test",
    });
    const sessionName = `${created.task.id}-work`;
    const entry = getOrCreateSession("agent:dev:test:orphan-blocked", "dev", stateDir, { name: sessionName });
    setSessionEphemeral(entry.sessionKey, 24 * 60 * 60_000);
    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });
    dbBlockTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName,
      message: "waiting on an operator",
    });

    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    try {
      await runEphemeralCleanupTick();
      expect(getSessionByName(sessionName)).toBeNull();
    } finally {
      emitSpy.mockRestore();
    }
  });

  it("keeps an ephemeral task-work session while the task is still serving", async () => {
    stateDir = await createIsolatedRaviState("ravi-ephemeral-orphan-serving-");
    const created = dbCreateTask({
      title: "Serving work session",
      instructions: "In-progress work sessions must stay",
      createdBy: "test",
    });
    const sessionName = `${created.task.id}-work`;
    const entry = getOrCreateSession("agent:dev:test:orphan-serving", "dev", stateDir, { name: sessionName });
    setSessionEphemeral(entry.sessionKey, 24 * 60 * 60_000);
    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    try {
      await runEphemeralCleanupTick();
      expect(getSessionByName(sessionName)?.sessionKey).toBe(entry.sessionKey);
    } finally {
      emitSpy.mockRestore();
    }
  });
});

describe("ephemeral TTL prune boot scheduling", () => {
  let stateDir: string | null = null;

  afterEach(async () => {
    await stopEphemeralRunner();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("does not run an unbounded prune on start and only prunes after the boot delay", async () => {
    stateDir = await createIsolatedRaviState("ravi-ephemeral-prune-boot-");
    insertStaleSessionEvents(5);

    const db = getDb();
    const sessionEventDeletes: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/DELETE FROM session_events/i.test(sql)) sessionEventDeletes.push(sql);
      return originalPrepare(sql);
    };

    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    try {
      expect(PRUNE_BOOT_DELAY_MS).toBeGreaterThan(30_000);
      await startEphemeralRunner({ pruneBootDelayMs: 80 });
      expect(countSessionEvents()).toBe(5);
      expect(sessionEventDeletes).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(countSessionEvents()).toBe(0);
      expect(sessionEventDeletes.length).toBeGreaterThan(0);
      expect(sessionEventDeletes.every((sql) => sql.includes("LIMIT ?"))).toBe(true);
    } finally {
      emitSpy.mockRestore();
    }
  });

  it("cancels a pending startup prune when the runner stops", async () => {
    stateDir = await createIsolatedRaviState("ravi-ephemeral-prune-stop-");
    insertStaleSessionEvents(3);

    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    try {
      await startEphemeralRunner({ pruneBootDelayMs: 5_000 });
      expect(countSessionEvents()).toBe(3);
      await stopEphemeralRunner();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(countSessionEvents()).toBe(3);
    } finally {
      emitSpy.mockRestore();
    }
  });
});
