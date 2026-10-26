/**
 * `backups-superseded` — `~/.ravi/backups` keeps only the newest artifact of
 * each type.
 *
 * A "type" is the entry name with extension and one trailing timestamp
 * removed. Names without a recognizable timestamp are preserved as in-doubt:
 * the policy never guesses what a backup belongs to.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { measureBytes } from "./fsutil.js";
import type { StoragePolicy } from "./policy.js";
import type { AreaScan, StorageEntry } from "./types.js";

const TIMESTAMP_SUFFIXES: readonly RegExp[] = [
  /[-_](\d{8}T\d{6}Z)$/,
  /[-_](\d{8}T\d{6})$/, // legacy compact timestamp
  /[-_](\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}Z?)$/,
  /[-_](\d{4}-\d{2}-\d{2})$/,
];

/**
 * Stable type key for a backup entry. Returns null when the name carries no
 * recognizable timestamp, which preserves the entry instead of grouping it with
 * unrelated artifacts.
 */
export function backupTypeKey(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const extension = hasExtension ? name.slice(dot) : "";
  const stem = hasExtension ? name.slice(0, dot) : name;
  for (const pattern of TIMESTAMP_SUFFIXES) {
    if (pattern.test(stem)) return `${stem.replace(pattern, "")}${extension}`;
  }
  return null;
}

interface BackupCandidate {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  isDirectory: boolean;
  typeKey: string | null;
}

export function scanBackupsArea(policy: StoragePolicy, now: number): AreaScan {
  void now;
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  const root = policy.backupsDir;
  if (!root) {
    return { area: "backups-superseded", entries, limitations: ["backups-superseded: class disabled"] };
  }
  if (!existsSync(root)) {
    return { area: "backups-superseded", entries, limitations: [`backups-superseded: root not present (${root})`] };
  }

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { area: "backups-superseded", entries, limitations: [`backups-superseded: root not readable (${root})`] };
  }

  const groups = new Map<string, BackupCandidate[]>();
  for (const name of names) {
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      limitations.push(`backups-superseded: lstat failed (${path})`);
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push({
        area: "backups-superseded",
        root,
        path,
        bytes: measureBytes(path),
        decision: "preserved",
        reason: "symlink not followed",
      });
      continue;
    }
    if (!st.isFile() && !st.isDirectory()) {
      entries.push({
        area: "backups-superseded",
        root,
        path,
        bytes: measureBytes(path),
        decision: "preserved",
        reason: "not a regular file or directory",
        doubt: true,
      });
      continue;
    }
    const bytes = measureBytes(path);
    const typeKey = backupTypeKey(name);
    if (!typeKey) {
      entries.push({
        area: "backups-superseded",
        root,
        path,
        bytes,
        decision: "preserved",
        reason: "backup type is not recognizable from the name",
        doubt: true,
      });
      continue;
    }
    const list = groups.get(typeKey) ?? [];
    list.push({ path, name, bytes, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory(), typeKey });
    groups.set(typeKey, list);
  }

  for (const [typeKey, list] of groups) {
    const ordered = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    ordered.forEach((entry, index) => {
      const isNewest = index === 0;
      entries.push({
        area: "backups-superseded",
        root,
        path: entry.path,
        bytes: entry.bytes,
        decision: isNewest ? "preserved" : "candidate",
        reason: isNewest ? `newest backup of type ${typeKey}` : `superseded by the newest backup of type ${typeKey}`,
      });
    });
  }

  return { area: "backups-superseded", entries, limitations };
}

/** Exposed for tests: newest entry of each type must survive. */
export function newestBackupPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const newest: string[] = [];
  const grouped = new Map<string, { path: string; mtimeMs: number; name: string }[]>();
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const key = backupTypeKey(name);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push({ path, mtimeMs: st.mtimeMs, name });
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    if (list[0]) newest.push(list[0].path);
  }
  return newest;
}
