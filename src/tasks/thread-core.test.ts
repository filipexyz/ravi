import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, dbCreateAgent, getDb } from "../router/router-db.js";
import { closeSessionStore, deleteSessionByName, getOrCreateSession, resolveSession } from "../router/sessions.js";
import { getThreadById, listThreadEntries, updateThreadStatus } from "../threads/service.js";
import { admitTaskDispatch, prepareTaskDispatch, publishTaskDispatch } from "./dispatch-admission.js";
import {
  dbCreateTask,
  dbDispatchTask,
  dbCompleteTask,
  dbGetTask,
  dbGetActiveAssignment,
  dbListAssignments,
  dbDecideTask,
} from "./task-db.js";
import { migrateTaskThreads } from "./thread-state.js";
import { setTaskSessionPromptPublisherForTests } from "./session-publisher.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { RuntimeStartCapacityError } from "../runtime/start-admission.js";
import { listLocalInboxItems } from "../inbox/local-db.js";

const actualNats = { ...(await import("../nats.js")) };
mock.module("../nats.js", () => ({
  ...actualNats,
  nats: { ...actualNats.nats, emit: async () => {} },
  publish: async () => {},
}));
const slackLifecycle = await import("../channels/slack/thread-lifecycle.js");
const { createTask, dispatchTask, completeTask, recoverActiveTasksAfterRestart } = await import("./service.js");
const { RuntimePromptSubscription } = await import("../runtime/prompt-subscription.js");
import { logger } from "../utils/logger.js";
logger.setLevel("error");
let stateDir: string;
let channelCalls: Array<{ mockRestore(): void }> = [];
let published: RuntimeLaunchPrompt[];
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-thread-core-");
  dbCreateAgent({ id: "worker", cwd: stateDir });
  channelCalls = [
    spyOn(slackLifecycle, "finalizeSlackThreadCreation").mockImplementation(() => {
      throw new Error("Channel lifecycle called");
    }),
    spyOn(slackLifecycle, "closeSlackThread").mockImplementation(() => {
      throw new Error("Channel lifecycle called");
    }),
    spyOn(slackLifecycle, "ensureSlackThreadLifecycleForSession").mockImplementation(() => {
      throw new Error("Channel lifecycle called");
    }),
  ];
  published = [];
  setTaskSessionPromptPublisherForTests(async (_name, payload) => {
    published.push(payload as unknown as RuntimeLaunchPrompt);
  });
});
afterEach(async () => {
  for (const spy of channelCalls) spy.mockRestore();
  setTaskSessionPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
});
afterAll(() => {
  mock.module("../nats.js", () => actualNats);
});

