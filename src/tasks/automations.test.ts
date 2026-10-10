import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());
const actualNatsModule = await import("../nats.js");

const emittedTopics: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishedPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
let stateDir: string | null = null;

mock.module("../nats.js", () => ({
  ...actualNatsModule,
  connectNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  publish: mock(async () => {}),
  subscribe: mock(async function* () {}),
  closeNats: mock(async () => {}),
  nats: {
    emit: async (topic: string, data: Record<string, unknown>) => {
      emittedTopics.push({ topic, data });
    },
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
  },
}));

const { TASK_AUTOMATION_STALE_CLAIM_MS, createTaskAutomation, listTaskAutomationRuns, recoverStaleTaskAutomationRuns } =
  await import("./automations.js");
const {
  dbBindTaskAutomationRunSpawnedTask,
  dbClaimTaskAutomationRun,
  dbFinalizeTaskAutomationRun,
  dbGetTaskAutomation,
} = await import("./automations-db.js");
const { completeTask, createTask, dispatchTask, emitTaskEvent, listTasks } = await import("./service.js");
const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");
const { dbCreateAgent, dbDeleteAgent, getDb } = await import("../router/router-db.js");

function writeVideoProfileFixture(stateRoot: string): void {
  const profileDir = join(stateRoot, "task-profiles", "video-rapha");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "profile.json"),
    JSON.stringify(
      {
        id: "video-rapha",
        version: "1",
        label: "Video Rapha",
        description: "Video profile fixture for automation template coverage.",
        sessionNameTemplate: "<task-id>-work",
        workspaceBootstrap: {
          mode: "path",
          path: "~/ravi/videomaker",
          ensureTaskDir: false,
        },
        sync: {
          artifactFirst: false,
        },
        rendererHints: {
          label: "Video project",
          showTaskDoc: false,
          showWorkspace: true,
        },
        defaultTags: ["task.profile.video-rapha"],
        inputs: [
          { key: "video_id", required: true },
          { key: "titulo", required: true },
          { key: "brief", required: true },
          { key: "tese", required: true },
          { key: "publico", required: true },
          { key: "acao", required: true },
        ],
        completion: {
          summaryRequired: true,
          summaryLabel: "Summary",
        },
        progress: {
          requireMessage: true,
        },
        artifacts: [
          {
            kind: "video-runner-state",
            label: "Runner state",
            pathTemplate: "{{worktree.path}}/out/{{input.video_id}}/.wf-eb-state.json",
            primary: true,
          },
          {
            kind: "video-qc",
            label: "QC report",
            pathTemplate: "{{worktree.path}}/out/{{input.video_id}}/qc.json",
          },
          {
            kind: "video-render",
            label: "Rendered video",
            pathTemplate: "{{worktree.path}}/out/{{input.video_id}}/render/video.mp4",
            primaryWhenStatuses: ["done"],
            showWhenStatuses: ["done"],
          },
        ],
        state: [
          {
            path: "video.videoId",
            valueTemplate: "{{input.video_id}}",
          },
          {
            path: "video.projectDir",
            valueTemplate: "out/{{input.video_id}}",
          },
        ],
        templates: {
          create: "create {{task.id}}",
          dispatch: "dispatch {{task.id}}",
          resume: "resume {{task.id}}",
          dispatchSummary: "summary {{task.id}}",
          dispatchEventMessage: "event {{task.id}}",
          reportDoneMessage: "{{report.text}}",
          reportBlockedMessage: "{{report.text}}",
          reportFailedMessage: "{{report.text}}",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-automations-test-");
  dbCreateAgent({ id: "qa-auto", cwd: "/tmp/ravi-qa-auto" });
  setTaskSessionPromptPublisherForTests(async (sessionName: string, payload: Record<string, unknown>) => {
    publishedPrompts.push({ sessionName, payload });
  });
});

afterEach(async () => {
  emittedTopics.length = 0;
  publishedPrompts.length = 0;
  dbDeleteAgent("qa-auto");
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  setTaskSessionPromptPublisherForTests();
});

describe("task automations", () => {
  it("spawns and auto-dispatches one follow-up task for task.done events", async () => {
    const automation = createTaskAutomation({
      name: "QC follow-up",
      eventTypes: ["task.done"],
      titleTemplate: "QC :: {{data.task.title}}",
      instructionsTemplate: "Review delivery for {{data.task.id}}",
      agentId: "qa-auto",
    });

    const created = createTask({
      title: "Ship runtime feature",
      instructions: "Finish implementation and sync the runtime.",
      priority: "high",
    });

    const completed = await completeTask(created.task.id, {
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
      message: "Implementation shipped.",
    });

    await emitTaskEvent(completed.task, completed.event);
    await emitTaskEvent(completed.task, completed.event);

    const tasks = listTasks({ archiveMode: "include" });
    expect(tasks).toHaveLength(2);

    const followUp = tasks.find((task) => task.id !== created.task.id);
    expect(followUp).toBeDefined();
    expect(followUp?.title).toBe("QC :: Ship runtime feature");
    expect(followUp?.instructions).toBe(`Review delivery for ${created.task.id}`);
    expect(followUp?.parentTaskId).toBe(created.task.id);
    expect(followUp?.assigneeAgentId).toBe("qa-auto");
    expect(followUp?.status).toBe("dispatched");

    const runs = listTaskAutomationRuns(automation.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("spawned");
    expect(runs[0]?.spawnedTaskId).toBe(followUp?.id);

    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toContain("-work");
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain(`[System] Execute:`);
    expect(String(publishedPrompts[0]?.payload.prompt ?? "")).toContain(followUp?.id ?? "");

    expect(emittedTopics.some((entry) => entry.topic === `ravi.task.${created.task.id}.event`)).toBe(true);
    expect(emittedTopics.some((entry) => entry.topic === `ravi.task.${followUp?.id}.event`)).toBe(true);
  });

  it("renders source project, artifacts and task session data for video review templates", async () => {
    writeVideoProfileFixture(stateDir!);

    createTaskAutomation({
      name: "Video review follow-up",
      eventTypes: ["task.done"],
      filter: 'data.source.profile.id == "video-rapha"',
      titleTemplate: "Review :: {{data.source.task.title}}",
      instructionsTemplate:
        "Project {{data.source.projectDir}}\nQC {{data.source.artifacts.byKind.video-qc.path}}\nPrimary {{data.source.artifacts.primary.path}}\nSession {{data.source.taskSession.readCommand}}",
      profileId: "default",
      agentId: "qa-auto",
    });

    const created = createTask({
      title: "Render macro explainer",
      instructions: "Finish the canonical video pipeline delivery.",
      priority: "high",
      profileId: "video-rapha",
      profileInput: {
        video_id: "macro-explainer",
        titulo: "Macro Explainer",
        brief: "Explain the macro setup.",
        tese: "Rates still drive the tape.",
        publico: "Retail investors",
        acao: "Reframe the move",
      },
    });

    const dispatched = await dispatchTask(created.task.id, {
      agentId: "qa-auto",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const completed = await completeTask(dispatched.task.id, {
      actor: "qa-auto",
      agentId: "qa-auto",
      sessionName: `${created.task.id}-work`,
      message: "Render with QC and audio shipped.",
    });

    await emitTaskEvent(completed.task, completed.event);

    const followUp = listTasks({ archiveMode: "include" }).find((task) => task.id !== created.task.id);
    const projectDir = followUp?.instructions.match(/^Project (.+)$/m)?.[1] ?? "";
    expect(followUp?.title).toBe("Review :: Render macro explainer");
    expect(projectDir.endsWith("/ravi/videomaker/out/macro-explainer")).toBe(true);
    expect(followUp?.instructions).toContain(`QC ${join(projectDir, "qc.json")}`);
    expect(followUp?.instructions).toContain(`Primary ${join(projectDir, "render/video.mp4")}`);
    expect(followUp?.instructions).toContain(`ravi sessions read ${created.task.id}-work`);
  });

  it("skips instead of spawning when the automation filter is invalid (fail-closed)", async () => {
    const automation = createTaskAutomation({
      name: "Broken filter follow-up",
      eventTypes: ["task.done"],
      filter: "data.task.priority == high",
      titleTemplate: "QC :: {{data.task.title}}",
      instructionsTemplate: "Review delivery for {{data.task.id}}",
      agentId: "qa-auto",
    });

    const created = createTask({
      title: "Ship runtime feature",
      instructions: "Finish implementation and sync the runtime.",
      priority: "high",
    });
    const completed = await completeTask(created.task.id, {
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
      message: "Implementation shipped.",
    });

    await emitTaskEvent(completed.task, completed.event);

    expect(listTasks({ archiveMode: "include" }).map((task) => task.id)).toEqual([created.task.id]);
    const runs = listTaskAutomationRuns(automation.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.message).toContain("Filter is invalid");
    expect(runs[0]?.message).toContain("Expected quoted string value");
    expect(publishedPrompts).toHaveLength(0);
  });
  it("keeps the created child on a run that fails after spawning", async () => {
    dbCreateAgent({ id: "qa-gone", cwd: "/tmp/ravi-qa-gone" });
    const automation = createTaskAutomation({
      name: "Missing agent follow-up",
      eventTypes: ["task.done"],
      titleTemplate: "QC :: {{data.task.title}}",
      instructionsTemplate: "Review delivery for {{data.task.id}}",
      agentId: "qa-gone",
    });
    // The agent disappears after the automation was configured, so dispatch fails after the child exists.
    dbDeleteAgent("qa-gone");

    const created = createTask({ title: "Ship", instructions: "Ship it.", priority: "high" });
    const completed = await completeTask(created.task.id, {
      actor: "dev-session",
      agentId: "dev",
      sessionName: "dev-session",
      message: "Shipped.",
    });
    await emitTaskEvent(completed.task, completed.event);

    const child = listTasks({ archiveMode: "include" }).find((task) => task.id !== created.task.id);
    expect(child).toBeDefined();
    const runs = listTaskAutomationRuns(automation.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.message).toContain("Agent not found");
    expect(runs[0]?.spawnedTaskId).toBe(child?.id);
  });
});

describe("task automation stale-claim recovery", () => {
  function createRecoveryAutomation() {
    return createTaskAutomation({
      name: "Recovery follow-up",
      eventTypes: ["task.done"],
      titleTemplate: "QC :: {{data.task.title}}",
      instructionsTemplate: "Review delivery for {{data.task.id}}",
    });
  }

  function claim(automationId: string, triggerTaskId: string, triggerEventId: number) {
    const run = dbClaimTaskAutomationRun({
      automationId,
      triggerTaskId,
      triggerEventId,
      triggerEventType: "task.done",
      message: "Claimed",
    });
    expect(run?.status).toBe("claimed");
    return run!;
  }

  const staleNow = () => Date.now() + TASK_AUTOMATION_STALE_CLAIM_MS + 1_000;

  it("links the bound child task instead of spawning a duplicate, idempotently", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    const run = claim(automation.id, trigger.task.id, 1);
    const child = createTask({
      title: "Child",
      instructions: "Child.",
      priority: "normal",
      parentTaskId: trigger.task.id,
      createdBy: `task automation:${automation.id}`,
    });
    dbBindTaskAutomationRunSpawnedTask(run.id, child.task.id);
    // Process dies here: the run never gets finalized.

    const recovered = recoverStaleTaskAutomationRuns({ now: staleNow() });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("spawned");
    expect(recovered[0]?.spawnedTaskId).toBe(child.task.id);
    expect(recovered[0]?.message).toContain("Recovered stale claim");

    expect(recoverStaleTaskAutomationRuns({ now: staleNow() })).toHaveLength(0);
    expect(listTasks({ archiveMode: "include" })).toHaveLength(2);
    expect(listTaskAutomationRuns(automation.id, 10)[0]?.status).toBe("spawned");
    expect(publishedPrompts).toHaveLength(0);
  });

  it("does not let a late executor overwrite or re-count a recovered run", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    const run = claim(automation.id, trigger.task.id, 1);
    const child = createTask({
      title: "Child",
      instructions: "Child.",
      priority: "normal",
      parentTaskId: trigger.task.id,
      createdBy: `task automation:${automation.id}`,
    });
    dbBindTaskAutomationRunSpawnedTask(run.id, child.task.id);

    expect(recoverStaleTaskAutomationRuns({ now: staleNow() })).toHaveLength(1);
    const firesAfterRecovery = dbGetTaskAutomation(automation.id)?.fireCount;

    // The executor resumes after recovery and tries to settle the run itself.
    const late = dbFinalizeTaskAutomationRun(run.id, { status: "failed", message: "late executor" });
    expect(late.finalized).toBe(false);
    expect(late.run.status).toBe("spawned");
    expect(late.run.message).toContain("Recovered stale claim");
    expect(dbGetTaskAutomation(automation.id)?.fireCount).toBe(firesAfterRecovery);
  });

  it("settles a run and counts its fire atomically", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    const run = claim(automation.id, trigger.task.id, 1);
    const firesBefore = dbGetTaskAutomation(automation.id)?.fireCount;

    // The fire counter write fails after the run update: both must roll back.
    getDb().exec(`
      CREATE TEMP TRIGGER fail_fire_count BEFORE UPDATE OF fire_count ON task_automations
      BEGIN SELECT RAISE(ABORT, 'fire count write failed'); END;
    `);
    try {
      expect(() =>
        dbFinalizeTaskAutomationRun(run.id, { status: "spawned", message: "done", recordFire: true }),
      ).toThrow("fire count write failed");
    } finally {
      getDb().exec("DROP TRIGGER IF EXISTS fail_fire_count");
    }
    expect(listTaskAutomationRuns(automation.id, 10)[0]?.status).toBe("claimed");
    expect(dbGetTaskAutomation(automation.id)?.fireCount).toBe(firesBefore);

    // With the counter writable again, the same settle commits both writes.
    const settled = dbFinalizeTaskAutomationRun(run.id, { status: "spawned", message: "done", recordFire: true });
    expect(settled.finalized).toBe(true);
    expect(dbGetTaskAutomation(automation.id)?.fireCount).toBe((firesBefore ?? 0) + 1);
  });

  it("marks a stale claim with no child as failed without re-spawning", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    claim(automation.id, trigger.task.id, 2);

    const recovered = recoverStaleTaskAutomationRuns({ now: staleNow() });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.spawnedTaskId).toBeUndefined();
    expect(listTasks({ archiveMode: "include" }).map((task) => task.id)).toEqual([trigger.task.id]);
  });

  it("leaves claims younger than the stale threshold alone", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    claim(automation.id, trigger.task.id, 3);

    expect(recoverStaleTaskAutomationRuns({ now: Date.now() })).toHaveLength(0);
    expect(listTaskAutomationRuns(automation.id, 10)[0]?.status).toBe("claimed");
  });

  it("links a legacy unbound run only when exactly one matching child exists", () => {
    const automation = createRecoveryAutomation();
    const trigger = createTask({ title: "Trigger", instructions: "Trigger.", priority: "normal" });
    const otherTrigger = createTask({ title: "Other", instructions: "Other.", priority: "normal" });
    claim(automation.id, trigger.task.id, 4);
    claim(automation.id, otherTrigger.task.id, 5);
    const child = createTask({
      title: "Child",
      instructions: "Child.",
      priority: "normal",
      parentTaskId: trigger.task.id,
      createdBy: `task automation:${automation.id}`,
    });

    const recovered = recoverStaleTaskAutomationRuns({ now: staleNow() });
    const byTrigger = new Map(recovered.map((run) => [run.triggerTaskId, run]));
    expect(byTrigger.get(trigger.task.id)?.status).toBe("spawned");
    expect(byTrigger.get(trigger.task.id)?.spawnedTaskId).toBe(child.task.id);
    expect(byTrigger.get(otherTrigger.task.id)?.status).toBe("failed");
    expect(listTasks({ archiveMode: "include" })).toHaveLength(3);
  });
});
