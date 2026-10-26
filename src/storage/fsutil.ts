/**
 * Bounded, symlink-safe filesystem helpers shared by every storage class.
 */

import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

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

/**
 * True when `target` lives under a protected root, unless it lives under one
 * of the class exemptions (a class root that is itself inside a protected root,
 * e.g. `~/.ravi/backups` inside `~/.ravi`).
 */
export function isProtectedPath(target: string, protectedRoots: string[], exemptions: string[] = []): boolean {
  const inside = (candidate: string, root: string): boolean => {
    const withSep = root.endsWith(sep) ? root : root + sep;
    return candidate === root || candidate.startsWith(withSep);
  };
  if (exemptions.some((root) => inside(target, root))) return false;
  return protectedRoots.some((root) => inside(target, root));
}

export interface WalkedFile {
  path: string;
  /** Path segments relative to the walk root, including the file name. */
  segments: string[];
}

/**
 * Depth- and count-bounded recursive walk that never follows symlinks. Returns
 * regular files only.
 */
export function walkRegularFiles(root: string, options: { maxDepth: number; maxEntries?: number }): WalkedFile[] {
  const files: WalkedFile[] = [];
  const maxEntries = options.maxEntries ?? SIZE_CAP_ENTRIES;
  let seen = 0;
  const walk = (dir: string, segments: string[], depth: number): void => {
    if (depth > options.maxDepth || seen >= maxEntries) return;
    let children: Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (seen >= maxEntries) return;
      seen += 1;
      const name = String(child.name);
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full, [...segments, name], depth + 1);
        continue;
      }
      if (st.isFile()) files.push({ path: full, segments: [...segments, name] });
    }
  };
  walk(root, [], 0);
  return files;
}
