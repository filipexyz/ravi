import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runCloudTaskDispatch } from "../cli/cloud-task-dispatch.js";
import { dbSetLibraryAgentOrigin } from "../library/agents-db.js";
import { completeTask, createTask, failTask, getTaskDetails, reportTaskProgress } from "../tasks/service.js";
import type { TaskRecord } from "../tasks/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildCloudTaskPrompt,
  CLOUD_AGENT_NOT_PUBLISHED,
  CLOUD_TASK_RUN_ACTIVE,
  executeCloudTaskDispatch,
  prepareCloudTaskDispatch,
} from "./task-dispatch.js";
import {
  dbClaimCloudTaskDispatch,
  dbGetActiveCloudTaskRunForTask,
  dbGetCloudTaskDispatch,
  dbGetCloudTaskRun,
} from "./task-runs-db.js";
import { CloudTaskWatcher } from "./task-watcher.js";
import { createFakeCloudConsole, type FakeCloudConsole, fakeCloudSessionOpener } from "./test-fixtures.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cloud-task-dispatch-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** Captures console.log; returns the call's result or error and the printed lines. */
async function capture<T>(call: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await call(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = original;
  }
}

function newTask(): TaskRecord {
  return createTask({ title: "Triage the inbox", instructions: "Label every open ticket.", priority: "normal" }).task;
}

function deps(fake: FakeCloudConsole, found: boolean | "installed" = true, newIdempotencyKey?: () => string) {
  return {
    openSession: fakeCloudSessionOpener(fake),
    findLibraryAgent: async () =>
      found === true ? { ref: "clinica/triage", slug: "triage", project: "clinica", source: "library" as const } : null,
    newIdempotencyKey: newIdempotencyKey ?? (() => "ravi-task:fixed-key"),
    // Task progress without emitting on NATS.
    markInProgress: async (input: { taskId: string; actor: string; message: string }) =>
      reportTaskProgress(input.taskId, { actor: input.actor, message: input.message }),
  };
}

function dispatch(
  fake: FakeCloudConsole,
  task: TaskRecord,
  execute: boolean,
  options: { budget?: string; found?: boolean; informSession?: string | null; newKey?: () => string } = {},
) {
  return capture(() =>
    runCloudTaskDispatch(
      {
        task,
        agentId: "triage",
        ...(options.budget !== undefined ? { budget: options.budget } : {}),
        informSession: options.informSession === undefined ? "dev-main" : options.informSession,
        actor: "dev-main",
        execute,
        asJson: true,
      },
      deps(fake, options.found ?? true, options.newKey),
    ),
  );
}

