import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { getDb, dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession, updateSessionName } from "../router/sessions.js";
import { createSessionAdapterBus } from "./session-adapter-bus.js";
import { saveSessionAdapter, saveSessionAdapterSubscription } from "./adapter-db.js";
import type {
  StdioCommandInput,
  StdioProtocolCommandAck,
  StdioProtocolCommandResult,
  StdioProtocolEvent,
  StdioSupervisor,
  StdioSupervisorHealth,
  StdioSupervisorOptions,
} from "./stdio-supervisor.js";
import { SessionAdapterDefinitionSchema, type SessionAdapterDefinition } from "./types.js";

const TEST_AGENT_ID = "adapter-bus-agent";
const TEST_SESSION_KEY = "adapter-bus-session-key";
const TEST_SESSION_NAME = "adapter-bus-session";
const TEST_ADAPTER_ID = "adapter-bus";
const COMMAND_TOPIC = `ravi.session.${TEST_SESSION_NAME}.adapter.command`;
const FROM_ADAPTER_TOPIC = `ravi.session.${TEST_SESSION_NAME}.adapter.bus.events`;

interface TopicStream {
  push(event: { topic: string; data: Record<string, unknown> }): void;
  unsubscribe(): void;
  closed: boolean;
  [Symbol.asyncIterator](): AsyncGenerator<{ topic: string; data: Record<string, unknown> }>;
}

