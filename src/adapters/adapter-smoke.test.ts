import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { getDb, dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession, updateSessionName } from "../router/sessions.js";
import {
  createSessionAdapterBus,
  ensureSessionAdapterStoreSchema,
  getSessionAdapter,
  getSessionAdapterDebugSnapshot,
  saveSessionAdapter,
  saveSessionAdapterSubscription,
  SessionAdapterDefinitionSchema,
  type AdapterBusMessage,
  type AdapterBusSubscription,
  type SessionAdapterBusTransport,
  type SessionAdapterDefinition,
} from "./index.js";

const TEST_AGENT_ID = "adapter-smoke-agent";
const TEST_SESSION_KEY = "adapter-smoke-session-key";
const TEST_SESSION_NAME = "adapter-smoke-session";
const TEST_ADAPTER_ID = "adapter-smoke-cli";
const TEST_AGENT_CWD = process.cwd();
const COMMAND_TOPIC = `ravi.session.${TEST_SESSION_NAME}.adapter.command`;
const EVENT_TOPIC = `ravi.session.${TEST_SESSION_NAME}.adapter.events`;
const fixturePath = fileURLToPath(new URL("./fixtures/session-smoke-cli.ts", import.meta.url));

interface TopicStream extends AdapterBusSubscription {
  push(event: AdapterBusMessage): void;
  closed: boolean;
}

