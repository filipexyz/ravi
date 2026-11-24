import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbCreateAgent } from "../../router/router-db.js";
import { getOrCreateSession, resolveSession, updateSessionSource } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];

function createTopicStream(topic: string): AsyncIterableIterator<BusEvent> {
  const queue: BusEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  channels.set(topic, {
    push(event) {
      queue.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  });
  const stream: AsyncIterableIterator<BusEvent> = {
    async next() {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const value = queue.shift();
      return value ? { value, done: false } : { value: undefined, done: true };
    },
    async return() {
      closed = true;
      notify();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

const actualNatsModule = await import("../../nats.js");
const actualSessionStreamModule = await import("../../omni/session-stream.js");

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emittedEvents.push({ topic, data });
    }),
    subscribe: mock((topic: string) => createTopicStream(topic)),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TriggerRunner, isTriggerOriginatedEvent } = await import("../runner.js");
const { openChildRun } = await import("../../automation/child-runs.js");
const { setSessionEphemeral } = await import("../../router/sessions.js");
const { dbCreateTrigger } = await import("../triggers-db.js");
const { getChildRun, listChildRunsForOrigin } = await import("../../automation/child-runs.js");
const { saveMessage } = await import("../../db.js");

const AGENT = "trigger-test-agent";
const PARENT_KEY = `agent:${AGENT}:slack:ravi-slack:dm:d-parent`;
const TOPIC = "ravi.test.thread-trigger";

let stateDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(data: unknown): void {
  const channel = channels.get(TOPIC);
  if (!channel) throw new Error(`Runner is not subscribed to ${TOPIC}`);
  channel.push({ topic: TOPIC, data });
}

function endTurn(sessionName: string, data: Record<string, unknown>): void {
  const channel = channels.get("ravi.session.*.runtime");
  if (!channel) throw new Error("Runner is not watching run turns");
  channel.push({ topic: `ravi.session.${sessionName}.runtime`, data });
}

const fires = () => publishCalls.filter((call) => call.payload._trigger === true);
const returns = () => publishCalls.filter((call) => call.payload._automationChildRun !== undefined);

function createThreadTrigger(replySession = PARENT_KEY, extra: { threadVisible?: boolean } = {}) {
  return dbCreateTrigger({
    ...extra,
    name: "blog-watch",
    agentId: AGENT,
    topic: TOPIC,
    message: "read the event and report what matters",
    session: "thread",
    replySession,
    // The creator's chat: a thread fire must not fall back to it.
    replySource: { channel: "slack", accountId: "ravi-slack", chatId: "D-CREATOR" },
    cooldownMs: 0,
    ownerPrincipal: "operator",
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

// The first isolated state builds the whole schema; give it room on a loaded machine.
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-thread-test-");
  dbCreateAgent({ id: AGENT, cwd: "/tmp/trigger-test-agent-real" });
  dbCreateAgent({ id: "other-agent", cwd: "/tmp/other-agent-real" });
  const parent = getOrCreateSession(PARENT_KEY, AGENT, "/tmp/trigger-test-agent-real", { name: "parent-dm" });
  updateSessionSource(parent.sessionKey, { channel: "slack", accountId: "ravi-slack", chatId: "D-PARENT" });
  channels.clear();
  publishCalls.length = 0;
  emittedEvents.length = 0;
}, 20_000);

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("trigger thread mode", () => {
  it("runs a fire in a fresh session of its own that lends nothing and reaches no chat", async () => {
    const trigger = createThreadTrigger();
    await startRunner();

    emit({ id: 1 });
    await waitFor(() => fires().length === 1);

    const fire = fires()[0]!;
    expect(fire.sessionName).toMatch(new RegExp(`^${AGENT}-run-[0-9a-f-]{36}$`));
    const child = resolveSession(fire.sessionName)!;
    expect(child.sessionKey).toMatch(new RegExp(`^agent:${AGENT}:trigger:${trigger.id}:run:[0-9a-f-]{36}$`));
    // Headless: no source, not even the creator's chat frozen on the trigger.
    expect(fire.payload.source).toBeUndefined();
    // The owner's authority is never lent to a run: what it reads goes back to its parent.
    expect(fire.payload._triggerAuthority).toMatchObject({ triggerId: trigger.id, ownSessionKey: null });
    expect(String(fire.payload.prompt)).toContain("read the event and report what matters");
    expect(String(fire.payload.prompt)).toContain("ravi sessions close-thread --return");
    const [run] = listChildRunsForOrigin("trigger", trigger.id);
    expect(run).toMatchObject({
      status: "open",
      parentSessionKey: PARENT_KEY,
      parentSessionName: "parent-dm",
      childSessionName: fire.sessionName,
    });
  });

  it("skips a fire while the previous run is open, returns its reply when its turn ends, then fires again", async () => {
    const trigger = createThreadTrigger();
    await startRunner();
    emit({ id: 1 });
    await waitFor(() => fires().length === 1);
    const first = fires()[0]!;

    emit({ id: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fires()).toHaveLength(1);

    saveMessage(first.sessionName, "assistant", "Post novo: release saiu", null, { utteranceClass: "final" });
    endTurn(first.sessionName, { type: "turn.complete" });
    await waitFor(() => returns().length === 1);

    expect(returns()[0]!.sessionName).toBe("parent-dm");
    expect(String(returns()[0]!.payload.prompt)).toContain("\n> Post novo: release saiu");
    const [closed] = listChildRunsForOrigin("trigger", trigger.id);
    expect(getChildRun(closed!.id)).toMatchObject({ status: "closed", returnState: "returned", returnKind: "auto" });
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        topic: "ravi.session.abort",
        data: expect.objectContaining({ sessionName: first.sessionName, source: "trigger-runner" }),
      }),
    );

    emit({ id: 3 });
    await waitFor(() => fires().length === 2);
    expect(fires()[1]!.sessionName).not.toBe(first.sessionName);
  });

  it("releases the runtime of a run its child already closed, when its turn ends", async () => {
    const { closeChildRun, getChildRun: readRun } = await import("../../automation/child-runs.js");
    const trigger = createThreadTrigger();
    await startRunner();
    emit({ id: 1 });
    await waitFor(() => fires().length === 1);
    const fire = fires()[0]!;
    const [run] = listChildRunsForOrigin("trigger", trigger.id);
    await closeChildRun(readRun(run!.id)!, { kind: "result", text: "resultado explícito" });

    endTurn(fire.sessionName, { type: "turn.complete" });
    await waitFor(() =>
      emittedEvents.some(
        (event) => event.topic === "ravi.session.abort" && event.data.sessionName === fire.sessionName,
      ),
    );
    expect(returns()).toHaveLength(1);
  });

  it("sends one classified error when the run's turn fails", async () => {
    createThreadTrigger();
    await startRunner();
    emit({ id: 1 });
    await waitFor(() => fires().length === 1);

    endTurn(fires()[0]!.sessionName, { type: "turn.failed", error: "provider refused the model" });
    await waitFor(() => returns().length === 1);

    const prompt = String(returns()[0]!.payload.prompt);
    expect(prompt).toContain("falhou.");
    expect(prompt).toContain("\n> erro de execução");
    expect(prompt).not.toContain("provider refused the model");
  });

  it("treats a CLI call from a run's session as trigger-originated, so it fires no trigger", () => {
    const fromRun = { cliInvocation: { raviContext: { sessionKey: `agent:${AGENT}:trigger:t1:run:r1` } } };
    const fromChat = { cliInvocation: { raviContext: { sessionKey: PARENT_KEY } } };
    expect(isTriggerOriginatedEvent("ravi._cli.cli.bases.rows.update", fromRun)).toBe(true);
    expect(isTriggerOriginatedEvent("ravi._cli.cli.bases.rows.update", fromChat)).toBe(false);
  });

  it("knows a visible fire's session (a Slack thread's key) as trigger-originated too, and a cron run's as not", () => {
    const run = (id: string, originKind: "cron" | "trigger", childSessionKey: string) =>
      openChildRun({
        id,
        originKind,
        originId: "o-1",
        originName: "watch",
        agentId: AGENT,
        parentSessionKey: PARENT_KEY,
        parentSessionName: "parent-dm",
        childSessionKey,
        childSessionName: `${id}-session`,
        surface: "slack-thread",
      });
    run("r-trigger", "trigger", `${PARENT_KEY}:thread:1.1`);
    run("r-cron", "cron", `${PARENT_KEY}:thread:2.2`);
    const from = (sessionKey: string) => ({ cliInvocation: { raviContext: { sessionKey } } });

    expect(isTriggerOriginatedEvent("ravi._cli.cli.bases.rows.update", from(`${PARENT_KEY}:thread:1.1`))).toBe(true);
    expect(isTriggerOriginatedEvent("ravi._cli.cli.bases.rows.update", from(`${PARENT_KEY}:thread:2.2`))).toBe(false);
  });

  it("runs a fire headless unless the trigger asked for visible runs, even where a surface could show it", async () => {
    const { registerChildRunSurface } = await import("../../automation/child-runs.js");
    const opened: string[] = [];
    const unregister = registerChildRunSurface({
      id: "slack-thread",
      canHost: () => true,
      open: async ({ run }) => {
        opened.push(run.id);
      },
      closeSurface: async () => true,
    });
    try {
      const trigger = createThreadTrigger();
      await startRunner();
      emit({ id: 1 });
      await waitFor(() => fires().length === 1);

      expect(opened).toEqual([]);
      expect(listChildRunsForOrigin("trigger", trigger.id)[0]).toMatchObject({ surface: "headless" });
      expect(String(fires()[0]!.payload.prompt)).toContain("nothing written here reaches a chat");
    } finally {
      unregister();
    }
  });

  it("watches run turns again when the subscription ends cleanly", async () => {
    const trigger = createThreadTrigger();
    runner = new TriggerRunner();
    runner["runTurnRestartMs"] = 10;
    await runner.start();
    channels.get("ravi.session.*.runtime")!.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    emit({ id: 1 });
    await waitFor(() => fires().length === 1);
    saveMessage(fires()[0]!.sessionName, "assistant", "depois do reinício", null, { utteranceClass: "final" });
    endTurn(fires()[0]!.sessionName, { type: "turn.complete" });
    await waitFor(() => returns().length === 1);

    expect(String(returns()[0]!.payload.prompt)).toContain("\n> depois do reinício");
    expect(listChildRunsForOrigin("trigger", trigger.id)[0]).toMatchObject({ status: "closed" });
  });

  it("shows a fire on a registered surface: launch stored for it, closed when the bound turn ends", async () => {
    const { bindChildRunSession, registerChildRunSurface } = await import("../../automation/child-runs.js");
    const closedSurfaces: string[] = [];
    const unregister = registerChildRunSurface({
      id: "slack-thread",
      canHost: () => true,
      open: async () => {},
      closeSurface: async (run) => {
        closedSurfaces.push(run.id);
        return true;
      },
    });
    try {
      const trigger = createThreadTrigger(PARENT_KEY, { threadVisible: true });
      await startRunner();
      emit({ id: 1 });
      await waitFor(() => listChildRunsForOrigin("trigger", trigger.id).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fires()).toHaveLength(0);

      const [run] = listChildRunsForOrigin("trigger", trigger.id);
      const bound = bindChildRunSession("slack-thread", run!.surfaceRef!, `${PARENT_KEY}:thread:5.6`, "parent-dm-t-56");
      // The trigger's snapshot, never lending its owner: what a run reads goes back to its parent.
      expect(bound?.launch).toMatchObject({
        _trigger: true,
        _triggerId: trigger.id,
        _triggerAuthority: { triggerId: trigger.id, ownSessionKey: null },
      });
      expect(String(bound?.launch?.prompt)).toContain("ravi sessions close-thread --return");
      expect(String(bound?.launch?.prompt)).toContain("everyone in that chat sees what you write here");

      endTurn("parent-dm-t-56", { type: "turn.complete" });
      await waitFor(() => closedSurfaces.length === 1);
      expect(getChildRun(run!.id)).toMatchObject({ status: "closed" });
    } finally {
      unregister();
    }
  });

  it("leaves a cron run's turn to the cron runner", async () => {
    getOrCreateSession(`agent:${AGENT}:cron:job-1:run:cron-run-1`, AGENT, "/tmp/trigger-test-agent-real", {
      name: `${AGENT}-run-cron-run-1`,
    });
    openChildRun({
      id: "cron-run-1",
      originKind: "cron",
      originId: "job-1",
      originName: "job",
      agentId: AGENT,
      parentSessionKey: PARENT_KEY,
      parentSessionName: "parent-dm",
      childSessionKey: `agent:${AGENT}:cron:job-1:run:cron-run-1`,
      childSessionName: `${AGENT}-run-cron-run-1`,
    });
    await startRunner();

    endTurn(`${AGENT}-run-cron-run-1`, { type: "turn.complete" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getChildRun("cron-run-1")).toMatchObject({ status: "open" });
    expect(emittedEvents.filter((event) => event.topic === "ravi.session.abort")).toHaveLength(0);
  });

  it("opens no run when, at fire time, the session it reports to is ephemeral", async () => {
    const ephemeral = getOrCreateSession(`agent:${AGENT}:tmp`, AGENT, "/tmp/trigger-test-agent-real", {
      name: "tmp-parent",
    });
    setSessionEphemeral(ephemeral.sessionKey, 60 * 60_000);
    const trigger = createThreadTrigger(ephemeral.sessionKey);
    await startRunner();

    emit({ id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fires()).toHaveLength(0);
    expect(listChildRunsForOrigin("trigger", trigger.id)).toHaveLength(0);
  });

  it("opens no run when the session it reports to belongs to another agent", async () => {
    getOrCreateSession("agent:other-agent:main", "other-agent", "/tmp/other-agent-real", { name: "other-agent" });
    const trigger = createThreadTrigger("agent:other-agent:main");
    await startRunner();

    emit({ id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fires()).toHaveLength(0);
    expect(listChildRunsForOrigin("trigger", trigger.id)).toHaveLength(0);
  });
});
