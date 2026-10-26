/**
 * Storage policy — the single, versioned, source-controlled source of truth for
 * every `ravi storage` operation.
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

/**
 * v2 adds the four host classes required by the storage-v2 brief:
 * superseded backups, aged instance attachments, aged Claude JSONL transcripts
 * and aged status@broadcast Omni videos.
 */
export const STORAGE_POLICY_VERSION = "2";

export const STORAGE_TIERS = ["routine", "weekly"] as const;
export type StorageTier = (typeof STORAGE_TIERS)[number];

export const STORAGE_CLASSES = [
  "tmp-ravi",
  "codex-inactive",
  "backups-superseded",
  "instance-attachments",
  "claude-jsonl",
  "omni-broadcast-mp4",
  "omni-orphan",
  "tasks-terminal",
] as const;
export type StorageClassId = (typeof STORAGE_CLASSES)[number];

/** Which tier owns which class. Exactly one tier per class. */
export const STORAGE_CLASS_TIER: Record<StorageClassId, StorageTier> = {
  "tmp-ravi": "routine",
  "codex-inactive": "routine",
  "backups-superseded": "weekly",
  "instance-attachments": "weekly",
  "claude-jsonl": "weekly",
  "omni-broadcast-mp4": "weekly",
  "omni-orphan": "weekly",
  "tasks-terminal": "weekly",
};

export function classesForTier(tier: StorageTier): StorageClassId[] {
  return STORAGE_CLASSES.filter((id) => STORAGE_CLASS_TIER[id] === tier);
}

/** Routine tmp namespaces must be at least this old before they are considered. */
export const ROUTINE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Codex rollout files must be at least this old before they are considered. */
export const ROUTINE_CODEX_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** Terminal task worktrees must be at least this old before they are considered. */
export const WEEKLY_TASK_MAX_AGE_MS = 20 * 24 * 60 * 60 * 1000;
/** Instance attachments must be at least this old before they are considered. */
export const WEEKLY_ATTACHMENTS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Claude JSONL transcripts must be at least this old before they are considered. */
export const WEEKLY_CLAUDE_JSONL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** status@broadcast videos must be at least this old before they are considered. */
export const WEEKLY_OMNI_BROADCAST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounded receipt retention. */
export const RECEIPT_MAX_COUNT = 50;
export const RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Default window for `ravi storage summary` and `--notify`. */
export const STORAGE_SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The one canonical weekly cron the `schedule` operation manages. */
export const STORAGE_SCHEDULE_NAME = "storage-weekly-cleanup";
export const STORAGE_SCHEDULE_CRON = "0 4 * * 0";
export const STORAGE_SCHEDULE_TIMEZONE = "America/Sao_Paulo";
export const STORAGE_SCHEDULE_NOTIFY_SESSION = "ravi-main-2-0-cloudopus";
export const STORAGE_SCHEDULE_COMMAND = `ravi storage cleanup --tier weekly --execute --notify ${STORAGE_SCHEDULE_NOTIFY_SESSION} --json`;
export const STORAGE_SCHEDULE_TIMEOUT_MS = 10 * 60 * 1000;

/** Root used by every host class, relative to the account home. */
export const INSTANCE_ATTACHMENTS_RELATIVE = join("ravi", "main", "attachments");
export const CLAUDE_PROJECTS_RELATIVE = join(".claude", "projects");
export const OMNI_MEDIA_RELATIVE = join(".omni", "data", "media");
export const OMNI_CONFIG_RELATIVE = join(".omni", "config.json");

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
  classes: STORAGE_CLASSES,
  classTier: STORAGE_CLASS_TIER,
  tmpNameAllowlist: TMP_NAME_ALLOWLIST,
  routineTmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
  routineCodexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
  weeklyTaskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
  weeklyAttachmentsMaxAgeMs: WEEKLY_ATTACHMENTS_MAX_AGE_MS,
  weeklyClaudeJsonlMaxAgeMs: WEEKLY_CLAUDE_JSONL_MAX_AGE_MS,
  weeklyOmniBroadcastMaxAgeMs: WEEKLY_OMNI_BROADCAST_MAX_AGE_MS,
  receiptMaxCount: RECEIPT_MAX_COUNT,
  receiptMaxAgeMs: RECEIPT_MAX_AGE_MS,
  scheduleName: STORAGE_SCHEDULE_NAME,
  scheduleCron: STORAGE_SCHEDULE_CRON,
  scheduleTimezone: STORAGE_SCHEDULE_TIMEZONE,
  scheduleCommand: STORAGE_SCHEDULE_COMMAND,
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
  backupsDir: string | null;
  attachmentsDir: string | null;
  claudeProjectsDir: string | null;
  omniMediaDir: string | null;
  omniConfigPath: string | null;
  tasksDir: string | null;
  receiptDir: string;
  tmpMaxAgeMs: number;
  codexMaxAgeMs: number;
  taskMaxAgeMs: number;
  attachmentsMaxAgeMs: number;
  claudeJsonlMaxAgeMs: number;
  omniBroadcastMaxAgeMs: number;
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

