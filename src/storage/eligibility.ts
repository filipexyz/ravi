/**
 * Storage eligibility — fail-closed classification of filesystem entries.
 *
 * The default outcome of any uncertainty is "preserved". A candidate is only
 * produced when every gate passes: closed-allowlist match, `lstat` (never
 * follow symlinks), containment inside the allowlist root, not protected, and
 * age above the tier threshold.
 *
 * Slice 1 implements `tmp-ravi` end-to-end. The Codex/Omni/task areas are
 * scanned and reported but deliberately preserved: the positive "inactive /
 * unreferenced" proof and the canonical Task/Git lifecycle removal land in the
 * next slice. Until then they are limitations, never silent deletions.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { tmpNameMatchesAllowlist, type StoragePolicy } from "./policy.js";

export type StorageArea = "tmp-ravi" | "codex-inactive" | "omni-orphan" | "tasks-terminal";
export type StorageDecision = "candidate" | "preserved";

export interface StorageEntry {
  area: StorageArea;
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

const SIZE_CAP_BYTES = 8 * 1024 * 1024 * 1024;
const SIZE_CAP_ENTRIES = 200_000;

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

function preserved(area: StorageArea, path: string, bytes: number, reason: string): StorageEntry {
  return { area, path, bytes, decision: "preserved", reason };
}

function candidate(area: StorageArea, path: string, bytes: number, reason: string): StorageEntry {
  return { area, path, bytes, decision: "candidate", reason };
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
        entries.push(preserved("tmp-ravi", full, bytes, "symlink not followed"));
        continue;
      }
      if (isProtected(full, policy)) {
        entries.push(preserved("tmp-ravi", full, bytes, "protected path"));
        continue;
      }
      if (!isContainedIn(full, root)) {
        entries.push(preserved("tmp-ravi", full, bytes, "real path escapes the allowlist root"));
        continue;
      }
      const age = now - st.mtimeMs;
      if (age < policy.tmpMaxAgeMs) {
        entries.push(preserved("tmp-ravi", full, bytes, `younger than the ${policy.tmpMaxAgeMs}ms threshold`));
        continue;
      }
      entries.push(candidate("tmp-ravi", full, bytes, "tmp allowlist match and age above threshold"));
    }
  }
  return { area: "tmp-ravi", entries, limitations };
}

function codexProcessRunning(): boolean {
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

export function scanCodexArea(policy: StoragePolicy, now: number): AreaScan {
  const limitations: string[] = [];
  const entries: StorageEntry[] = [];
  if (!policy.codexSessionsDir) return { area: "codex-inactive", entries, limitations };
  if (!existsSync(policy.codexSessionsDir)) {
    return { area: "codex-inactive", entries, limitations: ["codex-inactive: sessions directory not present"] };
  }
  const live = codexProcessRunning();
  limitations.push(
    "codex-inactive: positive inactive proof (active Ravi session/agent reference) is not wired in slice 1; all artifacts are preserved",
  );
  const files: string[] = [];
  walkFiles(policy.codexSessionsDir, files);
  for (const file of files) {
    if (!/rollout-.*\.jsonl$/.test(file)) continue;
    let st;
    try {
      st = lstatSync(file);
    } catch {
      continue;
    }
    const bytes = st.isFile() ? st.size : 0;
    if (live) {
      entries.push(preserved("codex-inactive", file, bytes, "a live codex process is running"));
      continue;
    }
    const age = now - st.mtimeMs;
    if (age < policy.codexMaxAgeMs) {
      entries.push(preserved("codex-inactive", file, bytes, `younger than the ${policy.codexMaxAgeMs}ms threshold`));
      continue;
    }
    entries.push(preserved("codex-inactive", file, bytes, "inactive proof unavailable (slice 1 fail-closed)"));
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

export function scanStorageAreas(policy: StoragePolicy, now: number): AreaScan[] {
  return policy.tier === "routine"
    ? [scanTmpArea(policy, now), scanCodexArea(policy, now)]
    : [scanOmniArea(policy), scanTasksArea(policy)];
}
