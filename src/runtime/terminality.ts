import type { RuntimeEvent, RuntimeEventMetadata } from "./types.js";

export type RuntimeTerminalEvent = Extract<
  RuntimeEvent,
  { type: "turn.complete" | "turn.failed" | "turn.interrupted" }
>;

export function isRuntimeTerminalEvent(event: RuntimeEvent): event is RuntimeTerminalEvent {
  return event.type === "turn.complete" || event.type === "turn.failed" || event.type === "turn.interrupted";
}

export interface RuntimeFailedTerminalInput {
  error: string;
  recoverable?: boolean;
  rawEvent?: Record<string, unknown>;
  metadata?: RuntimeEventMetadata;
}

export interface RuntimeInterruptedTerminalInput {
  rawEvent?: Record<string, unknown>;
  metadata?: RuntimeEventMetadata;
}

export interface RuntimeTerminalEventTracker {
  readonly terminalEmitted: boolean;
  accept(event: RuntimeEvent): boolean;
  fail(input: RuntimeFailedTerminalInput): Extract<RuntimeEvent, { type: "turn.failed" }> | null;
  interrupt(input?: RuntimeInterruptedTerminalInput): Extract<RuntimeEvent, { type: "turn.interrupted" }> | null;
}

export function createRuntimeTerminalEventTracker(): RuntimeTerminalEventTracker {
  let terminalEmitted = false;

  const markTerminal = (): boolean => {
    if (terminalEmitted) {
      return false;
    }
    terminalEmitted = true;
    return true;
  };

  return {
    get terminalEmitted() {
      return terminalEmitted;
    },
    accept(event) {
      return isRuntimeTerminalEvent(event) ? markTerminal() : true;
    },
    fail(input) {
      if (!markTerminal()) {
        return null;
      }
      return {
        type: "turn.failed",
        error: input.error,
        recoverable: input.recoverable,
        ...(input.rawEvent ? { rawEvent: input.rawEvent } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
    },
    interrupt(input = {}) {
      if (!markTerminal()) {
        return null;
      }
      return {
        type: "turn.interrupted",
        ...(input.rawEvent ? { rawEvent: input.rawEvent } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
    },
  };
}
