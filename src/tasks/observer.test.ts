import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import type { TaskRuntimeResolution } from "./types.js";

afterAll(() => mock.restore());

const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: mock(() => false),
  publish: mock(async () => {}),
  subscribe: mock(async function* () {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
  },
}));

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { createTask, dispatchTask, dbGetTask, dbListTaskEvents } = await import("./index.js");
const { dbGetTaskObserverState, TASK_OBSERVER_MAX_CHECKLIST_ITEMS } = await import("./observer-contract.js");
const {
  TASK_OBSERVER_PERMISSION_GRANTS,
  buildTaskObserverInstructions,
  ensureTaskObserverRuleForDispatch,
  taskObserverRuleId,
} = await import("./observer-rule.js");
const { setTaskSessionPromptPublisherForTests } = await import("./session-publisher.js");
const { TaskCommands } = await import("../cli/commands/tasks.js");
const { dbCreateAgent, dbGetAgent, dbUpdateAgent } = await import("../router/router-db.js");
const { getOrCreateSession, getSessionByName } = await import("../router/index.js");
const {
  createObservationEvent,
  dbGetObserverRule,
  dbListObserverBindings,
  deliverObservationEvents,
  setObservationPromptPublisherForTests,
  dbUpsertObserverRule,
} = await import("../runtime/observation-plane.js");
const { buildRuntimeRequestContext } = await import("../runtime/runtime-request-context.js");
const { classifyTurnProvenance } = await import("../runtime/turn-provenance.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-observer-tool-first-test-");
  publishCalls.length = 0;
  const record = async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  };
  setTaskSessionPromptPublisherForTests(record);
  setObservationPromptPublisherForTests(record);
  dbCreateAgent({ id: "worker", cwd: "/tmp/worker" });
  dbUpdateAgent("worker", { defaults: { runtimePermissions: { profile: "full-access" } } });
  getOrCreateSession("agent:main:requester", "main", "/tmp/ravi-requester", { name: "requester" });
});

