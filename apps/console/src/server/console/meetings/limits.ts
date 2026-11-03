// Caps and price estimates for cloud meeting bots. The entitlement row of
// console.meetings can raise or lower each cap per organization.

export const MEETINGS_FEATURE_KEY = "console.meetings";

/** Recall.ai pay-as-you-go: recording plus its own transcription, billed per second. */
export const RECORDING_USD_PER_HOUR = 0.5;
export const TRANSCRIPTION_USD_PER_HOUR = 0.15;
export const MEETING_USD_PER_SECOND = (RECORDING_USD_PER_HOUR + TRANSCRIPTION_USD_PER_HOUR) / 3600;
export const MEETINGS_PRICE_VERSION = "meetings-2026-01";

export type MeetingLimits = {
  /** Bots that may be in calls (or on their way) at once in one organization. */
  maxConcurrentBots: number;
  /** A bot leaves after recording this long. */
  maxRecordingSeconds: number;
  /** Estimated vendor spend per calendar month (UTC) across the organization. */
  monthlyBudgetUsd: number;
};

export const MEETING_DEFAULT_LIMITS: MeetingLimits = {
  maxConcurrentBots: 3,
  maxRecordingSeconds: 3 * 3600,
  monthlyBudgetUsd: 30,
};

const BOUNDS: Record<keyof MeetingLimits, [number, number]> = {
  maxConcurrentBots: [1, 50],
  maxRecordingSeconds: [5 * 60, 8 * 3600],
  monthlyBudgetUsd: [0, 10_000],
};

/** Reads `{ "enabled": true, "limits": { ... } }` from the console.meetings entitlement, as Page Chat does. */
export function parseMeetingLimits(valueJson: unknown): MeetingLimits {
  const value = valueJson && typeof valueJson === "object" ? (valueJson as Record<string, unknown>) : {};
  const source = value.limits && typeof value.limits === "object" ? (value.limits as Record<string, unknown>) : {};
  const limits = { ...MEETING_DEFAULT_LIMITS };
  for (const key of Object.keys(BOUNDS) as Array<keyof MeetingLimits>) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const [min, max] = BOUNDS[key];
    limits[key] = Math.min(max, Math.max(min, key === "monthlyBudgetUsd" ? value : Math.floor(value)));
  }
  return limits;
}

export function estimateMeetingCostUsd(recordingSeconds: number) {
  return Math.round(Math.max(0, recordingSeconds) * MEETING_USD_PER_SECOND * 10_000) / 10_000;
}

export type MeetingAllowance =
  | { allowed: true; limits: MeetingLimits; maxRecordingSeconds: number }
  | { allowed: false; reason: "feature_unavailable" | "concurrency" | "budget"; limits: MeetingLimits };

/**
 * A bot that has not finished counts at its full cap, so parallel requests
 * cannot each take the whole remaining budget. The new bot gets the cap, cut
 * down to what the budget still pays for.
 */
export function evaluateMeetingAllowance(input: {
  limits: MeetingLimits;
  openBots: number;
  openReservedSeconds: number;
  monthSpentUsd: number;
}): MeetingAllowance {
  const { limits } = input;
  if (input.openBots >= limits.maxConcurrentBots) return { allowed: false, reason: "concurrency", limits };
  const remainingUsd =
    limits.monthlyBudgetUsd - input.monthSpentUsd - estimateMeetingCostUsd(input.openReservedSeconds);
  const affordableSeconds = Math.floor(remainingUsd / MEETING_USD_PER_SECOND);
  const maxRecordingSeconds = Math.min(limits.maxRecordingSeconds, affordableSeconds);
  if (maxRecordingSeconds < BOUNDS.maxRecordingSeconds[0]) return { allowed: false, reason: "budget", limits };
  return { allowed: true, limits, maxRecordingSeconds };
}
