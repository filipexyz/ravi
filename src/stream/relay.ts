import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  STREAM_PROTOCOL_VERSION,
  type StreamAckMessage,
  type StreamErrorMessage,
  type StreamEventMessage,
  type StreamHelloMessage,
  type StreamInputHelloMessage,
  type StreamInputMessage,
  type StreamOutputMessage,
  type StreamSnapshotMessage,
  formatStreamLine,
  makeStreamMessageId,
  makeStreamTimestamp,
  parseStreamOutputLine,
} from "./protocol.js";

export class CliStreamRelayCommandError extends Error {
  readonly commandId: string | null;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(body: StreamErrorMessage["body"]) {
    super(body.message);
    this.name = "CliStreamRelayCommandError";
    this.commandId = body.commandId ?? null;
    this.code = body.code;
    this.retryable = body.retryable ?? false;
    this.details = body.details;
  }
}

export interface CliStreamRelayOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scope: string;
  topicPatterns?: string[];
  startTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface CliStreamRelayState {
  status: "stopped" | "starting" | "running" | "broken";
  pid: number | null;
  scope: string;
  topicPatterns: string[];
  hello: StreamHelloMessage | null;
  snapshot: StreamSnapshotMessage | null;
  lastEvent: StreamEventMessage | null;
  lastHeartbeatAt: string | null;
  lastCursor: string | null;
  lastError: string | null;
  pendingCommands: number;
}

export interface CliStreamRelay {
  readonly events: EventEmitter;
  start(): Promise<CliStreamRelayState>;
  stop(): Promise<void>;
  health(): CliStreamRelayState;
  requestSnapshot(): Promise<StreamSnapshotMessage>;
  sendCommand(name: string, args?: Record<string, unknown>): Promise<StreamAckMessage>;
}