afterEach(async () => {
  setTaskSessionPromptPublisherForTests();
  setObservationPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function startObservedTask(title = "Write the release notes") {
  const created = createTask({
    title,
    instructions: "Write release notes for 3.2 and validate the links.",
    createdBy: "test",
  });
  const sessionName = `${created.task.id}-work`;
  getOrCreateSession(`agent:worker:${sessionName}`, "worker", "/tmp/worker", { name: sessionName });
  await dispatchTask(created.task.id, {
    agentId: "worker",
    sessionName,
    assignedBy: "test",
    reportToSessionName: "requester",
  });
  const session = getSessionByName(sessionName);
  if (!session) throw new Error("worker session was not created");
  return { task: dbGetTask(created.task.id)!, sessionName, session };
}

function workerTurnEvents(runId: string) {
  const turn = classifyTurnProvenance();
  return [
    createObservationEvent({
      runId,
      sequence: 1,
      type: "message.assistant",
      preview: "Implemented the feature and ran bun test.",
      payload: { chars: 42 },
      turn,
    }),
    createObservationEvent({ runId, sequence: 2, type: "turn.complete", preview: "turn.complete", turn }),
  ];
}

describe("tool-first task observer", () => {
  it("creates exactly one real rule and binding with the task-tool allowlist at dispatch", async () => {
    const { task, session } = await startObservedTask();
    const rule = dbGetObserverRule(taskObserverRuleId(task.id));

    expect(rule).not.toBeNull();
    expect(rule).toMatchObject({
      scope: "session",
      sourceSession: session.name,
      observerAgentId: "worker",
      observerMode: "report",
      observerProfileId: "default",
      deliveryPolicy: "end_of_turn",
    });
    expect([...(rule?.permissionGrants ?? [])].sort()).toEqual([...TASK_OBSERVER_PERMISSION_GRANTS].sort());
    expect(rule?.metadata).toMatchObject({
      taskId: task.id,
      observationDetail: true,
      pulseMs: 5 * 60 * 1000,
    });
    expect(rule?.eventTypes).toEqual(
      expect.arrayContaining(["message.user", "message.assistant", "tool.start", "tool.end", "turn.complete"]),
    );

    const bindings = dbListObserverBindings({ sourceSessionKey: session.sessionKey });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      ruleId: taskObserverRuleId(task.id),
      observerRole: "task-observer",
      permissionGrants: [...TASK_OBSERVER_PERMISSION_GRANTS].sort(),
    });
    expect(bindings[0]?.permissionGrants).not.toContain("none");
    expect(bindings[0]?.permissionGrants).not.toContain("use:tool:*");
  });

  it("replaces the previous task's observer when a new task lands on the same session", async () => {
    const { task: first, session, sessionName } = await startObservedTask("First task");
    const second = createTask({
      title: "Second task",
      instructions: "Write the second deliverable and validate it.",
      createdBy: "test",
    });

    ensureTaskObserverRuleForDispatch({
      task: dbGetTask(second.task.id)!,
      sessionName,
      agent: dbGetAgent("worker")!,
    });

    const secondRuleId = taskObserverRuleId(second.task.id);
    expect(dbGetObserverRule(secondRuleId)?.enabled).toBe(true);
    // The stale rule used to stay enabled with terminal grants and could close
    // the previous task using this task's evidence.
    expect(dbGetObserverRule(taskObserverRuleId(first.id))?.enabled).toBe(false);
    expect(dbListObserverBindings({ sourceSessionKey: session.sessionKey, enabled: true })).toEqual([]);
  });

  it("still lets a user report observer own the session", async () => {
    const created = createTask({
      title: "Observed by the user",
      instructions: "Do the work while the user observer reads the session.",
      createdBy: "test",
    });
    const sessionName = "user-report-work";
    getOrCreateSession(`agent:worker:${sessionName}`, "worker", "/tmp/worker", { name: sessionName });
    dbUpsertObserverRule({
      id: "user-report-rule",
      enabled: true,
      scope: "session",
      observerAgentId: "worker",
      observerMode: "report",
      sourceSession: sessionName,
    });

    ensureTaskObserverRuleForDispatch({
      task: dbGetTask(created.task.id)!,
      sessionName,
      agent: dbGetAgent("worker")!,
    });

    expect(dbGetObserverRule(taskObserverRuleId(created.task.id))).toBeNull();
  });

  it("renders a generic prompt with the task id, tool protocol and delivery id but no verdict token", async () => {
    const { task, sessionName, session } = await startObservedTask();

    await deliverObservationEvents({
      sourceSessionName: sessionName,
      sourceSession: session,
      agentId: "worker",
      events: workerTurnEvents("run-1"),
      deliveryPolicies: ["end_of_turn"],
      runId: "run-1",
    });

    const binding = dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]!;
    const published = publishCalls.find((call) => call.sessionName === binding.observerSessionName);
    expect(published).toBeDefined();
    const prompt = String(published?.payload.prompt);

    expect(prompt).toContain(task.id);
    expect(prompt).toContain("tasks_show");
    expect(prompt).toContain("tasks_report");
    expect(prompt).toContain("tasks_block");
    expect(prompt).toContain("tasks_done");
    expect(prompt).toContain("tasks_fail");
    expect(prompt).toContain("Delivery id: od_");
    expect(prompt).not.toContain("task-verdict");

    const instructions = buildTaskObserverInstructions(task);
    expect(instructions).toContain(task.id);
    expect(instructions).not.toContain("task-verdict");
  });

  it("gives the observer tasks_done but not Bash or generic tool access", async () => {
    const { sessionName, session } = await startObservedTask();
    const binding = dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]!;
    const observerSession = getOrCreateSession(`agent:worker:${binding.observerSessionName}`, "worker", "/tmp/worker", {
      name: binding.observerSessionName,
    });
    const prompt: RuntimeLaunchPrompt = {
      prompt: "observe",
      _observation: {
        sourceSessionKey: session.sessionKey,
        sourceSessionName: sessionName,
        bindingId: binding.id,
        ruleId: binding.ruleId,
        role: binding.observerRole,
        mode: "report",
        permissionGrants: binding.permissionGrants,
        eventIds: ["event-1"],
      },
    };
    const runtimeResolution: TaskRuntimeResolution = {
      options: {},
      sources: { model: null, effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    };

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: observerSession.sessionKey,
      sessionName: binding.observerSessionName,
      sessionCwd: "/tmp/worker",
      agent: { id: "worker", cwd: "/tmp/worker", provider: "codex" },
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "done")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "tasks_done")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "tasks", "show")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "executable", "bun")).toBe(false);
    expect(runtimeContext.metadata?.turnCapabilityCount).toBe(TASK_OBSERVER_PERMISSION_GRANTS.length);
  });

  it("persists a tasks_report checklist and renders it in tasks show", async () => {
    const { task } = await startObservedTask();
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await commands.report(
        task.id,
        "Release notes drafted; links still unchecked.",
        "40",
        true,
        undefined,
        JSON.stringify([
          { item: "Draft the notes", done: true },
          { item: "Validate the links", done: false },
        ]),
      );
      const shown = await commands.show(task.id, true);
      expect(shown.observer?.checklist).toEqual([
        { item: "Draft the notes", done: true },
        { item: "Validate the links", done: false },
      ]);
    } finally {
      console.log = originalLog;
    }
    expect(dbGetTaskObserverState(task.id)?.checklist).toHaveLength(2);
  });

  it("bounds an oversized checklist instead of failing the tool", async () => {
    const { task } = await startObservedTask();
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};
    const items = Array.from({ length: TASK_OBSERVER_MAX_CHECKLIST_ITEMS + 5 }, (_, index) => ({
      item: `${index}-${"x".repeat(300)}`,
      done: index % 2 === 0,
    }));
    try {
      await commands.report(task.id, "Checklist from the observer.", "10", true, undefined, JSON.stringify(items));
    } finally {
      console.log = originalLog;
    }
    const checklist = dbGetTaskObserverState(task.id)?.checklist ?? [];
    expect(checklist).toHaveLength(TASK_OBSERVER_MAX_CHECKLIST_ITEMS);
    expect(checklist[0]?.item.length).toBeLessThanOrEqual(200);
  });

  it("applies tasks_done once and emits no second task.done on idempotent replay", async () => {
    const { task } = await startObservedTask();
    const commands = new TaskCommands();
    const originalLog = console.log;
    console.log = () => {};
    try {
      await commands.done(task.id, "Implemented and validated with bun test.", true, "delivery-1:done");
      await commands.done(task.id, "Implemented and validated with bun test.", true, "delivery-1:done");
    } finally {
      console.log = originalLog;
    }

    expect(dbGetTask(task.id)?.status).toBe("done");
    expect(dbListTaskEvents(task.id).filter((event) => event.type === "task.done")).toHaveLength(1);
    expect(dbGetObserverRule(taskObserverRuleId(task.id))?.enabled).toBe(false);
  });
});
