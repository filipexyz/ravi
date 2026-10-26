/**
 * Storage eligibility — fail-closed classification of filesystem entries.
 *
 * The default outcome of any uncertainty is "preserved". A candidate is only
 * produced when every gate passes: closed-allowlist match, `lstat` (never
 * follow symlinks), containment inside the allowlist root, not protected, and
 * the class threshold.
 *
 * Each class lives in its own module (`tmp`, `codex`, backups, attachments,
 * Claude JSONL, status@broadcast video, Omni holds, task worktrees); this file
 * is the single place that composes them per tier and for `report`.
 */

import { existsSync, lstatSync, openSync, closeSync, readSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { isContainedIn, isProtectedPath, measureBytes } from "./fsutil.js";
import { classesForTier, tmpNameMatchesAllowlist, type StoragePolicy } from "./policy.js";
import { isTerminalTask, taskTerminalStamp, type TaskProbe } from "./task-probe.js";
import { scanBackupsArea } from "./backups.js";
import { scanAttachmentsArea } from "./attachments.js";
import { scanClaudeJsonlArea } from "./claude-jsonl.js";
import { scanOmniBroadcastArea } from "./omni-broadcast.js";
import type { AreaScan, CodexProbe, OmniBroadcastProbe, StorageArea, StorageEntry } from "./types.js";

export type {
  AreaScan,
  CodexProbe,
  CodexSessionLiveness,
  OmniBroadcastProbe,
  StorageArea,
  StorageEntry,
} from "./types.js";
export { isContainedIn, measureBytes } from "./fsutil.js";

const DEFAULT_CODEX_PROBE: CodexProbe = {
  processRunning: () => codexProcessRunning(),
  sessionLiveness: () => "unknown",
};

const CODEX_ROLLOUT = /^rollout-.*\.jsonl$/;

function preserved(
  area: StorageArea,
  root: string,
  path: string,
  bytes: number,
  reason: string,
  doubt = false,
): StorageEntry {
  return { area, root, path, bytes, decision: "preserved", reason, ...(doubt ? { doubt: true } : {}) };
}

function candidate(area: StorageArea, root: string, path: string, bytes: number, reason: string): StorageEntry {
  return { area, root, path, bytes, decision: "candidate", reason };
}

/** A preserved outcome caused by an unresolved signal, not by a policy rule. */
function isAmbiguousReason(reason: string): boolean {
  return /failed|not found|could not|unreadable|unavailable|unknown|not registered/.test(reason);
}

export function scanTmpArea(policy: StoragePolicy, now: number): AreaScan {
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  for (const root of policy.tmpRoots) {
    if (!existsSync(root)) {
      limitations.push(`tmp-ravi: root not present (${root})`);
      continue;
    }
    let children: Dirent[];
    try {
      children = readdirSync(root, { withFileTypes: true });
    } catch {
      limitations.push(`tmp-ravi: root not readable (${root})`);
      continue;
    }
    for (const child of children) {
      const name = String(child.name);
      if (!tmpNameMatchesAllowlist(name, policy.tmpNameAllowlist)) continue;
      const full = join(root, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        limitations.push(`tmp-ravi: lstat failed (${full})`);
        continue;
      }
      const bytes = measureBytes(full);
      if (st.isSymbolicLink()) {
        entries.push(preserved("tmp-ravi", root, full, bytes, "symlink not followed"));
        continue;
      }
      if (isProtectedPath(full, policy.protectedPaths)) {
        entries.push(preserved("tmp-ravi", root, full, bytes, "protected path"));
        continue;
      }
      if (!isContainedIn(full, root)) {
        entries.push(preserved("tmp-ravi", root, full, bytes, "real path escapes the allowlist root", true));
        continue;
      }
      const age = now - st.mtimeMs;
      if (age < policy.tmpMaxAgeMs) {
        entries.push(preserved("tmp-ravi", root, full, bytes, `younger than the ${policy.tmpMaxAgeMs}ms threshold`));
        continue;
      }
      entries.push(candidate("tmp-ravi", root, full, bytes, "tmp allowlist match and age above threshold"));
    }
  }
  return { area: "tmp-ravi", entries, limitations };
}

export function codexProcessRunning(): boolean {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return true; // cannot prove absence -> fail closed
  }
  for (const pid of pids) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (/(^|\/|\s)codex(\s|$)/.test(cmdline)) return true;
    } catch {
      /* process vanished */
    }
  }
  return false;
}

