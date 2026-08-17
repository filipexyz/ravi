export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export type ToolLivenessSchedule = (callback: () => void, delayMs: number) => () => void;

export interface ToolLivenessLease {
  start(toolUseId: string): void;
  progress(toolUseId: string): boolean;
  clear(): void;
}

export function createToolLivenessLease(options: {
  inactivityTimeoutMs?: number;
  onInactive(toolUseId: string): void;
  schedule?: ToolLivenessSchedule;
}): ToolLivenessLease {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
  if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new Error("Tool inactivity timeout must be a positive finite number");
  }

  const schedule = options.schedule ?? scheduleTimeout;
  let activeToolUseId: string | undefined;
  let cancelExpiry: (() => void) | undefined;
  let generation = 0;

  const clearExpiry = () => {
    generation++;
    cancelExpiry?.();
    cancelExpiry = undefined;
  };

  const arm = () => {
    clearExpiry();
    const scheduledGeneration = generation;
    cancelExpiry = schedule(() => {
      if (scheduledGeneration !== generation || !activeToolUseId) return;
      const inactiveToolUseId = activeToolUseId;
      activeToolUseId = undefined;
      cancelExpiry = undefined;
      options.onInactive(inactiveToolUseId);
    }, inactivityTimeoutMs);
  };

  return {
    start(toolUseId) {
      activeToolUseId = toolUseId;
      arm();
    },
    progress(toolUseId) {
      if (toolUseId !== activeToolUseId) return false;
      arm();
      return true;
    },
    clear() {
      clearExpiry();
      activeToolUseId = undefined;
    },
  };
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}
