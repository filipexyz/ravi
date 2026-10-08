import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbCreateAgent } from "../../router/router-db.js";
import { listSessions } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { SessionTarget } from "../types.js";

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
const { dbCreateTrigger, dbGetTrigger } = await import("../triggers-db.js");

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

function createTrigger(input: { name: string; topic: string; session: SessionTarget; cooldownMs?: number }) {
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: `agent prompt for ${input.name}`,
    session: input.session,
    cooldownMs: input.cooldownMs ?? 0,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-keyed-test-");
  dbCreateAgent({ id: "trigger-test-agent", cwd: "/tmp/trigger-test-agent-real" });
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

describe("TriggerRunner keyed sessions", () => {
  const topic = "ravi.console.inbox.item";
  const commentEvent = (rowId: string, topicId: string | null) => ({
    eventType: "bases.row.created",
    payload: { rowId, row: { rowId, values: topicId === null ? {} : { topic_id: [topicId] } } },
  });

  it("runs every event in the persistent session of its resolved key, one session per key", async () => {
    const trigger = createTrigger({
      name: "forum",
      topic,
      session: "key:issue-{{data.payload.row.values.topic_id.0}}",
    });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    emit(topic, commentEvent("c2", "topic-b"));
    emit(topic, commentEvent("c3", "topic-a"));
    await waitFor(() => publishCalls.length >= 3);

    const [first, second, third] = publishCalls.map((call) => call.sessionName);
    expect(first).toBe(third!);
    expect(first).not.toBe(second!);
    expect(first).toContain("issue-topic-a");
    expect(second).toContain("issue-topic-b");
    const keyed = listSessions().filter((session) =>
      session.sessionKey.startsWith(`agent:trigger-test-agent:trigger:${trigger.id}:key:`),
    );
    expect(keyed).toHaveLength(2);
  });

  it("skips an event whose key does not resolve instead of using a shared session", async () => {
    const trigger = createTrigger({
      name: "forum-skip",
      topic,
      session: "key:issue-{{data.payload.row.values.topic_id.0}}",
    });
    await startRunner();

    emit(topic, commentEvent("c1", null));
    emit(topic, commentEvent("c2", "topic-a"));
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.sessionName).toContain("issue-topic-a");
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(1);
  });

  it("applies the cooldown per key, so a busy key does not swallow other keys' events", async () => {
    createTrigger({
      name: "forum-cooldown",
      topic,
      session: "key:issue-{{data.payload.row.values.topic_id.0}}",
      cooldownMs: 60_000,
    });
    await startRunner();

    emit(topic, commentEvent("c1", "topic-a"));
    emit(topic, commentEvent("c2", "topic-a"));
    emit(topic, commentEvent("c3", "topic-b"));
    await waitFor(() => publishCalls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishCalls.map((call) => call.sessionName)).toEqual([
      expect.stringContaining("issue-topic-a"),
      expect.stringContaining("issue-topic-b"),
    ]);
  });
});