const MAX_META_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The only originator value Codex records for a Ravi-launched session.
 * `codex_exec` (a direct CLI run) and anything else is NOT proven to be Ravi's,
 * so it is preserved instead of deleted.
 */
export const RAVI_CODEX_ORIGINATOR = "ravi";

export interface CodexRolloutMeta {
  sessionId: string;
  /** `payload.originator` of the first record; null when absent or unreadable. */
  originator: string | null;
}

/** Read the first line of a Codex rollout, bounded and never following links. */
function readFirstLine(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let offset = 0;
    let newlineAt = -1;
    while (offset < MAX_META_BYTES) {
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        newlineAt = offset + newline;
        break;
      }
      chunks.push(Buffer.from(chunk));
      offset += read;
    }
    if (newlineAt < 0) return null;
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Read the Ravi ownership mark and session id from a Codex rollout header.
 * Returns null when the header is missing, unreadable or not `session_meta`.
 */
export function parseCodexRolloutMeta(file: string): CodexRolloutMeta | null {
  const firstLine = readFirstLine(file);
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { session_id?: string; id?: string; originator?: unknown };
    };
    if (parsed.type !== "session_meta") return null;
    const sessionId = parsed.payload?.session_id ?? parsed.payload?.id;
    if (!sessionId) return null;
    const originator = typeof parsed.payload?.originator === "string" ? parsed.payload.originator : null;
    return { sessionId, originator };
  } catch {
    return null;
  }
}

/** Read the first line of a Codex rollout and return its session id, if any. */
export function parseCodexSessionId(file: string): string | null {
  return parseCodexRolloutMeta(file)?.sessionId ?? null;
}

function walkFiles(root: string, out: string[]): void {
  let children: Dirent[];
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const full = join(root, String(child.name));
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
}

export function scanCodexArea(policy: StoragePolicy, now: number, probe: CodexProbe = DEFAULT_CODEX_PROBE): AreaScan {
  const limitations: string[] = [];
  const entries: StorageEntry[] = [];
  const root = policy.codexSessionsDir;
  if (!root) return { area: "codex-inactive", entries, limitations };
  if (!existsSync(root)) {
    return { area: "codex-inactive", entries, limitations: ["codex-inactive: sessions directory not present"] };
  }

  const liveProcess = probe.processRunning();
  let unprovenLiveness = 0;
  const files: string[] = [];
  walkFiles(root, files);
  for (const file of files) {
    if (!CODEX_ROLLOUT.test(file.split(sep).pop() ?? "")) continue;
    let st;
    try {
      st = lstatSync(file);
    } catch {
      continue;
    }
    const bytes = st.isFile() ? st.size : 0;
    if (liveProcess) {
      entries.push(preserved("codex-inactive", root, file, bytes, "a live codex process is running"));
      continue;
    }
    const age = now - st.mtimeMs;
    if (age < policy.codexMaxAgeMs) {
      entries.push(
        preserved("codex-inactive", root, file, bytes, `younger than the ${policy.codexMaxAgeMs}ms threshold`),
      );
      continue;
    }
    const sessionId = parseCodexSessionId(file);
    if (!sessionId) {
      entries.push(preserved("codex-inactive", root, file, bytes, "session metadata unreadable (fail-closed)", true));
      continue;
    }
    const ownership = parseCodexRolloutMeta(file);
    if (ownership?.originator !== RAVI_CODEX_ORIGINATOR) {
      entries.push(
        preserved(
          "codex-inactive",
          root,
          file,
          bytes,
          `rollout is not proven to belong to Ravi (originator=${ownership?.originator ?? "missing"})`,
          true,
        ),
      );
      continue;
    }
    const liveness = probe.sessionLiveness(sessionId);
    if (liveness === "live") {
      entries.push(preserved("codex-inactive", root, file, bytes, "referenced by a live Ravi session"));
      continue;
    }
    if (liveness === "unknown") {
      unprovenLiveness += 1;
      entries.push(
        preserved("codex-inactive", root, file, bytes, "session liveness could not be proven (fail-closed)", true),
      );
      continue;
    }
    entries.push(candidate("codex-inactive", root, file, bytes, "no live process/reference, aged, readable metadata"));
  }
  if (unprovenLiveness > 0) {
    limitations.push(
      `codex-inactive: ${unprovenLiveness} artifact(s) preserved because Ravi session liveness was unavailable`,
    );
  }
  return { area: "codex-inactive", entries, limitations };
}

