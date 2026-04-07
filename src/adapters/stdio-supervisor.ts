import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const DEFAULT_STOP_TIMEOUT_MS = 1_500;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const STDERR_TAIL_LIMIT = 4_096;

const StdioProtocolEventSchema = z
  .object({
    type: z.literal("event"),
    event: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .strict();

const StdioCommandAckSchema = z
  .object({
    type: z.literal("command.ack"),
    id: z.string().min(1),
    command: z.string().min(1),
  })
  .strict();

const StdioCommandResultSchema = z
  .object({
    type: z.literal("command.result"),
    id: z.string().min(1),
    command: z.string().min(1),
    result: z.unknown().optional(),
  })
  .strict();

const StdioCommandErrorSchema = z
  .object({
    type: z.literal("command.error"),
    id: z.string().min(1),
    command: z.string().min(1),
    error: z
      .object({
        message: z.string().min(1),
        code: z.string().min(1).optional(),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const StdioProtocolMessageSchema = z.discriminatedUnion("type", [
  StdioProtocolEventSchema,
  StdioCommandAckSchema,
  StdioCommandResultSchema,
  StdioCommandErrorSchema,
]);

const StdioCommandEnvelopeSchema = z
  .object({
    type: z.literal("command"),
    id: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    payload: z.unknown().optional(),
  })
  .strict();

type StdioProtocolMessage = z.infer<typeof StdioProtocolMessageSchema>;

export type StdioProtocolEvent = z.infer<typeof StdioProtocolEventSchema>;
export type StdioProtocolCommandAck = z.infer<typeof StdioCommandAckSchema>;
export type StdioProtocolCommandResult = z.infer<typeof StdioCommandResultSchema>;
export type StdioProtocolCommandError = z.infer<typeof StdioCommandErrorSchema>;
export type StdioCommandEnvelope = z.infer<typeof StdioCommandEnvelopeSchema>;

export interface StdioProtocolParseFailure extends Error {
  kind: "stdio-protocol-error";
  line: string;
  reason: string;
}

export type StdioProtocolParseResult =
  | { ok: true; message: StdioProtocolMessage }
  | { ok: false; error: StdioProtocolParseFailure };

export type StdioSupervisorState = "stopped" | "starting" | "running" | "stopping" | "broken";

export interface StdioSupervisorHealth {
  state: StdioSupervisorState;
  pid: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  lastEventAt: number | null;
  lastExitCode: number | null;
  lastSignal: NodeJS.Signals | null;
  lastError: string | null;
  lastProtocolError: StdioProtocolParseFailure | null;
  pendingCommands: number;
  stderrTail: string;
}

export interface StdioCommandInput {
  command: string;
  args?: string[];
  payload?: unknown;
  timeoutMs?: number;
}

export interface StdioSupervisorOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stopTimeoutMs?: number;
}

export interface StdioSupervisor {
  readonly events: EventEmitter;
  start(): Promise<StdioSupervisorHealth>;
  stop(): Promise<StdioSupervisorHealth>;
  restart(): Promise<StdioSupervisorHealth>;
  sendCommand(input: StdioCommandInput): Promise<StdioProtocolCommandResult>;
  health(): StdioSupervisorHealth;
}

interface PendingCommand {
  command: string;
  acked: boolean;
  resolve(result: StdioProtocolCommandResult): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
}

function cloneHealth(health: StdioSupervisorHealth): StdioSupervisorHealth {
  return {
    ...health,
    lastProtocolError: health.lastProtocolError
      ? Object.assign(new Error(health.lastProtocolError.message), {
          kind: health.lastProtocolError.kind,
          line: health.lastProtocolError.line,
          reason: health.lastProtocolError.reason,
        })
      : null,
  };
}

function createProtocolError(line: string, reason: string, cause?: unknown): StdioProtocolParseFailure {
  const error = Object.assign(new Error(reason), {
    kind: "stdio-protocol-error" as const,
    line,
    reason,
  });

  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }

  return error;
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function parseStdioProtocolLineInternal(line: string): StdioProtocolParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: createProtocolError(line, "Stdout protocol violation: empty line is not valid JSON protocol output"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return {
      ok: false,
      error: createProtocolError(line, "Stdout protocol violation: line is not valid JSON", cause),
    };
  }

  const validated = StdioProtocolMessageSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      error: createProtocolError(line, `Stdout protocol violation: ${formatValidationIssues(validated.error)}`),
    };
  }

  return {
    ok: true,
    message: validated.data,
  };
}

function buildCommandEnvelope(id: string, input: StdioCommandInput): StdioCommandEnvelope {
  return StdioCommandEnvelopeSchema.parse({
    type: "command",
    id,
    command: input.command,
    args: input.args ?? [],
    payload: input.payload,
  });
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= STDERR_TAIL_LIMIT) {
    return next;
  }
  return next.slice(next.length - STDERR_TAIL_LIMIT);
}

function createSupervisorError(message: string): Error {
  return new Error(message);
}

export function parseStdioProtocolLine(line: string): StdioProtocolParseResult {
  return parseStdioProtocolLineInternal(line);
}

export function formatStdioCommandEnvelope(input: StdioCommandInput & { id: string }): string {
  return `${JSON.stringify(buildCommandEnvelope(input.id, input))}\n`;
}

export function createStdioSupervisor(options: StdioSupervisorOptions): StdioSupervisor {
  const events = new EventEmitter();
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams | null = null;
  let commandSeq = 0;
  let stopRequested = false;
  let closeResolver: ((health: StdioSupervisorHealth) => void) | null = null;
  let closePromise: Promise<StdioSupervisorHealth> | null = null;
  let forcedKillTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingCommands = new Map<string, PendingCommand>();

  const health: StdioSupervisorHealth = {
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

  function snapshot(): StdioSupervisorHealth {
    return cloneHealth(health);
  }

  function emitHealthChange(): void {
    events.emit("state", snapshot());
  }

  function clearForcedKillTimer(): void {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer);
      forcedKillTimer = null;
    }
  }

  function rejectPendingCommands(error: Error): void {
    for (const pending of pendingCommands.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    pendingCommands.clear();
    health.pendingCommands = 0;
  }

  function writeLine(payload: string): Promise<void> {
    const activeChild = child;
    if (!activeChild?.stdin) {
      throw createSupervisorError("Supervisor stdin is unavailable");
    }

    return new Promise<void>((resolve, reject) => {
      activeChild.stdin.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function handleProtocolError(error: StdioProtocolParseFailure): void {
    if (health.state === "broken") {
      return;
    }

    health.state = "broken";
    health.lastProtocolError = error;
    health.lastError = error.reason;
    emitHealthChange();
    events.emit("protocol-error", error);
    rejectPendingCommands(error);
    child?.kill("SIGKILL");
  }

  function handleProtocolEvent(event: StdioProtocolEvent): void {
    health.lastEventAt = Date.now();
    events.emit("protocol-event", event);
    emitHealthChange();
  }

  function handleCommandAck(event: StdioProtocolCommandAck): void {
    const pending = pendingCommands.get(event.id);
    if (!pending || pending.command !== event.command) {
      handleProtocolError(
        createProtocolError(JSON.stringify(event), `Unexpected command acknowledgement for ${event.id}`),
      );
      return;
    }

    pending.acked = true;
    events.emit("command-ack", event);
  }

  function settlePendingCommandResult(event: StdioProtocolCommandResult): void {
    const pending = pendingCommands.get(event.id);
    if (!pending || pending.command !== event.command) {
      handleProtocolError(createProtocolError(JSON.stringify(event), `Unexpected command result for ${event.id}`));
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pendingCommands.delete(event.id);
    health.pendingCommands = pendingCommands.size;
    events.emit("command-result", event);
    pending.resolve(event);
    emitHealthChange();
  }

  function settlePendingCommandError(event: StdioProtocolCommandError): void {
    const pending = pendingCommands.get(event.id);
    if (!pending || pending.command !== event.command) {
      handleProtocolError(createProtocolError(JSON.stringify(event), `Unexpected command error for ${event.id}`));
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pendingCommands.delete(event.id);
    health.pendingCommands = pendingCommands.size;
    const error = Object.assign(new Error(event.error.message), {
      code: event.error.code,
      details: event.error.details,
      id: event.id,
      command: event.command,
    });
    events.emit("command-error", error);
    pending.reject(error);
    emitHealthChange();
  }

  function handleStdoutLine(line: string): void {
    const parsed = parseStdioProtocolLineInternal(line);
    if (!parsed.ok) {
      handleProtocolError(parsed.error);
      return;
    }

    switch (parsed.message.type) {
      case "event":
        handleProtocolEvent(parsed.message);
        return;
      case "command.ack":
        handleCommandAck(parsed.message);
        return;
      case "command.result":
        settlePendingCommandResult(parsed.message);
        return;
      case "command.error":
        settlePendingCommandError(parsed.message);
        return;
      default:
        handleProtocolError(createProtocolError(line, "Unknown stdout protocol message type"));
    }
  }

  function handleChildClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    clearForcedKillTimer();
    const wasStopping = stopRequested;
    stopRequested = false;

    health.pid = null;
    health.stoppedAt = Date.now();
    health.lastExitCode = exitCode;
    health.lastSignal = signal;

    if (health.state !== "broken") {
      health.state = wasStopping ? "stopped" : "broken";
    }
    if (health.state === "broken" && !health.lastError) {
      health.lastError = `process exited unexpectedly (${signal ?? exitCode ?? "unknown"})`;
    }

    const closeError = wasStopping
      ? createSupervisorError("Supervisor stopped")
      : health.state === "broken" && health.lastProtocolError
        ? health.lastProtocolError
        : createSupervisorError(`Supervisor process exited (${signal ?? exitCode ?? "unknown"})`);

    rejectPendingCommands(closeError);

    child = null;
    if (closeResolver) {
      closeResolver(snapshot());
      closeResolver = null;
      closePromise = null;
    }

    emitHealthChange();
  }

  async function start(): Promise<StdioSupervisorHealth> {
    if (health.state === "starting" || health.state === "running" || health.state === "stopping") {
      throw createSupervisorError(`Supervisor is already ${health.state}`);
    }

    health.state = "starting";
    health.lastProtocolError = null;
    health.lastError = null;
    health.lastExitCode = null;
    health.lastSignal = null;
    health.startedAt = Date.now();
    health.stoppedAt = null;
    health.stderrTail = "";
    health.pendingCommands = pendingCommands.size;
    emitHealthChange();

    const mergedEnv = options.env ? { ...process.env, ...options.env } : process.env;
    const spawned = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child = spawned;
    closePromise = new Promise<StdioSupervisorHealth>((resolve) => {
      closeResolver = resolve;
    });

    spawned.stdout.setEncoding("utf8");
    const stdoutLines = createInterface({ input: spawned.stdout, crlfDelay: Infinity });
    stdoutLines.on("line", handleStdoutLine);

    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      health.stderrTail = appendTail(health.stderrTail, chunk);
      emitHealthChange();
    });

    spawned.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || stopRequested) {
        return;
      }
      health.lastError = error.message;
      handleProtocolError(createProtocolError("", `Child stdin failed: ${error.message}`, error));
    });

    spawned.on("error", (error) => {
      health.state = "broken";
      health.lastError = error.message;
      emitHealthChange();
      rejectPendingCommands(error);
      if (closeResolver) {
        closeResolver(snapshot());
        closeResolver = null;
        closePromise = null;
      }
    });

    spawned.on("close", handleChildClose);

    await new Promise<void>((resolve, reject) => {
      spawned.once("spawn", () => {
        health.state = "running";
        health.pid = spawned.pid ?? null;
        health.startedAt = health.startedAt ?? Date.now();
        emitHealthChange();
        resolve();
      });

      spawned.once("error", reject);
    });

    return snapshot();
  }

  async function stop(): Promise<StdioSupervisorHealth> {
    if (!child) {
      health.state = health.state === "broken" ? "broken" : "stopped";
      health.pid = null;
      health.stoppedAt = health.stoppedAt ?? Date.now();
      emitHealthChange();
      return snapshot();
    }

    stopRequested = true;
    health.state = "stopping";
    emitHealthChange();

    const activeChild = child;
    activeChild.kill("SIGTERM");

    clearForcedKillTimer();
    forcedKillTimer = setTimeout(() => {
      activeChild.kill("SIGKILL");
    }, stopTimeoutMs);
    forcedKillTimer.unref?.();

    if (!closePromise) {
      return snapshot();
    }

    const finished = await closePromise;
    clearForcedKillTimer();
    return finished;
  }

  async function restart(): Promise<StdioSupervisorHealth> {
    await stop();
    return start();
  }

  async function sendCommand(input: StdioCommandInput): Promise<StdioProtocolCommandResult> {
    if (health.state !== "running" || !child) {
      throw createSupervisorError(`Supervisor is not running (${health.state})`);
    }

    const validated = {
      command: input.command,
      args: input.args ?? [],
      payload: input.payload,
    };
    const id = `cmd-${++commandSeq}`;
    const envelope = buildCommandEnvelope(id, validated);

    const pending = await new Promise<StdioProtocolCommandResult>((resolve, reject) => {
      const timeout = input.timeoutMs ?? commandTimeoutMs;
      const pendingCommand: PendingCommand = {
        command: input.command,
        acked: false,
        resolve,
        reject,
        timeout: null,
      };

      if (timeout > 0) {
        pendingCommand.timeout = setTimeout(() => {
          pendingCommands.delete(id);
          health.pendingCommands = pendingCommands.size;
          const error = createSupervisorError(`Timed out waiting for adapter command ${input.command}`);
          reject(error);
          emitHealthChange();
        }, timeout);
        pendingCommand.timeout.unref?.();
      }

      pendingCommands.set(id, pendingCommand);
      health.pendingCommands = pendingCommands.size;
      emitHealthChange();

      void writeLine(`${JSON.stringify(envelope)}\n`).catch((error) => {
        if (pendingCommands.has(id)) {
          pendingCommands.delete(id);
          health.pendingCommands = pendingCommands.size;
          if (pendingCommand.timeout) {
            clearTimeout(pendingCommand.timeout);
          }
          reject(error as Error);
          emitHealthChange();
        }
      });
    });

    return pending;
  }

  return {
    events,
    start,
    stop,
    restart,
    sendCommand,
    health: () => snapshot(),
  };
}
