/**
 * Storage policy — the single, versioned, source-controlled source of truth for
 * the `ravi storage cleanup` operation.
 *
 * The policy is compiled from the constants below. It MUST NOT be read from
 * mutable external configuration: a change to eligibility is a source change
 * with a version bump, not a runtime tweak.
 *
 * Fixture seams (`RAVI_STORAGE_FIXTURE_*`) exist only so tests and the
 * out-of-candidate checker can exercise the destructive path against a
 * throwaway tree. They are ignored unless `RAVI_STORAGE_FIXTURE_MODE=1`, so a
 * stray environment variable can never redirect production.
 */

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

export const STORAGE_POLICY_VERSION = "1";

export const STORAGE_TIERS = ["routine", "weekly"] as const;
export type StorageTier = (typeof STORAGE_TIERS)[number];

/** Routine tmp namespaces must be at least this old before they are considered. */
export const ROUTINE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Codex rollout files must be at least this old before they are considered. */
export const ROUTINE_CODEX_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** Terminal task worktrees must be at least this old before they are considered. */
export const WEEKLY_TASK_MAX_AGE_MS = 20 * 24 * 60 * 60 * 1000;

/** Bounded receipt retention. */
export const RECEIPT_MAX_COUNT = 50;
export const RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Closed allowlist of Ravi temp namespace prefixes. A direct child of a temp
 * root whose name does not match exactly one of these patterns is never a
 * candidate (not merely preserved — simply outside the policy).
 */
export const TMP_NAME_ALLOWLIST: readonly string[] = [
  "ravi-*",
  "observation-plane*",
  "skills-cli*",
  "skill-gates*",
  "tags-cli*",
  "tag-targets*",
  "observer-profiles*",
  "cp13-*",
];

const POLICY_CONSTANTS = {
  version: STORAGE_POLICY_VERSION,
  tiers: STORAGE_TIERS,
  tmpNameAllowlist: TMP_NAME_ALLOWLIST,
  routineTmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
  routineCodexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
  weeklyTaskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
  receiptMaxCount: RECEIPT_MAX_COUNT,
  receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
} as const;

/**
 * Stable content hash of the host-independent policy constants. Both the
 * version and this hash are recorded on every run and in every receipt so a
 * receipt can be detected as drift instead of silently reused.
 */
export function computeStoragePolicyHash(): string {
  return createHash("sha256").update(JSON.stringify(POLICY_CONSTANTS)).digest("hex");
}

export interface StoragePolicy {
  version: string;
  hash: string;
  tier: StorageTier;
  fixtureMode: boolean;
  tmpRoots: string[];
  tmpNameAllowlist: string[];
  protectedPaths: string[];
  /** Null when the area is disabled (fixture mode or a missing surface). */
  codexSessionsDir: string | null;
  tasksDir: string | null;
  omniDataDir: string | null;
  receiptDir: string;
  tmpMaxAgeMs: number;
  codexMaxAgeMs: number;
  taskMaxAgeMs: number;
  receiptMaxCount: number;
  receiptMaxAgeMs: number;
}

export function isStorageFixtureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAVI_STORAGE_FIXTURE_MODE === "1";
}

function splitList(value: string | undefined): string[] {
  return value
    ? value
        .split(":")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];
}

/** Absolute roots that `storage` must never treat as candidates, any tier. */
export function resolveProtectedPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const stateDir = getRaviStateDir(env);
  const home = homedir();
  return [stateDir, join(home, ".config", "ravi"), join(home, ".pi"), join(home, ".codex"), join(home, ".omni")];
}

/**
 * Compile the policy for a run. `tier` selects the age thresholds that apply.
 */
export function resolveStoragePolicy(tier: StorageTier, env: NodeJS.ProcessEnv = process.env): StoragePolicy {
  const fixtureMode = isStorageFixtureMode(env);
  const stateDir = getRaviStateDir(env);
  const tmpNameAllowlist = fixtureMode
    ? (() => {
        const override = splitList(env.RAVI_STORAGE_FIXTURE_ALLOWLIST);
        return override.length > 0 ? override : [...TMP_NAME_ALLOWLIST];
      })()
    : [...TMP_NAME_ALLOWLIST];

  if (fixtureMode) {
    // In fixture mode only the explicitly redirected tmp area is active. Every
    // host area (Codex/Omni/tasks) is disabled so a behavioral run can never
    // read — let alone delete — real state.
    return {
      version: STORAGE_POLICY_VERSION,
      hash: computeStoragePolicyHash(),
      tier,
      fixtureMode: true,
      tmpRoots: splitList(env.RAVI_STORAGE_FIXTURE_TMP_ROOTS),
      tmpNameAllowlist,
      protectedPaths: [],
      codexSessionsDir: env.RAVI_STORAGE_FIXTURE_CODEX_DIR?.trim() || null,
      tasksDir: null,
      omniDataDir: null,
      receiptDir: env.RAVI_STORAGE_FIXTURE_RECEIPT_DIR?.trim() || join(stateDir, "storage", "receipts"),
      tmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
      codexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
      taskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
      receiptMaxCount: RECEIPT_MAX_COUNT,
      receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
    };
  }

  const home = homedir();
  return {
    version: STORAGE_POLICY_VERSION,
    hash: computeStoragePolicyHash(),
    tier,
    fixtureMode: false,
    tmpRoots: [tmpdir()],
    tmpNameAllowlist,
    protectedPaths: resolveProtectedPaths(env),
    codexSessionsDir: join(home, ".codex", "sessions"),
    tasksDir: join(stateDir, "tasks"),
    omniDataDir: join(home, ".omni", "data"),
    receiptDir: join(stateDir, "storage", "receipts"),
    tmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
    codexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
    taskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
    receiptMaxCount: RECEIPT_MAX_COUNT,
    receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
  };
}

/**
 * Convert a closed allowlist pattern (only `*` is special) into an anchored
 * regular expression. Used for both candidate selection and the execute-time
 * re-check.
 */
export function tmpNameMatchesAllowlist(name: string, allowlist: readonly string[]): boolean {
  return allowlist.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(name);
  });
}
