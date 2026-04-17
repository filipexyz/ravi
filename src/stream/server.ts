import { createInterface } from "node:readline";
import { ZodError } from "zod";
import { nats } from "../nats.js";
import {
  TASK_STREAM_CAPABILITIES,
  TASK_STREAM_SCOPE,
  TASK_STREAM_TOPIC_PATTERNS,
  buildTaskStreamSnapshot,
  executeTaskStreamCommand,
  isTaskStreamCommand,
} from "../tasks/index.js";
import {
  STREAM_PROTOCOL_VERSION,
  type StreamCommandMessage,
  type StreamHelloBody,
  type StreamInputMessage,
  makeStreamMessageId,
  makeStreamTimestamp,
  parseStreamInputLine,
} from "./protocol.js";

const DEFAULT_HEARTBEAT_MS = 5_000;
const BASE_CAPABILITIES = ["snapshot.open", "ping"] as const;
const OVERLAY_WHATSAPP_CAPABILITIES = [...BASE_CAPABILITIES, "placeholder.outline"] as const;

const STREAM_SCOPE_TOPICS: Record<string, string[]> = {
  "overlay.whatsapp": ["ravi.session.>", "ravi.route.>", "ravi.approval.>", "ravi._cli.cli.>"],
  events: [">"],
  [TASK_STREAM_SCOPE]: [...TASK_STREAM_TOPIC_PATTERNS],
};

export interface StreamServerOptions {
  scope: string;
  topicPatterns?: string[];
  heartbeatMs?: number;
  source?: string;
}

export function resolveTopicPatterns(scope: string, topicPatterns?: string[]): string[] {
  if (topicPatterns && topicPatterns.length > 0) {
    return [...new Set(topicPatterns)];
  }
  return STREAM_SCOPE_TOPICS[scope] ?? [">"];
}

export function resolveStreamCapabilities(scope: string): string[] {
  if (scope === "overlay.whatsapp") {
    return [...OVERLAY_WHATSAPP_CAPABILITIES];
  }
  if (scope === TASK_STREAM_SCOPE) {
    return [...TASK_STREAM_CAPABILITIES];
  }
  return [...BASE_CAPABILITIES];
}