describe("tasks dispatch --cloud", () => {
  it("is braked: prints the plan and starts nothing", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    const outcome = await dispatch(fake, task, false, { budget: "3" });
    expect(outcome.error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    const envelope = JSON.parse(outcome.lines.join("\n"));
    expect(envelope.error.plan).toMatchObject({
      cloud: true,
      taskId: task.id,
      agentId: "triage",
      library: { ref: "clinica/triage", source: "library" },
      project: "clinica",
      budgetUsd: 3,
      informSession: "dev-main",
    });
    expect(fake.writes()).toHaveLength(0);
    expect(dbGetActiveCloudTaskRunForTask(task.id)).toBeNull();
    expect(getTaskDetails(task.id).task?.status).toBe("open");
  });

  it("starts the run with the task origin, records it and marks the task in progress", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    const outcome = await dispatch(fake, task, true, { budget: "3" });
    expect(outcome.error).toBeUndefined();
    const start = fake.writes()[0]!;
    expect(start.path).toBe("/runs");
    expect(start.body).toMatchObject({
      project: "clinica",
      agent: "triage",
      trigger: "task",
      budgetUsd: 3,
      idempotencyKey: "ravi-task:fixed-key",
      origin: { kind: "task", sessionName: "dev-main", taskId: task.id },
    });
    expect(start.body?.origin).not.toHaveProperty("installationId");
    expect(String(start.body?.prompt)).toBe(buildCloudTaskPrompt(task));
    expect(outcome.result).toMatchObject({ mode: "cloud", cloudRun: { id: "run_1" }, task: { status: "in_progress" } });
    expect(dbGetCloudTaskRun("run_1")).toMatchObject({ taskId: task.id, sessionName: "dev-main", state: "active" });

    // A second dispatch of the same task is refused while the run is open.
    const again = await dispatch(fake, task, true);
    expect(again.error).toMatchObject({ code: CLOUD_TASK_RUN_ACTIVE, exitCode: 1 });
  });

  it("refuses an agent that is not a Library agent", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await dispatch(fake, newTask(), true, { found: false });
    expect(outcome.error).toMatchObject({ code: CLOUD_AGENT_NOT_PUBLISHED, exitCode: 1 });
    expect(JSON.parse(outcome.lines.join("\n")).error.suggestedAction).toContain("ravi agents publish triage");
    expect(fake.writes()).toHaveLength(0);
  });

  it("uses the Library item an agent was installed from", async () => {
    const fake = createFakeCloudConsole();
    dbSetLibraryAgentOrigin("triage", {
      ref: "org/support-triage",
      version: 2,
      contentHash: null,
      agentsMdSha256: null,
      heartbeatMdSha256: null,
      profile: null,
      skills: [],
      installedAt: null,
    });
    const outcome = await dispatch(fake, newTask(), false, { found: false });
    expect(JSON.parse(outcome.lines.join("\n")).error.plan.library).toEqual({
      ref: "org/support-triage",
      source: "installed",
    });
  });

  it("refuses a dispatch without a session for the result", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await dispatch(fake, newTask(), false, { informSession: null });
    expect(outcome.error).toMatchObject({ code: "CLOUD_TASK_SESSION_REQUIRED", exitCode: 2 });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a finished task", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    failTask(task.id, { actor: "op", message: "dropped" });
    const outcome = await dispatch(fake, getTaskDetails(task.id).task!, true);
    expect(outcome.error).toMatchObject({ code: "CLOUD_TASK_FINISHED" });
  });

  it("round trip: the watcher finishes the task with the run's result once", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    await dispatch(fake, task, true);
    const run = fake.runs.get("run_1")!;
    run.status = "completed";
    run.result = "12 tickets labeled.";
    const informs: string[] = [];
    const watcher = new CloudTaskWatcher({
      openSession: fakeCloudSessionOpener(fake),
      informSession: async (_session, prompt) => {
        informs.push(prompt);
      },
      finishTask: async (input) => {
        await completeTask(input.taskId, { actor: "cloud-agents", message: input.message });
      },
    });
    await watcher.tickOnce();
    await watcher.tickOnce();
    const finished = getTaskDetails(task.id).task!;
    expect(finished.status).toBe("done");
    expect(finished.summary).toContain("12 tickets labeled.");
    expect(informs).toHaveLength(1);
    expect(fake.runs.get("run_1")!.origin).toMatchObject({ deliveredAt: expect.any(String) });
  });
});