function fixture() {
  const { task } = dbCreateTask({ title: "Offline work", instructions: "Compute a result" });
  getOrCreateSession(`agent:main:thread:${task.threadId}`, "main", stateDir, { name: "offline-work" });
  const dispatched = dbDispatchTask(task.id, { agentId: "main", sessionName: "offline-work" });
  const prompt = prepareTaskDispatch(dispatched.task, dispatched.assignment, "Compute a result");
  return { ...dispatched, prompt };
}
function count(table: string) {
  return (getDb().query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function execution(id: string) {
  return getDb().query("SELECT execution_status FROM task_assignments WHERE id=?").get(id);
}

describe("channel-independent task threads", () => {
  it("runs create → dispatch → admission → completion with zero channels and one executor", async () => {
    const created = createTask({
      title: "Channel-free",
      instructions: "Return 42",
      profileId: "default",
      idempotencyKey: "zero",
    });
    const again = createTask({
      title: "Channel-free",
      instructions: "Return 42",
      profileId: "default",
      idempotencyKey: "zero",
    });
    expect(again.task.id).toBe(created.task.id);
    const first = await dispatchTask(created.task.id, { agentId: "worker", sessionName: "offline-worker" });
    const second = await dispatchTask(created.task.id, { agentId: "worker", sessionName: "offline-worker" });
    expect(second.assignment.id).toBe(first.assignment.id);
    expect(resolveSession(first.sessionName)?.sessionKey).toBe(`agent:worker:thread:${created.task.threadId}`);
    let executions = 0;
    const execute = async () => {
      executions++;
      await completeTask(created.task.id, { message: "42", agentId: "worker", sessionName: first.sessionName });
    };
    await Promise.all(published.map((p) => admitTaskDispatch(first.sessionName, p, execute)));
    expect(executions).toBe(1);
    expect(dbGetTask(created.task.id)?.status).toBe("done");
    expect(getThreadById(created.task.threadId)?.status).toBe("resolved");
    expect(getThreadById(created.task.threadId)?.summary).toBe("42");
    expect(published.every((p) => !p.source && p._thread?.id === created.task.threadId)).toBe(true);
    for (const table of ["chats", "session_chat_subscriptions", "slack_thread_lifecycle"]) expect(count(table)).toBe(0);
    expect(count("threads")).toBe(1);
    expect(count("thread_handoffs")).toBe(1);
    await expect(dispatchTask(created.task.id, { agentId: "worker", sessionName: first.sessionName })).rejects.toThrow(
      "terminal",
    );
  });

  it("preserves an existing executor key across expiry and publication retry", async () => {
    getOrCreateSession("legacy-executor-key", "worker", stateDir, { name: "legacy-worker" });
    const { task } = createTask({ title: "Keep identity", instructions: "Work", profileId: "default" });
    const first = await dispatchTask(task.id, { agentId: "worker", sessionName: "legacy-worker" });
    expect(published[0]?._taskSessionKey).toBe("legacy-executor-key");
    deleteSessionByName("legacy-worker");
    const second = await dispatchTask(task.id, { agentId: "worker", sessionName: "legacy-worker" });
    expect(second.assignment.id).toBe(first.assignment.id);
    expect(resolveSession("legacy-worker")?.sessionKey).toBe("legacy-executor-key");
    expect(published[1]).toEqual(published[0]);
  });

  it("creation retries reuse IDs; changed input and invalid thread references fail closed", () => {
    const input = { title: "Once", instructions: "One task", idempotencyKey: "request" };
    const first = dbCreateTask(input);
    expect(dbCreateTask({ ...input }).task).toEqual(first.task);
    expect(() => dbCreateTask({ ...input, title: "Another" })).toThrow("different input");
    expect(count("threads")).toBe(1);
    expect(() => getDb().query("UPDATE tasks SET thread_id=NULL WHERE id=?").run(first.task.id)).toThrow();
    expect(() => getDb().query("DELETE FROM threads WHERE id=?").run(first.task.threadId)).toThrow();
    expect(() => updateThreadStatus(first.task.threadId, "closed")).toThrow("task runtime");
  });

  it("rolls back task, thread and entries when creation fails", () => {
    dbCreateTask({ title: "Seed", instructions: "Seed" });
    getDb().exec(
      "CREATE TRIGGER inject_create BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(() => dbCreateTask({ title: "Rollback", instructions: "No orphan" })).toThrow("injected");
    expect(count("tasks")).toBe(1);
    expect(count("threads")).toBe(1);
  });

  it("rolls back task, assignment, event and thread result if the final write fails", () => {
    const { task, assignment } = fixture();
    const before = count("task_events");
    getDb().exec(
      "CREATE TRIGGER inject_result BEFORE INSERT ON thread_entries WHEN NEW.kind='summary' BEGIN SELECT RAISE(ABORT,'injected result failure'); END",
    );
    expect(() => dbCompleteTask(task.id, { message: "Result" })).toThrow("injected");
    expect(dbGetTask(task.id)?.status).toBe("dispatched");
    expect(dbGetActiveAssignment(task.id)?.id).toBe(assignment.id);
    expect(getThreadById(task.threadId)?.status).toBe("active");
    expect(count("task_events")).toBe(before);
    getDb().exec("DROP TRIGGER inject_result");
    dbCompleteTask(task.id, { message: "Result" });
    dbCompleteTask(task.id, { message: "Duplicate" });
    expect(
      listThreadEntries(task.threadId)
        .filter((e) => e.kind === "summary")
        .map((e) => e.body),
    ).toEqual(["Result"]);
  });

  it("blocks completion while a decision or answer admission is pending", () => {
    const { task } = fixture();
    dbDecideTask(task.id, { key: "choose", ask: "Which result?" });
    expect(() => dbCompleteTask(task.id, { message: "Result" })).toThrow("open decision");
    expect(getThreadById(task.threadId)?.status).toBe("active");
    getDb().exec("UPDATE decisions SET status='answered',answer='A'");
    getDb().exec(
      "INSERT INTO decision_deliveries(id,decision_id,kind,revision,status,created_at) SELECT 'answer',id,'answer',1,'uncertain',0 FROM decisions",
    );
    expect(() => dbCompleteTask(task.id, { message: "Result" })).toThrow("undelivered answer");
    getDb().exec("UPDATE decision_deliveries SET status='delivered'");
    expect(dbCompleteTask(task.id, { message: "Result" }).task.status).toBe("done");
  });

  it("admits concurrent duplicates once and preserves the receipt across DB reopen", async () => {
    const { prompt, assignment, task } = fixture();
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = admitTaskDispatch("offline-work", prompt, async () => {
      calls++;
      await pending;
    });
    await admitTaskDispatch("offline-work", prompt, async () => {
      calls++;
    });
    expect(calls).toBe(1);
    release();
    await first;
    closeSessionStore();
    closeRouterDb();
    await admitTaskDispatch("offline-work", prompt, async () => {
      calls++;
    });
    expect(execution(assignment.id)).toEqual({ execution_status: "admitted" });
    expect(calls).toBe(1);
    expect(() => dbDispatchTask(task.id, { agentId: "worker", sessionName: "another" })).toThrow("admitted");
    deleteSessionByName("offline-work");
    await admitTaskDispatch("offline-work", prompt, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it("retains a capacity-refused task across restart and admits only its explicit transport resumption", async () => {
    const { prompt, assignment, task } = fixture();
    let saturated = true;
    const handle = mock(async (_name: string, accepted: RuntimeLaunchPrompt) => {
      expect(accepted).toEqual(prompt);
      if (saturated)
        throw new RuntimeStartCapacityError({
          lane: "background",
          reason: "concurrency_limit",
          active: 1,
          reserved: 0,
          max: 1,
          backgroundLimit: 1,
          queuePosition: null,
          occupants: [],
          largestConsumer: null,
        });
    });
    const subscription = new RuntimePromptSubscription({
      isRunning: () => true,
      canAcceptPrompt: () => true,
      getStreamingSessionCount: () => 1,
      markConsumerReady: () => {},
      handlePrompt: handle,
      startCapacityRetryDelaysMs: [1, 5],
    });
    const message = {
      info: { stream: "SESSION_PROMPTS", streamSequence: 1, timestampNanos: 1 },
      subject: "ravi.session.offline-work.prompt",
      ack: mock(() => {}),
      nak: mock(() => {}),
    };
    const dispatch = (envelope: typeof message) =>
      (subscription as any).dispatchPrompt("offline-work", prompt, envelope);
    await dispatch(message);
    expect(handle).toHaveBeenCalledTimes(3);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(execution(assignment.id)).toEqual({ execution_status: "refused" });
    expect(listLocalInboxItems()).toHaveLength(1);
    closeSessionStore();
    closeRouterDb();
    expect((await recoverActiveTasksAfterRestart()).recoveredTaskIds).not.toContain(task.id);
    expect(await publishTaskDispatch(task, assignment, "automatic retry")).toBe(false);
    expect(published).toHaveLength(0);
    saturated = false;
    await dispatch(message);
    expect(handle).toHaveBeenCalledTimes(3);
    await dispatch({ ...message, info: { ...message.info, streamSequence: 2 } });
    expect(handle).toHaveBeenCalledTimes(4);
    expect(execution(assignment.id)).toEqual({ execution_status: "admitted" });
    await dispatch({ ...message, info: { ...message.info, streamSequence: 3 } });
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it("holds ambiguous admission as uncertain and never retries the task", async () => {
    const { prompt, assignment, task } = fixture();
    let calls = 0;
    await expect(
      admitTaskDispatch("offline-work", prompt, async () => {
        calls++;
        throw new Error("lost acknowledgement");
      }),
    ).rejects.toThrow("lost");
    await admitTaskDispatch("offline-work", prompt, async () => {
      calls++;
    });
    expect(await publishTaskDispatch(task, assignment, "retry")).toBe(false);
    expect(execution(assignment.id)).toEqual({ execution_status: "uncertain" });
    expect(() => dbDispatchTask(task.id, { agentId: "worker", sessionName: "another" })).toThrow("uncertain");
    expect(calls).toBe(1);
    const recovered = await recoverActiveTasksAfterRestart();
    expect(recovered.recoveredTaskIds).not.toContain(task.id);
    expect(published).toHaveLength(0);
  });

  it("retries publication with the frozen payload without another assignment or handoff", async () => {
    const { task, assignment, prompt } = fixture();
    setTaskSessionPromptPublisherForTests(async () => {
      throw new Error("publish timeout");
    });
    await expect(publishTaskDispatch(task, assignment, "changed")).rejects.toThrow("publish timeout");
    setTaskSessionPromptPublisherForTests(async (_name, p) => {
      published.push(p as unknown as RuntimeLaunchPrompt);
    });
    await publishTaskDispatch(task, assignment, "changed again");
    expect(published[0]).toEqual(prompt);
    expect(dbListAssignments(task.id)).toHaveLength(1);
    expect(count("thread_handoffs")).toBe(1);
  });

  it("rejects target/envelope tampering and ignores a superseded assignment", async () => {
    const { task, prompt } = fixture();
    const handle = mock(async () => {});
    await expect(admitTaskDispatch("other", prompt, handle)).rejects.toThrow("target");
    await expect(admitTaskDispatch("offline-work", { ...prompt, prompt: "altered" }, handle)).rejects.toThrow(
      "envelope",
    );
    dbDispatchTask(task.id, { agentId: "main", sessionName: "next-worker" });
    await admitTaskDispatch("offline-work", prompt, handle);
    expect(handle).not.toHaveBeenCalled();
  });

  it("imports existing task rows idempotently without changing session keys or pending payloads", () => {
    const { task, assignment, prompt } = fixture();
    const session = resolveSession("offline-work")!;
    const payload = getDb().query("SELECT dispatch_payload_json FROM task_assignments WHERE id=?").get(assignment.id);
    getDb().exec(`DROP TRIGGER tasks_require_thread_insert; DROP TRIGGER tasks_require_thread_update;
      DROP TRIGGER tasks_retain_thread; DROP INDEX idx_tasks_thread; PRAGMA foreign_keys=OFF;
      CREATE TABLE legacy_tasks AS SELECT * FROM tasks;
      ALTER TABLE legacy_tasks DROP COLUMN thread_id;
      DROP TABLE tasks; ALTER TABLE legacy_tasks RENAME TO tasks;
      CREATE UNIQUE INDEX legacy_task_pk ON tasks(id);
      PRAGMA foreign_keys=ON;`);
    migrateTaskThreads(getDb());
    const imported = dbGetTask(task.id)!;
    migrateTaskThreads(getDb());
    expect(dbGetTask(task.id)?.threadId).toBe(imported.threadId);
    expect(resolveSession("offline-work")?.sessionKey).toBe(session.sessionKey);
    expect(getDb().query("SELECT dispatch_payload_json FROM task_assignments WHERE id=?").get(assignment.id)).toEqual(
      payload,
    );
    expect(imported.id).toBe(task.id);
    expect(imported.instructions).toBe(task.instructions);
    expect(getThreadById(imported.threadId)?.metadata?.createdVia).toBe("task.import");
    expect(prompt._thread?.id).toBe(task.threadId);
  });
});