function cleanupAdapterState(): void {
  const db = getDb();
  db.prepare("DELETE FROM session_adapter_subscriptions WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapters WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM contexts WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM sessions WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM agents WHERE id = ?").run(TEST_AGENT_ID);
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
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
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createTopicStream(): TopicStream {
  const queue: Array<{ topic: string; data: Record<string, unknown> }> = [];
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
      if (closed) {
        return;
      }
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

function createNatsHarness() {
  const published: Array<{ topic: string; data: Record<string, unknown> }> = [];
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
    async emit(topic: string, data: Record<string, unknown>): Promise<void> {
      published.push({ topic, data });
    },
    send(topic: string, data: Record<string, unknown>): void {
      const list = streams.get(topic);
      if (!list || list.length === 0) {
        throw new Error(`No subscriber for ${topic}`);
      }
      for (let index = list.length - 1; index >= 0; index--) {
        const stream = list[index];
        if (!stream || stream.closed) continue;
        stream.push({ topic, data });
        return;
      }
      throw new Error(`No active subscriber for ${topic}`);
    },
  };
}

function buildDefinition(): SessionAdapterDefinition {
  return SessionAdapterDefinitionSchema.parse({
    name: "adapter-bus",
    lifecycle: {
      start: {
        command: "bun",
        args: ["run", "adapter-bus"],
        env: {
          allow: ["PATH", "HOME"],
          set: {
            ADAPTER_MODE: "runtime",
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
        chatId: "group:123",
      },
      context: {
        cliName: "adapter-bus",
        kind: "cli-runtime",
        capabilities: [
          {
            permission: "execute",
            objectType: "group",
            objectId: "daemon",
          },
        ],
      },
    },
  });
}

class FakeSupervisor implements StdioSupervisor {
  readonly events = new EventEmitter();
  readonly commands: StdioCommandInput[] = [];
  private healthState: StdioSupervisorHealth = {
    state: "stopped",
    pid: null,
    startedAt: null,
    stoppedAt: null,
    lastEventAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null,
    lastProtocolError: null,
    pendingCommands: 0,
    stderrTail: "",
  };

  constructor(readonly options: StdioSupervisorOptions) {}

  private emitState(nextState: StdioSupervisorHealth["state"], extra: Partial<StdioSupervisorHealth> = {}): void {
    this.healthState = {
      ...this.healthState,
      ...extra,
      state: nextState,
    };
    this.events.emit("state", this.health());
  }

  health(): StdioSupervisorHealth {
    return {
      ...this.healthState,
      lastProtocolError: this.healthState.lastProtocolError
        ? Object.assign(new Error(this.healthState.lastProtocolError.message), this.healthState.lastProtocolError)
        : null,
    };
  }

  async start(): Promise<StdioSupervisorHealth> {
    this.emitState("running", {
      startedAt: Date.now(),
      pid: 4242,
    });
    const event: StdioProtocolEvent = {
      type: "event",
      event: "ready",
      payload: { mode: this.options.env?.ADAPTER_MODE },
    };
    this.healthState.lastEventAt = Date.now();
    this.events.emit("protocol-event", event);
    return this.health();
  }

  async stop(): Promise<StdioSupervisorHealth> {
    this.emitState("stopped", {
      stoppedAt: Date.now(),
      pid: null,
    });
    return this.health();
  }

  async restart(): Promise<StdioSupervisorHealth> {
    await this.stop();
    return this.start();
  }

  async sendCommand(input: StdioCommandInput): Promise<StdioProtocolCommandResult> {
    this.commands.push(input);
    this.healthState.pendingCommands += 1;
    const envelopeId = `cmd-${this.commands.length}`;
    const ack: StdioProtocolCommandAck = {
      type: "command.ack",
      id: envelopeId,
      command: input.command,
    };
    const result: StdioProtocolCommandResult = {
      type: "command.result",
      id: envelopeId,
      command: input.command,
      result: {
        accepted: true,
        args: input.args ?? [],
        payload: input.payload,
      },
    };
    this.events.emit("command-ack", ack);
    this.events.emit("command-result", result);
    this.healthState.pendingCommands -= 1;
    return result;
  }
}

describe("session adapter bus", () => {
  beforeEach(() => {
    cleanupAdapterState();
    dbCreateAgent({
      id: TEST_AGENT_ID,
      cwd: "/tmp/adapter-bus-agent",
    });
    getOrCreateSession(TEST_SESSION_KEY, TEST_AGENT_ID, "/tmp/adapter-bus-agent", { name: TEST_SESSION_NAME });
    updateSessionName(TEST_SESSION_KEY, TEST_SESSION_NAME);
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "running",
    });
    saveSessionAdapterSubscription({
      subscriptionId: "adapter-bus-to-adapter",
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "to-adapter",
      topic: COMMAND_TOPIC,
      enabled: true,
    });
    saveSessionAdapterSubscription({
      subscriptionId: "adapter-bus-from-adapter",
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "from-adapter",
      topic: FROM_ADAPTER_TOPIC,
      enabled: true,
    });
  });

  afterEach(() => {
    cleanupAdapterState();
  });

  it("binds session context, forwards commands, publishes runtime events, and rebinds after restart", async () => {
    const natsHarness = createNatsHarness();
    const supervisors: FakeSupervisor[] = [];

    const bus = createSessionAdapterBus({
      transport: {
        publish: natsHarness.emit,
        subscribe: (topic: string) => natsHarness.subscribe(topic),
      },
      createSupervisor: (options) => {
        const supervisor = new FakeSupervisor(options);
        supervisors.push(supervisor);
        return supervisor;
      },
    });

    await bus.start();
    expect(bus.health().adapters).toBe(1);
    expect(supervisors).toHaveLength(1);

    const first = supervisors[0]!;
    expect(first.options.env?.RAVI_CONTEXT_KEY).toBeString();
    expect(first.options.env?.RAVI_SESSION_KEY).toBe(TEST_SESSION_KEY);
    expect(first.options.env?.RAVI_SESSION_NAME).toBe(TEST_SESSION_NAME);
    expect(first.options.env?.RAVI_AGENT_ID).toBe(TEST_AGENT_ID);
    expect(first.options.env?.ADAPTER_MODE).toBe("runtime");

    await waitFor(() =>
      natsHarness.published.some(
        (entry) =>
          entry.topic === FROM_ADAPTER_TOPIC &&
          entry.data.type === "adapter.event" &&
          entry.data.event === "ready" &&
          entry.data.sessionKey === TEST_SESSION_KEY,
      ),
    );

    natsHarness.send(COMMAND_TOPIC, {
      command: "ping",
      args: ["alpha"],
      payload: { source: "session" },
    });

    await waitFor(() => first.commands.length === 1);
    expect(first.commands[0]).toEqual({
      command: "ping",
      args: ["alpha"],
      payload: { source: "session" },
      timeoutMs: undefined,
    });

    await waitFor(() =>
      natsHarness.published.some(
        (entry) =>
          entry.topic === FROM_ADAPTER_TOPIC &&
          entry.data.type === "command.result" &&
          entry.data.command === "ping" &&
          entry.data.sessionName === TEST_SESSION_NAME,
      ),
    );

    const readyEventsBeforeRestart = natsHarness.published.filter(
      (entry) =>
        entry.topic === FROM_ADAPTER_TOPIC && entry.data.type === "adapter.event" && entry.data.event === "ready",
    ).length;

    await bus.restart();
    expect(supervisors).toHaveLength(2);

    const second = supervisors[1]!;
    expect(second.options.env?.RAVI_CONTEXT_KEY).toBeString();
    expect(second.options.env?.RAVI_CONTEXT_KEY).not.toBe(first.options.env?.RAVI_CONTEXT_KEY);

    natsHarness.send(COMMAND_TOPIC, {
      command: "status",
      args: [],
      payload: { restart: true },
    });

    await waitFor(() => second.commands.length === 1);
    expect(second.commands[0]).toEqual({
      command: "status",
      args: [],
      payload: { restart: true },
      timeoutMs: undefined,
    });

    await waitFor(
      () =>
        natsHarness.published.filter(
          (entry) =>
            entry.topic === FROM_ADAPTER_TOPIC && entry.data.type === "adapter.event" && entry.data.event === "ready",
        ).length > readyEventsBeforeRestart,
    );

    await bus.stop();
  });
});
