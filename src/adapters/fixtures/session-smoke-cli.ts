import { createInterface } from "node:readline";

type CommandEnvelope = {
  type?: unknown;
  id?: unknown;
  command?: unknown;
  args?: unknown;
  payload?: unknown;
};

function writeLine(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

writeLine({
  type: "event",
  event: "ready",
  payload: {
    pid: process.pid,
    smoke: true,
  },
});

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let envelope: CommandEnvelope;
  try {
    envelope = JSON.parse(trimmed) as CommandEnvelope;
  } catch {
    writeLine({
      type: "command.error",
      id: "unknown",
      command: "parse",
      error: {
        message: "invalid command envelope",
        code: "INVALID_COMMAND_JSON",
      },
    });
    return;
  }

  if (envelope.type !== "command" || typeof envelope.id !== "string" || typeof envelope.command !== "string") {
    writeLine({
      type: "command.error",
      id: typeof envelope.id === "string" ? envelope.id : "unknown",
      command: typeof envelope.command === "string" ? envelope.command : "unknown",
      error: {
        message: "invalid command envelope",
        code: "INVALID_COMMAND_SHAPE",
      },
    });
    return;
  }

  switch (envelope.command) {
    case "ping":
      writeLine({
        type: "command.ack",
        id: envelope.id,
        command: envelope.command,
      });
      writeLine({
        type: "command.result",
        id: envelope.id,
        command: envelope.command,
        result: {
          pong: true,
          args: Array.isArray(envelope.args) ? envelope.args : [],
          payload: envelope.payload ?? null,
        },
      });
      return;
    case "emit-event":
      writeLine({
        type: "command.ack",
        id: envelope.id,
        command: envelope.command,
      });
      writeLine({
        type: "event",
        event: "tick",
        payload: {
          args: Array.isArray(envelope.args) ? envelope.args : [],
          payload: envelope.payload ?? null,
          pid: process.pid,
        },
      });
      writeLine({
        type: "command.result",
        id: envelope.id,
        command: envelope.command,
        result: {
          emitted: "tick",
        },
      });
      return;
    case "exit-clean":
      writeLine({
        type: "command.ack",
        id: envelope.id,
        command: envelope.command,
      });
      process.exit(0);
      return;
    case "emit-invalid-event":
      writeLine({
        type: "command.ack",
        id: envelope.id,
        command: envelope.command,
      });
      process.stdout.write('{"type":"event","payload":{"broken":true}}\n');
      return;
    default:
      writeLine({
        type: "command.ack",
        id: envelope.id,
        command: envelope.command,
      });
      writeLine({
        type: "command.error",
        id: envelope.id,
        command: envelope.command,
        error: {
          message: `unknown command: ${envelope.command}`,
          code: "UNKNOWN_COMMAND",
        },
      });
  }
});

process.stdin.resume();