function cleanupAdapterState(): void {
  ensureSessionAdapterStoreSchema();
  const db = getDb();
  db.prepare("DELETE FROM session_adapter_debug WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapter_subscriptions WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapters WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM contexts WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM sessions WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM agents WHERE id = ?").run(TEST_AGENT_ID);
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function createTopicStream(): TopicStream {
  const queue: AdapterBusMessage[] = [];
  let closed = false;
  let resolver: (() => void) | null = null;

  const iterator = (async function* () {
    try {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
          resolver = null;
          continue;
        }

        yield queue.shift()!;
      }
    } finally {
      closed = true;
    }
  })();

  return {
    push(event) {
      if (closed) return;
      queue.push(event);
      resolver?.();
    },
    unsubscribe() {
      closed = true;
      resolver?.();
    },
    get closed() {
      return closed;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

function createHarness(): SessionAdapterBusTransport & {
  published: AdapterBusMessage[];
  send(topic: string, data: Record<string, unknown>): void;
} {
  const published: AdapterBusMessage[] = [];
  const streams = new Map<string, TopicStream[]>();

  return {
    published,
    subscribe(topic: string): TopicStream {
      const stream = createTopicStream();
      const list = streams.get(topic) ?? [];
      list.push(stream);
      streams.set(topic, list);
      return stream;
    },
    async publish(topic: string, data: Record<string, unknown>): Promise<void> {
      published.push({ topic, data });
    },
    send(topic: string, data: Record<string, unknown>): void {
      const list = streams.get(topic) ?? [];
      const active = list.find((stream) => !stream.closed);
      if (!active) {
        throw new Error(`No subscriber for ${topic}`);
      }
      active.push({ topic, data });
    },
  };
}

function buildDefinition(): SessionAdapterDefinition {
  return SessionAdapterDefinitionSchema.parse({
    name: "adapter-smoke-cli",
    description: "Real smoke CLI for the physical orchestrator adapter session",
    lifecycle: {
      start: {
        command: process.execPath,
        args: [fixturePath],
        env: {
          allow: ["PATH", "HOME"],
          set: {
            ADAPTER_MODE: "smoke",
          },
        },
      },
    },
    bindings: {
      sessionKey: TEST_SESSION_KEY,
      sessionName: TEST_SESSION_NAME,
      agentId: TEST_AGENT_ID,
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:999",
      },
      context: {
        cliName: "session-smoke-cli",
        kind: "cli-runtime",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      },
    },
  });
}

describe("adapter smoke", () => {
  beforeEach(() => {
    cleanupAdapterState();
    dbCreateAgent({
      id: TEST_AGENT_ID,
      cwd: TEST_AGENT_CWD,
    });
    getOrCreateSession(TEST_SESSION_KEY, TEST_AGENT_ID, TEST_AGENT_CWD, { name: TEST_SESSION_NAME });
    updateSessionName(TEST_SESSION_KEY, TEST_SESSION_NAME);
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "running",
    });
    saveSessionAdapterSubscription({
      subscriptionId: "adapter-smoke-to-adapter",
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "to-adapter",
      topic: COMMAND_TOPIC,
      enabled: true,
    });
    saveSessionAdapterSubscription({
      subscriptionId: "adapter-smoke-from-adapter",
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "from-adapter",
      topic: EVENT_TOPIC,
      enabled: true,
    });
  });

  afterEach(() => {
    cleanupAdapterState();
  });

  it("runs a real smoke CLI end-to-end through the session adapter bus and rebinds after restart", async () => {
    const harness = createHarness();
    const bus = createSessionAdapterBus({ transport: harness });

    await bus.start();

    await waitFor(() =>
      harness.published.some(
        (entry) =>
          entry.topic === EVENT_TOPIC &&
          entry.data.type === "adapter.event" &&
          entry.data.event === "ready" &&
          entry.data.sessionKey === TEST_SESSION_KEY,
      ),
    );

    harness.send(COMMAND_TOPIC, {
      command: "emit-event",
      args: ["alpha"],
      payload: { source: "smoke" },
    });

    await waitFor(() =>
      harness.published.some(
        (entry) =>
          entry.topic === EVENT_TOPIC &&
          entry.data.type === "adapter.event" &&
          entry.data.event === "tick" &&
          (entry.data.payload as { payload?: { source?: string } } | undefined)?.payload?.source === "smoke",
      ),
    );
    await waitFor(() =>
      harness.published.some(
        (entry) =>
          entry.topic === EVENT_TOPIC && entry.data.type === "command.result" && entry.data.command === "emit-event",
      ),
    );

    const snapshotBeforeRestart = getSessionAdapterDebugSnapshot(TEST_ADAPTER_ID);
    expect(snapshotBeforeRestart?.health.state).toBe("running");
    expect(snapshotBeforeRestart?.bind.cliName).toBe("session-smoke-cli");
    expect(snapshotBeforeRestart?.lastEvent?.event).toBe("tick");
    expect(snapshotBeforeRestart?.lastProtocolError).toBeUndefined();

    const readyEventsBeforeRestart = harness.published.filter(
      (entry) => entry.topic === EVENT_TOPIC && entry.data.type === "adapter.event" && entry.data.event === "ready",
    ).length;

    await bus.restart();

    await waitFor(
      () =>
        harness.published.filter(
          (entry) => entry.topic === EVENT_TOPIC && entry.data.type === "adapter.event" && entry.data.event === "ready",
        ).length > readyEventsBeforeRestart,
    );

    const snapshotAfterRestart = getSessionAdapterDebugSnapshot(TEST_ADAPTER_ID);
    expect(snapshotAfterRestart?.health.state).toBe("running");
    expect(snapshotAfterRestart?.bind.contextId).toBeString();
    expect(snapshotAfterRestart?.bind.contextId).not.toBe(snapshotBeforeRestart?.bind.contextId);

    await bus.stop();
  });

  it("persists protocol failures into the debug snapshot without relying on daemon logs", async () => {
    const harness = createHarness();
    const bus = createSessionAdapterBus({ transport: harness });

    await bus.start();

    harness.send(COMMAND_TOPIC, {
      command: "emit-invalid-event",
    });

    await waitFor(() => getSessionAdapter(TEST_ADAPTER_ID)?.status === "broken");

    const snapshot = getSessionAdapterDebugSnapshot(TEST_ADAPTER_ID);
    expect(snapshot?.health.state).toBe("broken");
    expect(snapshot?.lastProtocolError?.message).toContain("Stdout protocol violation");
    expect(snapshot?.lastProtocolError?.reason).toContain("Stdout protocol violation");

    await bus.stop({ preserveAdapterState: false });
  });
});
