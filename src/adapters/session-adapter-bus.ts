import { StringCodec } from "nats";
import type { ContextRecord } from "../router/router-db.js";
import { resolveSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import {
  createRuntimeContext,
  snapshotAgentCapabilities,
  type CreateRuntimeContextInput,
} from "../runtime/context-registry.js";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";
import {
  ensureSessionAdapterStoreSchema,
  listSessionAdapterSubscriptions,
  listSessionAdapters,
  saveSessionAdapterDebugSnapshot,
  updateSessionAdapterState,
  type SessionAdapterDebugSnapshot,
  type SessionAdapterRecord,
} from "./adapter-db.js";
import {
  createStdioSupervisor,
  type StdioCommandInput,
  type StdioProtocolCommandAck,
  type StdioProtocolCommandError,
  type StdioProtocolCommandResult,
  type StdioProtocolEvent,
  type StdioSupervisor,
  type StdioSupervisorHealth,
  type StdioSupervisorOptions,
} from "./stdio-supervisor.js";
import type { SessionAdapterContextBinding, SessionAdapterDefinition } from "./types.js";
import type { SessionEntry } from "../router/types.js";
import { getNats } from "../nats.js";

const log = logger.child("adapters:bus");
const sc = StringCodec();

export interface AdapterBusMessage {
  topic: string;
  data: Record<string, unknown>;
}

export interface AdapterBusSubscription extends AsyncIterable<AdapterBusMessage> {
  unsubscribe(): void;
}

export interface SessionAdapterBusTransport {
  publish(topic: string, data: Record<string, unknown>): Promise<void>;
  subscribe(topic: string, opts?: { queue?: string }): AdapterBusSubscription;
}

export interface SessionAdapterBusOptions {
  transport?: SessionAdapterBusTransport;
  createContext?: (input: CreateRuntimeContextInput) => ContextRecord;
  createSupervisor?: (options: StdioSupervisorOptions) => StdioSupervisor;
}

export interface SessionAdapterBusStopOptions {
  preserveAdapterState?: boolean;
}

interface ActiveAdapterRuntime {
  adapter: SessionAdapterRecord;
  session: SessionEntry;
  sessionName: string;
  context: ContextRecord;
  supervisor: StdioSupervisor;
  health: StdioSupervisorHealth;
  commandSubscriptions: AdapterBusSubscription[];
  toAdapterTopics: string[];
  fromAdapterTopics: string[];
  debug: {
    lastEvent?: SessionAdapterDebugSnapshot["lastEvent"];
    lastCommand?: SessionAdapterDebugSnapshot["lastCommand"];
    lastProtocolError?: SessionAdapterDebugSnapshot["lastProtocolError"];
  };
}

interface AdapterCommandPayload {
  command: string;
  args?: string[];
  payload?: unknown;
  timeoutMs?: number;
}

const AdapterCommandPayloadSchema = {
  parse(input: unknown): AdapterCommandPayload {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Adapter command payload must be an object");
    }

    const candidate = input as Record<string, unknown>;
    const command = candidate.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("Adapter command payload requires a command string");
    }

    const args = candidate.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
      throw new Error("Adapter command args must be an array of strings");
    }

    const timeoutMs = candidate.timeoutMs;
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("Adapter command timeoutMs must be a positive number");
    }

    return {
      command,
      args: args as string[] | undefined,
      payload: candidate.payload,
      timeoutMs: timeoutMs as number | undefined,
    };
  },
};

function createDefaultTransport(): SessionAdapterBusTransport {
  return {
    async publish(topic, data) {
      const conn = getNats();
      conn.publish(topic, sc.encode(JSON.stringify(data)));
    },
    subscribe(topic, opts) {
      const conn = getNats();
      const native = conn.subscribe(topic, opts?.queue ? { queue: opts.queue } : undefined);

      return {
        unsubscribe() {
          native.unsubscribe();
        },
        async *[Symbol.asyncIterator](): AsyncIterator<AdapterBusMessage> {
          try {
            for await (const msg of native) {
              if (msg.subject.startsWith("$") || msg.subject.startsWith("_INBOX.")) continue;
              try {
                const raw = sc.decode(msg.data);
                const data = JSON.parse(raw) as Record<string, unknown>;
                yield { topic: msg.subject, data };
              } catch {}
            }
          } finally {
            native.unsubscribe();
          }
        },
      };
    },
  };
}

function getSessionTopicName(session: SessionEntry, adapter: SessionAdapterRecord): string {
  return session.name ?? adapter.definition.bindings.sessionName ?? session.sessionKey;
}