describe("tasks dispatch --cloud: one paid run per dispatch", () => {
  function keys() {
    let n = 0;
    return () => {
      n += 1;
      return `key-${n}`;
    };
  }
  const startKeys = (fake: FakeCloudConsole) =>
    fake
      .writes()
      .filter((request) => request.path === "/runs")
      .map((request) => request.body?.idempotencyKey);

  it("a retry after a lost response sends the same key and gets the same run", async () => {
    const fake = createFakeCloudConsole();
    fake.lostResponses.push({ method: "POST", path: "/runs", times: 1 });
    const task = newTask();
    const newKey = keys();
    const lost = await dispatch(fake, task, true, { newKey });
    expect(lost.error).toBeDefined();
    expect(dbGetCloudTaskDispatch(task.id)).toMatchObject({ state: "pending", idempotencyKey: "key-1" });

    const retry = await dispatch(fake, task, true, { newKey });
    expect(retry.error).toBeUndefined();
    expect(retry.result).toMatchObject({ cloudRun: { id: "run_1" } });
    expect(startKeys(fake)).toEqual(["key-1", "key-1"]);
    expect(fake.runs.size).toBe(1);
    expect(dbGetCloudTaskDispatch(task.id)).toMatchObject({ state: "started", runId: "run_1" });
  });

  it("two concurrent executes start one run", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    const d = deps(fake, true, keys());
    const input = { task, agentId: "triage", informSession: "dev-main" };
    const [a, b] = await Promise.all([prepareCloudTaskDispatch(input, d), prepareCloudTaskDispatch(input, d)]);
    const runs = await Promise.all([executeCloudTaskDispatch(a), executeCloudTaskDispatch(b)]);
    expect(runs.map((run) => run.id)).toEqual(["run_1", "run_1"]);
    expect(startKeys(fake)).toEqual(["key-1", "key-1"]);
    expect(fake.runs.size).toBe(1);
  });

  it("a start the Console refused releases the key", async () => {
    const fake = createFakeCloudConsole();
    fake.failures.push({
      method: "POST",
      path: "/runs",
      status: 503,
      body: { error: { code: "provider_error" } },
      times: 1,
    });
    const task = newTask();
    const newKey = keys();
    expect((await dispatch(fake, task, true, { newKey })).error).toBeDefined();
    expect(dbGetCloudTaskDispatch(task.id)?.state).toBe("failed");
    expect((await dispatch(fake, task, true, { newKey })).error).toBeUndefined();
    expect(startKeys(fake)).toEqual(["key-1", "key-2"]);
  });

  it("the watcher adopts the run of a lost start, and a later dispatch is refused", async () => {
    const fake = createFakeCloudConsole();
    fake.lostResponses.push({ method: "POST", path: "/runs", times: 1 });
    const task = newTask();
    await dispatch(fake, task, true, { newKey: keys() });
    expect(dbGetCloudTaskRun("run_1")).toBeNull();

    const watcher = new CloudTaskWatcher({ openSession: fakeCloudSessionOpener(fake), informSession: async () => {} });
    expect(await watcher.tickOnce()).toMatchObject({ adopted: 1 });
    const list = fake.requests.find((request) => request.method === "GET" && request.path === "/runs");
    expect(list?.query.get("origin")).toBe("installation");
    expect(dbGetCloudTaskRun("run_1")).toMatchObject({
      taskId: task.id,
      sessionName: "dev-main",
      installationId: "inst-1",
      organizationId: "org-1",
      state: "active",
    });
    expect(dbGetCloudTaskDispatch(task.id)).toMatchObject({ state: "started", runId: "run_1" });
    expect((await dispatch(fake, task, true)).error).toMatchObject({ code: CLOUD_TASK_RUN_ACTIVE });
    expect(fake.runs.size).toBe(1);
  });

  it("the watcher abandons a claim whose run never showed up", async () => {
    const fake = createFakeCloudConsole();
    const task = newTask();
    dbClaimCloudTaskDispatch(
      {
        taskId: task.id,
        agentId: "triage",
        sessionName: "dev-main",
        project: "clinica",
        installationId: "inst-1",
        organizationId: "org-1",
      },
      { newKey: () => "old-key", now: Date.now() - 20 * 60_000 },
    );
    const watcher = new CloudTaskWatcher({ openSession: fakeCloudSessionOpener(fake) });
    expect(await watcher.tickOnce()).toMatchObject({ adopted: 0, errors: 0 });
    expect(dbGetCloudTaskDispatch(task.id)?.state).toBe("abandoned");
    await dispatch(fake, task, true, { newKey: () => "new-key" });
    expect(startKeys(fake)).toEqual(["new-key"]);
  });
});
