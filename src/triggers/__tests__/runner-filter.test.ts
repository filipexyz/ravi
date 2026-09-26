import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
const subscribedTopics: string[] = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

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
    emit: mock(async () => {}),
    subscribe: mock((topic: string) => {
      subscribedTopics.push(topic);
      return createTopicStream(topic);
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TriggerRunner } = await import("../runner.js");
const { dbCreateTrigger, dbGetTrigger, dbUpdateTrigger } = await import("../triggers-db.js");

let stateDir: string | null = null;
let markerDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(topic: string, data: unknown): void {
  const channel = channels.get(topic);
  if (!channel) throw new Error(`Runner is not subscribed to ${topic}`);
  channel.push({ topic, data });
}

function markerPath(): string {
  return join(markerDir!, "shell-fired.log");
}

function firedShellTriggerIds(): string[] {
  if (!existsSync(markerPath())) return [];
  return readFileSync(markerPath(), "utf8").split("\n").filter(Boolean);
}

function createTrigger(input: { name: string; topic: string; filter?: string; executionType?: "agent" | "shell" }) {
  const shell = input.executionType === "shell";
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: shell ? "" : `agent prompt for ${input.name}`,
    executionType: shell ? "shell" : "agent",
    shellCommand: shell ? `printf '%s\\n' "$RAVI_TRIGGER_ID" >> '${markerPath()}'` : undefined,
    shellTimeoutMs: shell ? 10_000 : undefined,
    session: "isolated",
    cooldownMs: 0,
    filter: input.filter,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-filter-test-");
  markerDir = mkdtempSync(join(tmpdir(), "ravi-trigger-shell-marker-"));
  channels.clear();
  subscribedTopics.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  markerDir = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("TriggerRunner invalid filters fail closed", () => {
  it("does not subscribe to a topic whose only trigger has an invalid filter", async () => {
    const invalid = createTrigger({
      name: "legacy-shell",
      topic: "ravi.test.invalid-only",
      filter: "data.branch == main",
      executionType: "shell",
    });

    await startRunner();

    expect(subscribedTopics).toContain("ravi.triggers.refresh");
    expect(subscribedTopics).not.toContain("ravi.test.invalid-only");
    expect(dbGetTrigger(invalid.id)?.fireCount).toBe(0);
    expect(firedShellTriggerIds()).toEqual([]);
  });

  it("keeps valid filters filtering while an invalid-filter sibling never fires (agent + shell)", async () => {
    const topic = "ravi.test.shared";
    const validAgent = createTrigger({ name: "valid-agent", topic, filter: `data.kind == "match"` });
    const validShell = createTrigger({
      name: "valid-shell",
      topic,
      filter: `data.kind == "match"`,
      executionType: "shell",
    });
    const invalidShell = createTrigger({
      name: "invalid-shell",
      topic,
      filter: "data.kind == match",
      executionType: "shell",
    });
    const invalidAgent = createTrigger({ name: "invalid-agent", topic, filter: "data.kind contains match" });

    await startRunner();
    expect(subscribedTopics).toContain(topic);

    emit(topic, { kind: "other", eventId: "evt-no-match" });
    emit(topic, { kind: "match", eventId: "evt-match" });

    await waitFor(() => publishCalls.length >= 1 && firedShellTriggerIds().length >= 1);
    await waitFor(() => (dbGetTrigger(validShell.id)?.fireCount ?? 0) >= 1);
    // Both events were evaluated in order in one loop; give any stray dispatch time to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publishCalls.map((call) => call.payload._triggerId)).toEqual([validAgent.id]);
    expect(String(publishCalls[0]?.payload.prompt)).toContain("evt-match");
    expect(firedShellTriggerIds()).toEqual([validShell.id]);
    expect(dbGetTrigger(validAgent.id)?.fireCount).toBe(1);
    expect(dbGetTrigger(validShell.id)?.fireCount).toBe(1);
    expect(dbGetTrigger(invalidShell.id)?.fireCount).toBe(0);
    expect(dbGetTrigger(invalidAgent.id)?.fireCount).toBe(0);
  });

  it("activates the trigger once its filter is fixed and the runner refreshes", async () => {
    const topic = "ravi.test.recover";
    const trigger = createTrigger({ name: "recoverable", topic, filter: "data.kind == match" });

    await startRunner();
    expect(subscribedTopics).not.toContain(topic);

    dbUpdateTrigger(trigger.id, { filter: `data.kind == "match"` });
    emit("ravi.triggers.refresh", {});
    await waitFor(() => channels.has(topic));

    emit(topic, { kind: "match", eventId: "evt-after-fix" });
    await waitFor(() => publishCalls.length === 1);
    expect(publishCalls[0]?.payload._triggerId).toBe(trigger.id);
  });

  it("drops a subscribed trigger on refresh when its persisted filter becomes invalid", async () => {
    const topic = "ravi.test.regress";
    const trigger = createTrigger({ name: "regressed", topic, filter: `data.kind == "match"` });

    await startRunner();
    expect(subscribedTopics).toContain(topic);

    dbUpdateTrigger(trigger.id, { filter: "data.kind == match" });
    emit("ravi.triggers.refresh", {});
    await waitFor(() => (runner as unknown as { topicSubs: Map<string, unknown> }).topicSubs.size === 0);

    expect(publishCalls).toEqual([]);
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(0);
  });
});
