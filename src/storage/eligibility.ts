/**
 * Storage eligibility — fail-closed classification of filesystem entries.
 *
 * The default outcome of any uncertainty is "preserved". A candidate is only
 * produced when every gate passes: closed-allowlist match, `lstat` (never
 * follow symlinks), containment inside the allowlist root, not protected, and
 * age above the tier threshold.
 *
 * `tmp-ravi` is implemented end-to-end. `codex-inactive` requires a positive
 * inactivity proof: no live Codex process, age above the threshold, readable
 * `session_meta`, and a Ravi-session liveness answer of "not-live". Any
 * "unknown" liveness answer preserves the artifact. `omni-orphan` and
 * `tasks-terminal` remain preserved until their canonical hold/lifecycle
 * surfaces are wired (next slice); their limitations are always recorded.
 */

import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpNameMatchesAllowlist, type StoragePolicy } from "./policy.js";

export type StorageArea = "tmp-ravi" | "codex-inactive" | "omni-orphan" | "tasks-terminal";
export type StorageDecision = "candidate" | "preserved";

export interface StorageEntry {
  area: StorageArea;
  /** The allowlist root this entry was found under (containment boundary). */
  root: string;
  path: string;
  bytes: number;
  decision: StorageDecision;
  reason: string;
}

export interface AreaScan {
  area: StorageArea;
  entries: StorageEntry[];
  limitations: string[];
}

/** Tri-state liveness: unknown is never treated as inactive. */
export type CodexSessionLiveness = "live" | "not-live" | "unknown";

export interface CodexProbe {
  processRunning(): boolean;
  sessionLiveness(sessionId: string): CodexSessionLiveness;
}

const DEFAULT_CODEX_PROBE: CodexProbe = {
  processRunning: () => codexProcessRunning(),
  sessionLiveness: () => "unknown",
};

const SIZE_CAP_BYTES = 8 * 1024 * 1024 * 1024;
const SIZE_CAP_ENTRIES = 200_000;
const CODEX_ROLLOUT = /^rollout-.*\.jsonl$/;

/** Bounded recursive size; never follows a symlink. */
export function measureBytes(target: string): number {
  let total = 0;
  let entries = 0;
  const walk = (p: string): void => {
    if (total >= SIZE_CAP_BYTES || entries >= SIZE_CAP_ENTRIES) return;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    entries += 1;
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let children: string[] = [];
      try {
        children = readdirSync(p);
      } catch {
        return;
      }
      for (const child of children) walk(join(p, child));
      return;
    }
    if (st.isFile()) total += st.size;
  };
  walk(target);
  return Math.min(total, SIZE_CAP_BYTES);
}

/** True when `child`'s resolved real path is inside `root` (no traversal). */
export function isContainedIn(child: string, root: string): boolean {
  let realChild: string;
  let realRoot: string;
  try {
    realChild = realpathSync(child);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realChild === realRoot || realChild.startsWith(rootWithSep);
}

function isProtected(target: string, policy: StoragePolicy): boolean {
  return policy.protectedPaths.some((root) => {
    const withSep = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(withSep);
  });
}

function preserved(area: StorageArea, root: string, path: string, bytes: number, reason: string): StorageEntry {
  return { area, root, path, bytes, decision: "preserved", reason };
}

function candidate(area: StorageArea, root: string, path: string, bytes: number, reason: string): StorageEntry {
  return { area, root, path, bytes, decision: "candidate", reason };
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
      if (isProtected(full, policy)) {
        entries.push(preserved("tmp-ravi", root, full, bytes, "protected path"));
        continue;
      }
      if (!isContainedIn(full, root)) {
        entries.push(preserved("tmp-ravi", root, full, bytes, "real path escapes the allowlist root"));
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

/** Read the first line of a Codex rollout and return its session id, if any. */
export function parseCodexSessionId(file: string): string | null {
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
    const firstLine = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { session_id?: string; id?: string };
    };
    if (parsed.type !== "session_meta") return null;
    return parsed.payload?.session_id ?? parsed.payload?.id ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
      entries.push(preserved("codex-inactive", root, file, bytes, "session metadata unreadable (fail-closed)"));
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
        preserved("codex-inactive", root, file, bytes, "session liveness could not be proven (fail-closed)"),
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
  if (!policy.omniDataDir || !existsSync(policy.omniDataDir)) {
    limitations.push("omni-orphan: Omni data root not present or not configured");
  } else {
    limitations.push(
      "omni-orphan: no canonical hold/reference surface resolved; all Omni objects preserved (fail-closed)",
    );
  }
  return { area: "omni-orphan", entries: [], limitations };
}

export function scanTasksArea(_policy: StoragePolicy): AreaScan {
  return {
    area: "tasks-terminal",
    entries: [],
    limitations: [
      "tasks-terminal: removal is delegated to the canonical Task/Git lifecycle and is not wired in slice 1; all task worktrees preserved",
    ],
  };
}

export function scanStorageAreas(policy: StoragePolicy, now: number, probe?: CodexProbe): AreaScan[] {
  return policy.tier === "routine"
    ? [scanTmpArea(policy, now), scanCodexArea(policy, now, probe)]
    : [scanOmniArea(policy), scanTasksArea(policy)];
}
