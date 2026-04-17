export const DEFAULT_TASK_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
export const TASK_CHECKPOINT_SWEEP_INTERVAL_MS = 30 * 1000;

export function resolveTaskCheckpointIntervalMs(intervalMs?: number | null): number {
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0) {
    return Math.max(1000, Math.round(intervalMs));
  }
  return DEFAULT_TASK_CHECKPOINT_INTERVAL_MS;
}

export function computeTaskCheckpointDueAt(fromTs: number, intervalMs?: number | null): number {
  return fromTs + resolveTaskCheckpointIntervalMs(intervalMs);
}

export function calculateTaskCheckpointMiss(
  dueAt: number,
  intervalMs: number,
  now = Date.now(),
): { missedCount: number; nextDueAt: number } {
  const effectiveIntervalMs = resolveTaskCheckpointIntervalMs(intervalMs);
  if (dueAt > now) {
    return {
      missedCount: 0,
      nextDueAt: dueAt,
    };
  }

  const missedCount = Math.floor((now - dueAt) / effectiveIntervalMs) + 1;
  return {
    missedCount,
    nextDueAt: dueAt + missedCount * effectiveIntervalMs,
  };
}
