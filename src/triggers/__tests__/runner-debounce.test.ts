import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbCreateAgent } from "../../router/router-db.js";
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

function markerPath(): string {
  return join(markerDir!, "shell-fired.log");
}

function shellFires(): string[] {
  if (!existsSync(markerPath())) return [];
  return readFileSync(markerPath(), "utf8").split("\n").filter(Boolean);
}

function createTrigger(input: {
  name: string;
  topic: string;
  executionType?: "agent" | "shell";
  cooldownMs?: number;
  debounceMs?: number;
}) {
  const shell = input.executionType === "shell";
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: shell ? "" : `agent prompt for ${input.name}`,
    executionType: shell ? "shell" : "agent",
    // One marker line per fire: "<event count> <events.json on one line>".
    shellCommand: shell
      ? `printf '%s %s\\n' "$RAVI_TRIGGER_EVENT_COUNT" "$(tr -d '\\n ' < "$RAVI_TRIGGER_EVENTS_FILE")" >> '${markerPath()}'`
      : undefined,
    shellTimeoutMs: shell ? 10_000 : undefined,
    session: "isolated",
    cooldownMs: input.cooldownMs ?? 0,
    debounceMs: input.debounceMs ?? 0,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-debounce-test-");
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TriggerRunner cooldown", () => {
  it("fires every event when cooldown is off", async () => {
    const topic = "ravi.test.bus";
    createTrigger({ name: "bus", topic, executionType: "shell", cooldownMs: 0 });
    await startRunner();

    for (const id of ["a", "b", "c"]) emit(topic, { eventId: id });
    await waitFor(() => shellFires().length >= 3);
    await sleep(150);
    expect(shellFires()).toHaveLength(3);
  });

  it("still drops events inside an active cooldown (the documented behavior)", async () => {
    const topic = "ravi.test.cooled";
    const trigger = createTrigger({ name: "cooled", topic, executionType: "shell", cooldownMs: 5_000 });
    await startRunner();

    for (const id of ["a", "b", "c"]) emit(topic, { eventId: id });
    await waitFor(() => (dbGetTrigger(trigger.id)?.fireCount ?? 0) >= 1);
    await sleep(200);
    expect(shellFires()).toHaveLength(1);
  });
});

describe("TriggerRunner debounce", () => {
  it("fires a shell trigger once per burst with every event in RAVI_TRIGGER_EVENTS_FILE", async () => {
    const topic = "ravi.test.burst";
    createTrigger({ name: "burst-shell", topic, executionType: "shell", debounceMs: 300 });
    await startRunner();

    for (const id of ["a", "b", "c"]) emit(topic, { eventId: id });
    await sleep(150);
    expect(shellFires()).toHaveLength(0);

    await waitFor(() => shellFires().length >= 1);
    await sleep(400);
    const fires = shellFires();
    expect(fires).toHaveLength(1);
    expect(fires[0]).toStartWith("3 ");
    for (const id of ["a", "b", "c"]) expect(fires[0]).toContain(`"eventId":"${id}"`);
  });

  it("gives an agent trigger the whole burst in one prompt", async () => {
    const topic = "ravi.test.burst-agent";
    createTrigger({ name: "burst-agent", topic, debounceMs: 200 });
    await startRunner();

    for (const id of ["a", "b"]) emit(topic, { eventId: id });
    await waitFor(() => publishCalls.length >= 1);
    await sleep(300);
    expect(publishCalls).toHaveLength(1);
    const prompt = String(publishCalls[0]?.payload.prompt);
    expect(prompt).toContain("Batch: 2 events debounced into this fire");
    expect(prompt).toContain('"eventId": "a"');
    expect(prompt).toContain('"eventId": "b"');
  });

  it("holds a burst that lands inside the cooldown instead of dropping it", async () => {
    const topic = "ravi.test.burst-cooldown";
    createTrigger({ name: "burst-cooldown", topic, executionType: "shell", debounceMs: 100, cooldownMs: 1_000 });
    await startRunner();

    emit(topic, { eventId: "first" });
    await waitFor(() => shellFires().length >= 1);
    emit(topic, { eventId: "second" });
    await sleep(400);
    expect(shellFires()).toHaveLength(1);

    await waitFor(() => shellFires().length >= 2, 3_000);
    expect(shellFires()[1]).toContain('"eventId":"second"');
  });
});