/**
 * Absolute roots that `storage` must never treat as candidates, any tier.
 * A class whose own allowlist root lives inside one of these roots (for
 * example `~/.ravi/backups` inside `~/.ravi`) stays safe because the class scan
 * and the execute-time re-check pin the candidate to the class root itself.
 */
export function resolveProtectedPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const stateDir = getRaviStateDir(env);
  const home = homedir();
  return [stateDir, join(home, ".config", "ravi"), join(home, ".pi"), join(home, ".codex"), join(home, ".omni")];
}

/**
 * Root paths that the host classes are allowed to live under.
 *
 * Every class root MUST be listed here: a class root can sit inside a protected
 * root (`~/.codex/sessions` is inside `~/.codex`, `~/.ravi/tasks` is inside
 * `~/.ravi`), and the execute gate must not promote its own allowlisted
 * candidates to "protected path" after the dry-run counted them as eligible.
 * The class-specific containment check in `canRemove` still pins every
 * candidate to its own root, so this exemption never widens the surface.
 */
export function resolveClassExemptions(policy: StoragePolicy): string[] {
  return [
    ...policy.tmpRoots,
    policy.codexSessionsDir,
    policy.backupsDir,
    policy.attachmentsDir,
    policy.claudeProjectsDir,
    policy.omniMediaDir,
    policy.tasksDir,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function fixtureDir(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/**
 * Compile the policy for a run. `tier` selects the class set that the cleanup
 * operation scans; every threshold is class-specific, so `report` can compile a
 * single `weekly` policy and scan every class.
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
    // In fixture mode only explicitly redirected areas are active. Every host
    // area is disabled so a behavioral run can never read — let alone delete —
    // real state.
    return {
      version: STORAGE_POLICY_VERSION,
      hash: computeStoragePolicyHash(),
      tier,
      fixtureMode: true,
      tmpRoots: splitList(env.RAVI_STORAGE_FIXTURE_TMP_ROOTS),
      tmpNameAllowlist,
      // Fixture mode normally disables protected roots so a behavioral run can
      // never touch real state. A test that needs to prove the execute-time
      // protected-path gate can opt into a fixture-local list of protected
      // roots; they are still fixture paths, never real ones.
      protectedPaths: splitList(env.RAVI_STORAGE_FIXTURE_PROTECTED_ROOTS),
      codexSessionsDir: fixtureDir(env, "RAVI_STORAGE_FIXTURE_CODEX_DIR"),
      backupsDir: fixtureDir(env, "RAVI_STORAGE_FIXTURE_BACKUPS_DIR"),
      attachmentsDir: fixtureDir(env, "RAVI_STORAGE_FIXTURE_ATTACHMENTS_DIR"),
      claudeProjectsDir: fixtureDir(env, "RAVI_STORAGE_FIXTURE_CLAUDE_DIR"),
      omniMediaDir: fixtureDir(env, "RAVI_STORAGE_FIXTURE_OMNI_MEDIA_DIR"),
      omniConfigPath: null,
      tasksDir: null,
      receiptDir: env.RAVI_STORAGE_FIXTURE_RECEIPT_DIR?.trim() || join(stateDir, "storage", "receipts"),
      tmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
      codexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
      taskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
      attachmentsMaxAgeMs: WEEKLY_ATTACHMENTS_MAX_AGE_MS,
      claudeJsonlMaxAgeMs: WEEKLY_CLAUDE_JSONL_MAX_AGE_MS,
      omniBroadcastMaxAgeMs: WEEKLY_OMNI_BROADCAST_MAX_AGE_MS,
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
    backupsDir: join(stateDir, "backups"),
    attachmentsDir: join(home, INSTANCE_ATTACHMENTS_RELATIVE),
    claudeProjectsDir: join(home, CLAUDE_PROJECTS_RELATIVE),
    omniMediaDir: join(home, OMNI_MEDIA_RELATIVE),
    omniConfigPath: join(home, OMNI_CONFIG_RELATIVE),
    tasksDir: join(stateDir, "tasks"),
    receiptDir: join(stateDir, "storage", "receipts"),
    tmpMaxAgeMs: ROUTINE_TMP_MAX_AGE_MS,
    codexMaxAgeMs: ROUTINE_CODEX_MAX_AGE_MS,
    taskMaxAgeMs: WEEKLY_TASK_MAX_AGE_MS,
    attachmentsMaxAgeMs: WEEKLY_ATTACHMENTS_MAX_AGE_MS,
    claudeJsonlMaxAgeMs: WEEKLY_CLAUDE_JSONL_MAX_AGE_MS,
    omniBroadcastMaxAgeMs: WEEKLY_OMNI_BROADCAST_MAX_AGE_MS,
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