export function scanOmniArea(policy: StoragePolicy): AreaScan {
  const limitations: string[] = [];
  if (!policy.omniMediaDir || !existsSync(policy.omniMediaDir)) {
    limitations.push("omni-orphan: Omni data root not present or not configured");
  } else {
    limitations.push(
      "omni-orphan: no canonical hold/reference surface resolved; all Omni objects preserved (fail-closed). status@broadcast must be handled by omni-broadcast-mp4, which has the 7-day class and the externalId match",
    );
  }
  return { area: "omni-orphan", entries: [], limitations };
}

export function scanTasksArea(policy: StoragePolicy, now: number, probe?: TaskProbe): AreaScan {
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  if (!probe) {
    limitations.push("tasks-terminal: no task source available; all task worktrees preserved (fail-closed)");
    return { area: "tasks-terminal", entries, limitations };
  }
  const { records, error } = probe.listWorktreeTasks();
  if (error) limitations.push(`tasks-terminal: ${error}; all task worktrees preserved`);
  for (const record of records) {
    const root = record.worktreePath;
    if (!isTerminalTask(record)) {
      entries.push(preserved("tasks-terminal", root, root, 0, `task is not terminal (${record.status})`));
      continue;
    }
    const age = now - taskTerminalStamp(record);
    if (age < policy.taskMaxAgeMs) {
      entries.push(
        preserved("tasks-terminal", root, root, 0, `task is younger than the ${policy.taskMaxAgeMs}ms threshold`),
      );
      continue;
    }
    const assessment = probe.assess(record);
    // Measure terminal, aged worktrees whether they end up eligible or
    // preserved, so `report` does not understate the preserved bytes. Only
    // this bounded set is measured; active worktrees are out of scope and stay
    // at 0 bytes without being called "in doubt".
    const bytes = measureBytes(root);
    entries.push(
      assessment.decision === "candidate"
        ? candidate("tasks-terminal", root, root, bytes, assessment.reason)
        : preserved("tasks-terminal", root, root, bytes, assessment.reason, isAmbiguousReason(assessment.reason)),
    );
  }
  return { area: "tasks-terminal", entries, limitations };
}

export interface ScanAllOptions {
  now: number;
  codexProbe?: CodexProbe;
  taskProbe?: TaskProbe;
  omniBroadcastProbe: OmniBroadcastProbe;
}

/** Run every class scan once. Used by `report` (all tiers) and `cleanup`. */
export function scanAllAreas(policy: StoragePolicy, options: ScanAllOptions): AreaScan[] {
  const { now, codexProbe, taskProbe, omniBroadcastProbe } = options;
  return [
    scanTmpArea(policy, now),
    scanCodexArea(policy, now, codexProbe),
    scanBackupsArea(policy, now),
    scanAttachmentsArea(policy, now),
    scanClaudeJsonlArea(policy, now),
    scanOmniBroadcastArea(policy, now, omniBroadcastProbe),
    scanOmniArea(policy),
    scanTasksArea(policy, now, taskProbe),
  ];
}

/** Scans for the classes owned by the policy tier. */
export function scanStorageAreas(policy: StoragePolicy, options: ScanAllOptions): AreaScan[] {
  const wanted = new Set(classesForTier(policy.tier));
  return scanAllAreas(policy, options).filter((scan) => wanted.has(scan.area));
}
