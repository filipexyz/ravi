import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../approval/timeouts.js";

export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tools whose PreToolUse hook waits for a person (plan, spec or question
 * approval). They emit no progress while waiting, so the generic window would
 * abort the turn before the hook's own timeout could answer, and the model
 * would ask again in a loop.
 */
export const APPROVAL_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ExitPlanMode",
  "AskUserQuestion",
  "mcp__spec__exit_spec_mode",
]);

/**
 * Delivering the approval message and waiting for the answer each get up to
 * DEFAULT_APPROVAL_TIMEOUT_MS, plus a margin so the hook's timeout (a deny the
 * model can read) always wins over the inactivity recovery.
 */
export const APPROVAL_GATED_TOOL_TIMEOUT_MS = 2 * DEFAULT_APPROVAL_TIMEOUT_MS + 60 * 1000;

export function isApprovalGatedTool(toolName: string | undefined): boolean {
  return toolName !== undefined && APPROVAL_GATED_TOOL_NAMES.has(toolName);
}

/** Inactivity window for a tool that just started. */
export function resolveToolInactivityTimeoutMs(toolName: string | undefined, input: unknown): number {
  const declared = resolveDeclaredToolTimeoutMs(input);
  return isApprovalGatedTool(toolName) ? Math.max(declared, APPROVAL_GATED_TOOL_TIMEOUT_MS) : declared;
}

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

export interface ApprovalWaitLeaseTracker {
  /** An authorization started waiting on a person. */
  begin(): void;
  /** That authorization returned. */
  end(): void;
  /** Window for a tool that starts while an approval is still pending. */
  timeoutForStartingTool(timeoutMs: number): number;
}

/**
 * A permission approval (the card for a Bash executable, a tool, a capability)
 * waits on a person and emits nothing. While one is pending the running tool's
 * window must cover the approval's own timeout, or the inactivity recovery
 * fires first and the turn runs on while the approval is still open. When the
 * last wait ends the tool gets its own window back.
 */
export function createApprovalWaitLeaseTracker(options: {
  lease: Pick<ToolLivenessLease, "start">;
  currentTool(): { id: string; name?: string; input?: unknown } | undefined;
}): ApprovalWaitLeaseTracker {
  let pending = 0;
  return {
    begin() {
      pending++;
      const tool = options.currentTool();
      if (tool) options.lease.start(tool.id, APPROVAL_GATED_TOOL_TIMEOUT_MS);
    },
    end() {
      if (pending === 0) return;
      pending--;
      if (pending > 0) return;
      const tool = options.currentTool();
      if (tool) options.lease.start(tool.id, resolveToolInactivityTimeoutMs(tool.name, tool.input));
    },
    timeoutForStartingTool(timeoutMs) {
      return pending > 0 ? Math.max(timeoutMs, APPROVAL_GATED_TOOL_TIMEOUT_MS) : timeoutMs;
    },
  };
}