interface PendingCommand {
  resolve(value: StreamAckMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

function cloneState(state: CliStreamRelayState): CliStreamRelayState {
  return {
    ...state,
    hello: state.hello ? structuredClone(state.hello) : null,
    snapshot: state.snapshot ? structuredClone(state.snapshot) : null,
    lastEvent: state.lastEvent ? structuredClone(state.lastEvent) : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createCliStreamRelay(options: CliStreamRelayOptions): CliStreamRelay {
  const events = new EventEmitter();
  const startTimeoutMs = options.startTimeoutMs ?? 4_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 4_000;
  const state: CliStreamRelayState = {
    status: "stopped",
    pid: null,
    scope: options.scope,
    topicPatterns: options.topicPatterns ?? [],
    hello: null,
    snapshot: null,
    lastEvent: null,
    lastHeartbeatAt: null,
    lastCursor: null,
    lastError: null,
    pendingCommands: 0,
  };

  let child: ChildProcessWithoutNullStreams | null = null;
  let lineReader: ReturnType<typeof createInterface> | null = null;
  const pending = new Map<string, PendingCommand>();

  function snapshotState(): CliStreamRelayState {
    state.pendingCommands = pending.size;
    return cloneState(state);
  }

  function rejectAll(error: Error): void {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
      pending.delete(id);
    }
  }

  function writeInput(message: StreamInputMessage): void {
    if (!child) {
      throw new Error("CLI stream relay is not running");
    }
    child.stdin.write(formatStreamLine(message));
  }

  function sendHello(): void {
    const message: StreamInputHelloMessage = {
      v: STREAM_PROTOCOL_VERSION,
      type: "hello",
      id: makeStreamMessageId("hello"),
      ts: makeStreamTimestamp(),
      body: {
        scope: options.scope,
        topicPatterns: options.topicPatterns ?? [],
      },
    };
    writeInput(message);
  }

  function handleMessage(message: StreamOutputMessage): void {
    if ("cursor" in message && typeof message.cursor === "string") {
      state.lastCursor = message.cursor;
    }

    if (message.type === "hello") {
      if (state.status === "starting") {
        state.status = "running";
      }
      state.hello = message;
      state.topicPatterns = message.body.topicPatterns;
      events.emit("hello", message);
      return;
    }

    if (message.type === "snapshot") {
      state.snapshot = message;
      events.emit("snapshot", message);
      return;
    }

    if (message.type === "event") {
      state.lastEvent = message;
      events.emit("event", message);
      return;
    }

    if (message.type === "heartbeat") {
      state.lastHeartbeatAt = message.ts;
      events.emit("heartbeat", message);
      return;
    }

    if (message.type === "ack") {
      const commandId = message.body.commandId;
      const entry = pending.get(commandId);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(commandId);
        entry.resolve(message);
      }
      events.emit("ack", message);
      return;
    }

    if (message.type === "error") {
      state.lastError = message.body.message;
      const commandId = message.body.commandId;
      if (commandId) {
        const entry = pending.get(commandId);
        if (entry) {
          clearTimeout(entry.timeout);
          pending.delete(commandId);
          entry.reject(new CliStreamRelayCommandError(message.body));
        }
      }
      events.emit("error", message);
      return;
    }

    events.emit("metric", message);
  }

  async function start(): Promise<CliStreamRelayState> {
    if (state.status === "running" || state.status === "starting") {
      return snapshotState();
    }

    state.status = "starting";
    state.lastError = null;
    const helloReady = deferred<StreamHelloMessage>();

    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    state.pid = child.pid ?? null;
    lineReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    lineReader.on("line", (line) => {
      try {
        const message = parseStreamOutputLine(line);
        handleMessage(message);
        if (message.type === "hello" && !state.hello) {
          helloReady.resolve(message);
        } else if (message.type === "hello" && state.hello) {
          helloReady.resolve(message);
        }
      } catch (error) {
        state.status = "broken";
        state.lastError = error instanceof Error ? error.message : "Invalid JSONL output";
        rejectAll(new Error(state.lastError));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      state.lastError = text.trim() || state.lastError;
    });

    child.on("exit", (code, signal) => {
      const reason = `CLI stream exited (${code ?? "null"}${signal ? ` ${signal}` : ""})`;
      if (state.status !== "stopped") {
        state.status = "broken";
        state.lastError = reason;
      }
      rejectAll(new Error(reason));
    });

    sendHello();

    const timer = setTimeout(() => {
      helloReady.reject(new Error(`Timed out waiting for stream hello after ${startTimeoutMs}ms`));
    }, startTimeoutMs);
    timer.unref?.();

    try {
      await helloReady.promise;
      state.status = "running";
      return snapshotState();
    } finally {
      clearTimeout(timer);
    }
  }

  async function stop(): Promise<void> {
    state.status = "stopped";
    rejectAll(new Error("CLI stream relay stopped"));
    lineReader?.close();
    lineReader = null;
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }
    state.pid = null;
  }

  async function sendCommand(name: string, args: Record<string, unknown> = {}): Promise<StreamAckMessage> {
    if (state.status !== "running") {
      throw new Error("CLI stream relay is not running");
    }
    const id = makeStreamMessageId("cmd");
    const commandMessage = {
      v: STREAM_PROTOCOL_VERSION,
      type: "command" as const,
      id,
      ts: makeStreamTimestamp(),
      body: {
        name,
        args,
        expectAck: true,
        timeoutMs: commandTimeoutMs,
      },
    };

    const result = deferred<StreamAckMessage>();
    const timeout = setTimeout(() => {
      pending.delete(id);
      result.reject(new Error(`Timed out waiting for ack: ${name}`));
    }, commandTimeoutMs);
    timeout.unref?.();

    pending.set(id, {
      resolve: result.resolve,
      reject: result.reject,
      timeout,
    });

    writeInput(commandMessage);
    return result.promise;
  }

  async function requestSnapshot(): Promise<StreamSnapshotMessage> {
    if (state.status !== "running") {
      throw new Error("CLI stream relay is not running");
    }

    const nextSnapshot = deferred<StreamSnapshotMessage>();
    const timeout = setTimeout(() => {
      cleanup();
      nextSnapshot.reject(new Error("Timed out waiting for snapshot"));
    }, commandTimeoutMs);
    timeout.unref?.();

    const onSnapshot = (message: StreamSnapshotMessage) => {
      cleanup();
      nextSnapshot.resolve(message);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      events.off("snapshot", onSnapshot);
    };

    events.on("snapshot", onSnapshot);
    await sendCommand("snapshot.open");
    return nextSnapshot.promise;
  }

  return {
    events,
    start,
    stop,
    health: snapshotState,
    requestSnapshot,
    sendCommand,
  };
}
