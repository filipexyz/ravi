import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbCreateAgent } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: Record<string, unknown> };

const channels = new Map<string, { push(event: BusEvent): void; close(): void }>();
const publishCalls: Array<Record<string, unknown>> = [];

/**
 * Mirrors the real `nats.subscribe`, an async generator: a `return()` called
 * while the consumer awaits `next()` is queued behind that pending `next()`,
 * so the next event on the topic is still delivered to the old loop.
 */
async function* topicStream(topic: string): AsyncGenerator<BusEvent> {
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
  while (!closed) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
}

const actualNatsModule = await import("../../nats.js");
const actualSessionStreamModule = await import("../../omni/session-stream.js");

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock((topic: string) => topicStream(topic)),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (_sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push(payload);
  }),
}));

const { TriggerRunner } = await import("../runner.js");
const { dbCreateTrigger, dbDeleteTrigger, dbGetTrigger } = await import("../triggers-db.js");

let stateDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(topic: string, data: Record<string, unknown>): void {
  const channel = channels.get(topic);
  if (!channel) throw new Error(`Runner is not subscribed to ${topic}`);
  channel.push({ topic, data });
}

function topicSubs(): Map<string, unknown> {
  return (runner as unknown as { topicSubs: Map<string, unknown> }).topicSubs;
}

function createTrigger(name: string, topic: string) {
  return dbCreateTrigger({
    name,
    agentId: "trigger-test-agent",
    topic,
    message: `agent prompt for ${name}`,
    session: "isolated",
    cooldownMs: 0,
  });
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-delete-test-");
  dbCreateAgent({ id: "trigger-test-agent", cwd: "/tmp/trigger-test-agent-real" });
  channels.clear();
  publishCalls.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("TriggerRunner deleted triggers", () => {
  it("does not fire a deleted trigger on the next event of its removed topic", async () => {
    const kept = createTrigger("kept", "ravi.test.kept");
    const deleted = createTrigger("deleted", "ravi.test.deleted");

    runner = new TriggerRunner();
    await runner.start();
    await waitFor(() => channels.has("ravi.test.deleted"));

    dbDeleteTrigger(deleted.id);
    emit("ravi.triggers.refresh", {});
    await waitFor(() => !topicSubs().has("ravi.test.deleted"));

    emit("ravi.test.deleted", { eventId: "evt-after-delete" });
    emit("ravi.test.kept", { eventId: "evt-kept" });
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publishCalls.map((call) => call._triggerId)).toEqual([kept.id]);
    expect(dbGetTrigger(kept.id)?.fireCount).toBe(1);
  });

  it("does not fire a deleted trigger that shared a topic with a live one", async () => {
    const topic = "ravi.test.shared";
    const kept = createTrigger("kept", topic);
    const deleted = createTrigger("deleted", topic);

    runner = new TriggerRunner();
    await runner.start();
    await waitFor(() => channels.has(topic));

    dbDeleteTrigger(deleted.id);
    emit("ravi.triggers.refresh", {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    emit(topic, { eventId: "evt-shared" });
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publishCalls.map((call) => call._triggerId)).toEqual([kept.id]);
  });
});
