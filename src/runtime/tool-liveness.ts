export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Ceiling for a timeout a tool declares for itself. Without a ceiling a single
 * call could park the session for a day with no event at all.
 */
export const MAX_DECLARED_TOOL_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Tools that can run for a long time accept a `timeout` in seconds (bash-like
 * tools do, and agents already pass it). Honor it so work we agreed to wait on
 * is not killed by the generic window. Adds a margin for teardown and clamps to
 * the ceiling.
 */
export function resolveDeclaredToolTimeoutMs(
  input: unknown,
  options: { fallbackMs?: number; maxMs?: number } = {},
): number {
  const fallback = options.fallbackMs ?? DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
  const ceiling = options.maxMs ?? MAX_DECLARED_TOOL_TIMEOUT_MS;
  if (!input || typeof input !== "object") return fallback;

  const raw = (input as Record<string, unknown>).timeout;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;

  return Math.min(Math.max(Math.round(seconds * 1000 * 1.25), fallback), ceiling);
}

export type ToolLivenessSchedule = (callback: () => void, delayMs: number) => () => void;

export interface ToolLivenessLease {
  /**
   * Arm the lease for a tool. `timeoutMs` overrides the lease default, which is
   * how a tool that declares its own runtime (a long scan, a slow build) keeps
   * ownership of its own inactivity window instead of being killed early.
   */
  start(toolUseId: string, timeoutMs?: number): void;
  progress(toolUseId: string): boolean;
  clear(): void;
}

export function createToolLivenessLease(options: {
  inactivityTimeoutMs?: number;
  onInactive(toolUseId: string, timeoutMs: number): void;
  schedule?: ToolLivenessSchedule;
}): ToolLivenessLease {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
  if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new Error("Tool inactivity timeout must be a positive finite number");
  }

  const schedule = options.schedule ?? scheduleTimeout;
  let activeToolUseId: string | undefined;
  let activeTimeoutMs = inactivityTimeoutMs;
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
      const inactiveTimeoutMs = activeTimeoutMs;
      activeToolUseId = undefined;
      cancelExpiry = undefined;
      options.onInactive(inactiveToolUseId, inactiveTimeoutMs);
    }, activeTimeoutMs);
  };

  return {
    start(toolUseId, timeoutMs) {
      activeToolUseId = toolUseId;
      activeTimeoutMs =
        timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : inactivityTimeoutMs;
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
