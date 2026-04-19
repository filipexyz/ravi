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

const { createTaskAutomation, listTaskAutomationRuns } = await import("./automations.js");
const { completeTask, createTask, dispatchTask, emitTaskEvent, listTasks } = await import("./service.js");
const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");
const { dbCreateAgent, dbDeleteAgent } = await import("../router/router-db.js");

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
          summaryLabel: "Resumo",
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
});