function resolveSessionForAdapter(adapter: SessionAdapterRecord): SessionEntry | null {
  return resolveSession(adapter.sessionKey) ?? (adapter.sessionName ? resolveSession(adapter.sessionName) : null);
}

function resolveAdapterSource(
  session: SessionEntry,
  adapter: SessionAdapterRecord,
): SessionAdapterDefinition["bindings"]["source"] | undefined {
  const configuredSource = adapter.definition.bindings.source;
  if (configuredSource) return configuredSource;
  if (session.lastChannel && session.lastAccountId && session.lastTo) {
    return {
      channel: session.lastChannel,
      accountId: session.lastAccountId,
      chatId: session.lastTo,
      threadId: session.lastThreadId,
    };
  }
  return undefined;
}

function buildRuntimeContext(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  createContext: (input: CreateRuntimeContextInput) => ContextRecord,
): ContextRecord {
  const contextBinding: SessionAdapterContextBinding = adapter.definition.bindings.context;
  const inheritedCapabilities = contextBinding.inheritCapabilities ? snapshotAgentCapabilities(session.agentId) : [];
  const sessionName = getSessionTopicName(session, adapter);
  const source = resolveAdapterSource(session, adapter);

  return createContext({
    kind: contextBinding.kind,
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    sessionName,
    source,
    capabilities: [...inheritedCapabilities, ...contextBinding.capabilities],
    metadata: {
      adapterId: adapter.adapterId,
      adapterName: adapter.name,
      cliName: contextBinding.cliName,
      transport: adapter.transport,
    },
    ttlMs: contextBinding.ttlMs,
  });
}

function buildAdapterEnv(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
): NodeJS.ProcessEnv {
  const startEnv = adapter.definition.lifecycle.start.env;
  const env: NodeJS.ProcessEnv = {};

  for (const key of startEnv.allow) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(startEnv.set)) {
    env[key] = value;
  }

  env[RAVI_CONTEXT_KEY_ENV] = context.contextKey;
  env.RAVI_SESSION_KEY = session.sessionKey;
  env.RAVI_SESSION_NAME = getSessionTopicName(session, adapter);
  env.RAVI_AGENT_ID = session.agentId;

  const source = resolveAdapterSource(session, adapter);
  if (source) {
    env.RAVI_CHANNEL = source.channel;
    env.RAVI_ACCOUNT_ID = source.accountId;
    env.RAVI_CHAT_ID = source.chatId;
  }

  return env;
}

function buildSupervisorOptions(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
): StdioSupervisorOptions {
  const command = adapter.definition.lifecycle.start;
  return {
    command: command.command,
    args: command.args,
    cwd: command.cwd ?? session.agentCwd,
    env: buildAdapterEnv(adapter, session, context),
  };
}

function cloneState(state: StdioSupervisorHealth): StdioSupervisorHealth {
  return {
    ...state,
    lastProtocolError: state.lastProtocolError
      ? Object.assign(new Error(state.lastProtocolError.message), {
          kind: state.lastProtocolError.kind,
          line: state.lastProtocolError.line,
          reason: state.lastProtocolError.reason,
        })
      : null,
  };
}

function buildSessionEnvelope(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
): Record<string, unknown> {
  return {
    adapterId: adapter.adapterId,
    adapterName: adapter.name,
    adapterStatus: adapter.status,
    transport: adapter.transport,
    sessionKey: session.sessionKey,
    sessionName: getSessionTopicName(session, adapter),
    session: {
      sessionKey: session.sessionKey,
      sessionName: session.name ?? undefined,
      agentId: session.agentId,
      agentCwd: session.agentCwd,
    },
    context: {
      contextId: context.contextId,
      contextKey: context.contextKey,
      kind: context.kind,
    },
    publishedAt: Date.now(),
  };
}

export function buildSessionAdapterCommandTopic(sessionName: string): string {
  return `ravi.session.${sessionName}.adapter.command`;
}

export function buildSessionAdapterEventTopic(sessionName: string): string {
  return `ravi.session.${sessionName}.adapter.event`;
}

function buildProtocolEventPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  event: StdioProtocolEvent,
): Record<string, unknown> {
  return {
    type: "adapter.event",
    event: event.event,
    payload: event.payload,
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildCommandAckPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  event: StdioProtocolCommandAck,
): Record<string, unknown> {
  return {
    ...event,
    type: "command.ack",
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildCommandResultPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  event: StdioProtocolCommandResult,
): Record<string, unknown> {
  return {
    ...event,
    type: "command.result",
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildCommandErrorPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  event: StdioProtocolCommandError,
): Record<string, unknown> {
  return {
    ...event,
    type: "command.error",
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildProtocolErrorPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  error: Error & { kind?: string; line?: string; reason?: string },
): Record<string, unknown> {
  return {
    type: "protocol.error",
    error: {
      message: error.message,
      kind: error.kind,
      line: error.line,
      reason: error.reason,
    },
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildStatePayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  state: StdioSupervisorHealth,
): Record<string, unknown> {
  return {
    type: "state",
    state: state.state,
    pid: state.pid,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    lastEventAt: state.lastEventAt,
    lastExitCode: state.lastExitCode,
    lastSignal: state.lastSignal,
    lastError: state.lastError,
    pendingCommands: state.pendingCommands,
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildCommandDispatchErrorPayload(
  adapter: SessionAdapterRecord,
  session: SessionEntry,
  context: ContextRecord,
  command: Partial<Pick<AdapterCommandPayload, "command">>,
  error: Error,
): Record<string, unknown> {
  return {
    type: "command.dispatch.error",
    command: command.command,
    error: {
      message: error.message,
    },
    ...buildSessionEnvelope(adapter, session, context),
  };
}

function buildDebugSnapshot(runtime: ActiveAdapterRuntime): SessionAdapterDebugSnapshot {
  const { adapter, session, context, health, debug } = runtime;
  return {
    adapterId: adapter.adapterId,
    adapterName: adapter.name,
    transport: adapter.transport,
    sessionKey: session.sessionKey,
    sessionName: runtime.sessionName,
    status: adapter.status,
    bind: {
      sessionKey: session.sessionKey,
      sessionName: session.name ?? undefined,
      agentId: session.agentId,
      contextId: context.contextId,
      contextKey: context.contextKey,
      cliName: adapter.definition.bindings.context.cliName,
    },
    health,
    lastEvent: debug.lastEvent,
    lastCommand: debug.lastCommand,
    lastProtocolError: debug.lastProtocolError,
    updatedAt: Date.now(),
  };
}

function persistDebugSnapshot(runtime: ActiveAdapterRuntime): void {
  try {
    saveSessionAdapterDebugSnapshot({
      adapterId: runtime.adapter.adapterId,
      snapshot: buildDebugSnapshot(runtime),
    });
  } catch (error) {
    log.error("Failed to persist adapter debug snapshot", {
      adapterId: runtime.adapter.adapterId,
      error,
    });
  }
}

export interface SessionAdapterBus {
  start(): Promise<void>;
  stop(options?: SessionAdapterBusStopOptions): Promise<void>;
  restart(): Promise<void>;
  health(): { running: boolean; adapters: number };
}

export function createSessionAdapterBus(options: SessionAdapterBusOptions = {}): SessionAdapterBus {
  const transport = options.transport ?? createDefaultTransport();
  const createContext = options.createContext ?? createRuntimeContext;
  const createSupervisor = options.createSupervisor ?? createStdioSupervisor;

  const runtimes = new Map<string, ActiveAdapterRuntime>();
  let running = false;
  let shuttingDown = false;
  let startPromise: Promise<void> | null = null;

  async function publishToFromAdapterTopics(
    runtime: ActiveAdapterRuntime,
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (const topic of runtime.fromAdapterTopics) {
      try {
        await transport.publish(topic, payload);
      } catch (error) {
        log.error("Failed to publish adapter event", {
          adapterId: runtime.adapter.adapterId,
          topic,
          error,
        });
      }
    }
  }

  async function handleStateChange(runtime: ActiveAdapterRuntime, state: StdioSupervisorHealth): Promise<void> {
    runtime.health = state;
    const nextState = state.state;

    if (nextState === "running") {
      runtime.adapter = updateSessionAdapterState(runtime.adapter.adapterId, { status: "running" });
      persistDebugSnapshot(runtime);
      return;
    }

    if (nextState === "stopped") {
      if (shuttingDown) {
        persistDebugSnapshot(runtime);
        return;
      }
      runtime.adapter = updateSessionAdapterState(runtime.adapter.adapterId, { status: "stopped" });
      persistDebugSnapshot(runtime);
      return;
    }

    if (nextState === "broken") {
      runtime.adapter = updateSessionAdapterState(runtime.adapter.adapterId, {
        status: "broken",
        lastError: state.lastError ?? state.lastProtocolError?.reason ?? "adapter broke unexpectedly",
      });
      persistDebugSnapshot(runtime);
    }
  }

  async function startAdapter(runtime: ActiveAdapterRuntime): Promise<void> {
    for (const commandTopic of runtime.toAdapterTopics) {
      const commandSubscription = transport.subscribe(commandTopic, {
        queue: `ravi-adapter-${runtime.adapter.adapterId}`,
      });

      runtime.commandSubscriptions.push(commandSubscription);

      void (async () => {
        try {
          for await (const message of commandSubscription) {
            if (!running) break;

            let payload: AdapterCommandPayload;
            try {
              payload = AdapterCommandPayloadSchema.parse(message.data);
            } catch (error) {
              const dispatchError = error instanceof Error ? error : new Error(String(error));
              await publishToFromAdapterTopics(
                runtime,
                buildCommandDispatchErrorPayload(runtime.adapter, runtime.session, runtime.context, {}, dispatchError),
              );
              continue;
            }

            runtime.debug.lastCommand = {
              command: payload.command,
              args: payload.args,
              payload: payload.payload,
              publishedAt: Date.now(),
              topic: commandTopic,
            };
            persistDebugSnapshot(runtime);

            const commandInput: StdioCommandInput = {
              command: payload.command,
              args: payload.args,
              payload: payload.payload,
              timeoutMs: payload.timeoutMs,
            };

            try {
              await runtime.supervisor.sendCommand(commandInput);
            } catch (error) {
              const dispatchError = error instanceof Error ? error : new Error(String(error));
              await publishToFromAdapterTopics(
                runtime,
                buildCommandDispatchErrorPayload(
                  runtime.adapter,
                  runtime.session,
                  runtime.context,
                  payload,
                  dispatchError,
                ),
              );
            }
          }
        } catch (error) {
          if (running) {
            log.error("Adapter command subscription failed", {
              adapterId: runtime.adapter.adapterId,
              topic: commandTopic,
              error,
            });
          }
        } finally {
          commandSubscription.unsubscribe();
        }
      })();
    }

    runtime.supervisor.events.on("state", (state: StdioSupervisorHealth) => {
      const clonedState = cloneState(state);
      runtime.health = clonedState;
      void handleStateChange(runtime, clonedState).catch((error) => {
        log.error("Failed to persist adapter state", {
          adapterId: runtime.adapter.adapterId,
          error,
        });
      });
      if (!(shuttingDown && clonedState.state === "stopped")) {
        void publishToFromAdapterTopics(
          runtime,
          buildStatePayload(runtime.adapter, runtime.session, runtime.context, clonedState),
        );
      }
    });

    runtime.supervisor.events.on("protocol-event", (event: StdioProtocolEvent) => {
      runtime.debug.lastEvent = {
        topic: runtime.fromAdapterTopics[0],
        type: event.type,
        event: event.event,
        payload: event.payload,
        publishedAt: Date.now(),
      };
      persistDebugSnapshot(runtime);
      void publishToFromAdapterTopics(
        runtime,
        buildProtocolEventPayload(runtime.adapter, runtime.session, runtime.context, event),
      );
    });

    runtime.supervisor.events.on("command-ack", (event: StdioProtocolCommandAck) => {
      void publishToFromAdapterTopics(
        runtime,
        buildCommandAckPayload(runtime.adapter, runtime.session, runtime.context, event),
      );
    });

    runtime.supervisor.events.on("command-result", (event: StdioProtocolCommandResult) => {
      void publishToFromAdapterTopics(
        runtime,
        buildCommandResultPayload(runtime.adapter, runtime.session, runtime.context, event),
      );
    });

    runtime.supervisor.events.on("command-error", (event: StdioProtocolCommandError) => {
      void publishToFromAdapterTopics(
        runtime,
        buildCommandErrorPayload(runtime.adapter, runtime.session, runtime.context, event),
      );
    });

    runtime.supervisor.events.on(
      "protocol-error",
      (error: Error & { kind?: string; line?: string; reason?: string }) => {
        runtime.debug.lastProtocolError = {
          message: error.message,
          kind: error.kind,
          line: error.line,
          reason: error.reason,
          publishedAt: Date.now(),
        };
        persistDebugSnapshot(runtime);
        void publishToFromAdapterTopics(
          runtime,
          buildProtocolErrorPayload(runtime.adapter, runtime.session, runtime.context, error),
        );
      },
    );

    try {
      const health = await runtime.supervisor.start();
      runtime.health = health;
      await handleStateChange(runtime, health);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.adapter = updateSessionAdapterState(runtime.adapter.adapterId, {
        status: "broken",
        lastError: message,
      });
      runtime.health = {
        ...runtime.health,
        state: "broken",
        lastError: message,
      };
      persistDebugSnapshot(runtime);
      log.error("Failed to start session adapter supervisor", {
        adapterId: runtime.adapter.adapterId,
        error,
      });
      for (const commandSubscription of runtime.commandSubscriptions) {
        commandSubscription.unsubscribe();
      }
      runtime.commandSubscriptions.length = 0;
      throw error;
    }
  }

  async function bindAdapter(adapter: SessionAdapterRecord): Promise<void> {
    const session = resolveSessionForAdapter(adapter);
    if (!session) {
      const message = `Session not found for adapter ${adapter.adapterId}`;
      if (adapter.status === "running") {
        updateSessionAdapterState(adapter.adapterId, { status: "broken", lastError: message });
      }
      log.warn(message, { adapterId: adapter.adapterId, sessionKey: adapter.sessionKey });
      return;
    }

    const context = buildRuntimeContext(adapter, session, createContext);
    const sessionName = getSessionTopicName(session, adapter);
    const supervisor = createSupervisor(buildSupervisorOptions(adapter, session, context));
    const toAdapterSubscriptions = listSessionAdapterSubscriptions({
      adapterId: adapter.adapterId,
      direction: "to-adapter",
    }).filter((subscription) => subscription.enabled);
    const fromAdapterSubscriptions = listSessionAdapterSubscriptions({
      adapterId: adapter.adapterId,
      direction: "from-adapter",
    }).filter((subscription) => subscription.enabled);

    const runtime: ActiveAdapterRuntime = {
      adapter,
      session,
      sessionName,
      context,
      supervisor,
      health: {
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
      },
      commandSubscriptions: [],
      toAdapterTopics:
        toAdapterSubscriptions.length > 0
          ? toAdapterSubscriptions.map((subscription) => subscription.topic)
          : [buildSessionAdapterCommandTopic(sessionName)],
      fromAdapterTopics:
        fromAdapterSubscriptions.length > 0
          ? fromAdapterSubscriptions.map((subscription) => subscription.topic)
          : [buildSessionAdapterEventTopic(sessionName)],
      debug: {},
    };

    persistDebugSnapshot(runtime);

    runtimes.set(adapter.adapterId, runtime);

    if (adapter.status !== "running") {
      log.debug("Adapter loaded but not running, skipping auto-start", {
        adapterId: adapter.adapterId,
        sessionKey: adapter.sessionKey,
        status: adapter.status,
      });
      return;
    }

    await startAdapter(runtime);
    log.info("Session adapter bound", {
      adapterId: adapter.adapterId,
      sessionName,
      status: adapter.status,
    });
  }

  async function start(): Promise<void> {
    if (running) return;
    if (startPromise) {
      await startPromise;
      return;
    }

    startPromise = (async () => {
      ensureSessionAdapterStoreSchema();
      running = true;
      shuttingDown = false;

      const adapters = listSessionAdapters();
      log.info("Starting session adapter bus", { adapters: adapters.length });

      for (const adapter of adapters) {
        try {
          await bindAdapter(adapter);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateSessionAdapterState(adapter.adapterId, {
            status: "broken",
            lastError: message,
          });
          log.error("Failed to bind adapter", {
            adapterId: adapter.adapterId,
            error,
          });
        }
      }

      log.info("Session adapter bus started", { adapters: runtimes.size });
    })();

    try {
      await startPromise;
    } catch (error) {
      running = false;
      throw error;
    } finally {
      startPromise = null;
    }
  }

  async function stop(options?: SessionAdapterBusStopOptions): Promise<void> {
    if (!running && runtimes.size === 0) return;

    shuttingDown = options?.preserveAdapterState ?? true;
    running = false;

    const stops = Array.from(runtimes.values()).map(async (runtime) => {
      for (const subscription of runtime.commandSubscriptions) {
        subscription.unsubscribe();
      }
      runtime.commandSubscriptions.length = 0;
      try {
        await runtime.supervisor.stop();
      } catch (error) {
        log.error("Failed to stop session adapter supervisor", {
          adapterId: runtime.adapter.adapterId,
          error,
        });
      }
    });

    await Promise.allSettled(stops);
    runtimes.clear();
    shuttingDown = false;
  }

  async function restart(): Promise<void> {
    await stop({ preserveAdapterState: true });
    await start();
  }

  return {
    start,
    stop,
    restart,
    health() {
      return {
        running,
        adapters: runtimes.size,
      };
    },
  };
}
