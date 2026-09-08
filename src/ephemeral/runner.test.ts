import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { nats } from "../nats.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOrCreateSession, getSessionByName, setSessionEphemeral } from "../router/sessions.js";
import { dbBlockTask, dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";
import { runEphemeralCleanupTick } from "./runner.js";

describe("ephemeral orphan task reap", () => {
  let stateDir: string | null = null;

  afterEach(async () => {
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