function writeOutput(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildHello(_source: string, scope: string, topicPatterns: string[]): StreamHelloBody {
  return {
    scope,
    topicPatterns,
    capabilities: resolveStreamCapabilities(scope),
    protocolVersion: STREAM_PROTOCOL_VERSION,
  };
}

function buildCursor(seq: number): string {
  return `local:${seq}`;
}

export async function runCliStreamServer(options: StreamServerOptions): Promise<void> {
  const startedAt = new Date();
  const source = options.source ?? "ravi.stream";
  const scope = options.scope;
  let topicPatterns = resolveTopicPatterns(scope, options.topicPatterns);
  const heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  let seq = 0;

  const emitHello = () => {
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "hello",
      id: makeStreamMessageId("hello"),
      ts: makeStreamTimestamp(),
      source,
      body: buildHello(source, scope, topicPatterns),
    });
  };

  const emitSnapshot = (args: Record<string, unknown> = {}) => {
    const entities = scope === TASK_STREAM_SCOPE ? { tasks: buildTaskStreamSnapshot(args) } : {};
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "snapshot",
      id: makeStreamMessageId("snapshot"),
      ts: makeStreamTimestamp(),
      source,
      cursor: buildCursor(seq),
      body: {
        scope,
        entities,
        filters: { topicPatterns },
        runtime: {
          pid: process.pid,
          startedAt: startedAt.toISOString(),
        },
        capabilities: resolveStreamCapabilities(scope),
      },
    });
  };

  const emitAck = (commandId: string, result?: unknown) => {
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "ack",
      id: makeStreamMessageId("ack"),
      ts: makeStreamTimestamp(),
      source,
      body: {
        commandId,
        ok: true,
        result,
      },
    });
  };

  const emitError = (message: {
    commandId?: string;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  }) => {
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "error",
      id: makeStreamMessageId("error"),
      ts: makeStreamTimestamp(),
      source,
      body: {
        commandId: message.commandId,
        code: message.code,
        message: message.message,
        retryable: message.retryable ?? false,
        details: message.details,
      },
    });
  };

  const emitCommandEvent = (topic: string, body: Record<string, unknown>) => {
    seq += 1;
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "event",
      id: makeStreamMessageId("event"),
      ts: makeStreamTimestamp(),
      source,
      topic,
      cursor: buildCursor(seq),
      body,
    });
  };

  const emitCommandError = (commandId: string, commandName: string, error: unknown) => {
    if (error instanceof ZodError) {
      emitError({
        commandId,
        code: "invalid_command",
        message: error.issues[0]?.message ?? `Invalid arguments for ${commandName}`,
        retryable: false,
        details: error.flatten(),
      });
      return;
    }

    if (error instanceof Error) {
      const lower = error.message.toLowerCase();
      const code = lower.includes("not found")
        ? "not_found"
        : lower.includes("already belongs")
          ? "conflict"
          : "command_failed";
      emitError({
        commandId,
        code,
        message: error.message,
        retryable: false,
      });
      return;
    }

    emitError({
      commandId,
      code: "command_failed",
      message: String(error),
      retryable: false,
    });
  };

  const handleCommand = async (message: StreamCommandMessage) => {
    const { id, body } = message;
    try {
      if (body.name === "snapshot.open") {
        emitSnapshot(body.args);
        emitAck(id, { emitted: "snapshot" });
        return;
      }
      if (body.name === "ping") {
        emitAck(id, { pong: true, now: makeStreamTimestamp() });
        return;
      }
      if (scope === TASK_STREAM_SCOPE && isTaskStreamCommand(body.name)) {
        const result = await executeTaskStreamCommand(body.name, body.args, {
          actor: source,
        });
        emitAck(id, result);
        return;
      }
      if (scope === "overlay.whatsapp" && body.name === "placeholder.outline") {
        const componentId = typeof body.args.componentId === "string" ? body.args.componentId.trim() : "";
        const selector = typeof body.args.selector === "string" ? body.args.selector.trim() : "";
        if (!componentId) {
          emitError({
            commandId: id,
            code: "invalid_command",
            message: "placeholder.outline requires componentId",
            retryable: false,
          });
          return;
        }
        if (!selector) {
          emitError({
            commandId: id,
            code: "invalid_command",
            message: "placeholder.outline requires selector",
            retryable: false,
          });
          return;
        }

        emitCommandEvent("overlay.whatsapp.command.requested", {
          commandId: id,
          name: body.name,
          args: body.args,
        });
        emitAck(id, {
          accepted: true,
          emitted: "overlay.whatsapp.command.requested",
          command: body.name,
          componentId,
        });
        return;
      }
      if (body.name === "stream.resume") {
        emitError({
          commandId: id,
          code: "not_supported",
          message: "stream.resume is not supported in v1 yet",
          retryable: false,
        });
        return;
      }
      emitError({
        commandId: id,
        code: "unknown_command",
        message: `Unknown stream command: ${body.name}`,
        retryable: false,
      });
    } catch (error) {
      emitCommandError(id, body.name, error);
    }
  };

  const heartbeatTimer = setInterval(() => {
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "heartbeat",
      id: makeStreamMessageId("heartbeat"),
      ts: makeStreamTimestamp(),
      source,
      body: {
        uptimeMs: Date.now() - startedAt.getTime(),
        cursor: buildCursor(seq),
      },
    });
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  process.on("SIGINT", () => {
    clearInterval(heartbeatTimer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(heartbeatTimer);
    process.exit(0);
  });

  emitHello();

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: StreamInputMessage;
    try {
      parsed = parseStreamInputLine(trimmed);
    } catch (error) {
      emitError({
        code: "invalid_input",
        message: error instanceof Error ? error.message : "Invalid JSONL input",
        retryable: false,
      });
      return;
    }

    if (parsed.type === "hello") {
      if (parsed.body.scope && parsed.body.scope !== scope) {
        emitError({
          code: "scope_mismatch",
          message: `CLI stream started for scope=${scope}; runtime requested scope=${parsed.body.scope}`,
          retryable: false,
        });
        return;
      }

      if (parsed.body.topicPatterns.length > 0) {
        topicPatterns = resolveTopicPatterns(scope, parsed.body.topicPatterns);
      }

      emitHello();
      return;
    }

    void handleCommand(parsed);
  });

  for await (const event of nats.subscribe(...topicPatterns)) {
    seq += 1;
    writeOutput({
      v: STREAM_PROTOCOL_VERSION,
      type: "event",
      id: makeStreamMessageId("event"),
      ts: makeStreamTimestamp(),
      source,
      topic: event.topic,
      cursor: buildCursor(seq),
      body: event.data,
    });
  }
}
