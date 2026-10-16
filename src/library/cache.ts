/**
 * Local copy of the Library skills this installation loaded.
 *
 * spec: skills/library
 *
 *   <stateDir>/library/<orgId>/index.json
 *   <stateDir>/library/<orgId>/<scope>/<slug>@<version>/item.json
 *   <stateDir>/library/<orgId>/<scope>/<slug>@<version>/<files...>
 *
 * Agent definitions (`kind: "agent"`) keep the same layout under
 * `<stateDir>/library/agent-definitions/<orgId>/`: a skill and an agent may
 * share a slug.
 *
 * `<scope>` is `org` or the project slug (`org` is a reserved project slug).
 * Versions never change once published, so a version directory is written
 * once, atomically (temporary directory, then rename). The index is replaced
 * atomically on every write. Everything here is best effort: a cache that
 * cannot be read or written never fails a command.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { getRaviStateDir } from "../utils/paths.js";
import { isLibrarySlug, libraryRef, LIBRARY_ORG_SCOPE } from "./refs.js";
import type { LibraryItem, LibraryShowResponse, LibraryVersionFile } from "./types.js";

const INDEX_FILE = "index.json";
const ITEM_FILE = "item.json";
const INDEX_VERSION = 1;

export interface LibraryCacheIndexEntry {
  item: LibraryItem;
  /** Newest version whose files are cached, or null when only the metadata is. */
  cachedVersion: number | null;
  cachedAt: string;
}

export interface LibraryCacheIndex {
  version: typeof INDEX_VERSION;
  updatedAt: string;
  items: Record<string, LibraryCacheIndexEntry>;
}

export interface CachedLibrarySkill extends LibraryShowResponse {
  dir: string;
  cachedAt: string;
}

export interface LibraryCacheOptions {
  stateDir?: string;
  now?: () => Date;
  /** `skill` (default) or `agent` definitions, kept apart. */
  kind?: "skill" | "agent";
}

export function libraryCacheRoot(orgId: string, options: LibraryCacheOptions = {}): string {
  const root = join(options.stateDir ?? getRaviStateDir(), "library");
  return options.kind === "agent"
    ? join(root, "agent-definitions", safeSegment(orgId))
    : join(root, safeSegment(orgId));
}

/** `org` or the item's project slug. */
export function libraryScopeDir(item: Pick<LibraryItem, "scope" | "project">): string {
  return item.scope === "org" ? LIBRARY_ORG_SCOPE : safeSegment(item.project?.slug ?? "project");
}

export function libraryVersionDir(
  orgId: string,
  item: Pick<LibraryItem, "scope" | "project" | "slug">,
  version: number,
  options: LibraryCacheOptions = {},
): string {
  return join(libraryCacheRoot(orgId, options), libraryScopeDir(item), `${safeSegment(item.slug)}@${version}`);
}

/** The ref of an item as this side shows it (`org/<slug>` or `<projectSlug>/<slug>`). */
export function itemRef(item: Pick<LibraryItem, "scope" | "project" | "slug">): string {
  return item.scope === "org"
    ? libraryRef("org", null, item.slug).ref
    : libraryRef("project", item.project?.slug ?? "", item.slug).ref;
}

export function readLibraryIndex(orgId: string, options: LibraryCacheOptions = {}): LibraryCacheIndex {
  const path = join(libraryCacheRoot(orgId, options), INDEX_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LibraryCacheIndex>;
    if (parsed && parsed.version === INDEX_VERSION && parsed.items && typeof parsed.items === "object") {
      return parsed as LibraryCacheIndex;
    }
  } catch {
    // Missing or unreadable: an empty index.
  }
  return { version: INDEX_VERSION, updatedAt: new Date(0).toISOString(), items: {} };
}

/** Record items seen in a search (metadata only; cached files stay as they are). */
export function recordLibraryItems(orgId: string, items: readonly LibraryItem[], options: LibraryCacheOptions = {}) {
  if (items.length === 0) return;
  updateIndex(orgId, options, (index, now) => {
    for (const item of items) {
      const ref = itemRef(item);
      const previous = index.items[ref];
      index.items[ref] = { item, cachedVersion: previous?.cachedVersion ?? null, cachedAt: previous?.cachedAt ?? now };
    }
  });
}

/** Write one shown version and record it in the index. Returns the version directory, or null on failure. */
export function writeLibrarySkill(
  orgId: string,
  shown: LibraryShowResponse,
  options: LibraryCacheOptions = {},
): string | null {
  const { item, version } = shown;
  if (!isLibrarySlug(item.slug)) return null;
  const dir = libraryVersionDir(orgId, item, version.number, options);
  try {
    if (!existsSync(join(dir, ITEM_FILE))) {
      const parent = dirname(dir);
      mkdirSync(parent, { recursive: true });
      const temp = join(parent, `.tmp-${randomBytes(6).toString("hex")}`);
      try {
        mkdirSync(temp);
        for (const file of version.files) {
          const target = safeJoin(temp, file.path);
          if (!target) throw new Error(`unsafe Library file path: ${file.path.slice(0, 80)}`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.content, "utf8");
        }
        const meta = { item, version: { ...version, files: version.files.map(({ content: _c, ...rest }) => rest) } };
        writeFileSync(join(temp, ITEM_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        rmSync(dir, { recursive: true, force: true });
        renameSync(temp, dir);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
    updateIndex(orgId, options, (index, now) => {
      const ref = itemRef(item);
      const previous = index.items[ref];
      const cachedVersion = Math.max(previous?.cachedVersion ?? 0, version.number);
      index.items[ref] = {
        item: cachedVersion === version.number ? item : (previous?.item ?? item),
        cachedVersion,
        cachedAt: now,
      };
    });
    return dir;
  } catch {
    return null;
  }
}

/** The newest cached version of the item a ref names, with its files. */
export function readCachedLibrarySkill(
  orgId: string,
  ref: string,
  options: LibraryCacheOptions = {},
): CachedLibrarySkill | null {
  const entry = readLibraryIndex(orgId, options).items[ref];
  if (!entry?.cachedVersion) return null;
  const dir = libraryVersionDir(orgId, entry.item, entry.cachedVersion, options);
  try {
    const meta = JSON.parse(readFileSync(join(dir, ITEM_FILE), "utf8")) as {
      item: LibraryItem;
      version: Omit<LibraryShowResponse["version"], "files"> & { files: Array<Omit<LibraryVersionFile, "content">> };
    };
    const files: LibraryVersionFile[] = [];
    for (const file of meta.version.files) {
      const target = safeJoin(dir, file.path);
      if (!target) return null;
      files.push({ ...file, content: readFileSync(target, "utf8") });
    }
    return { item: meta.item, version: { ...meta.version, files }, dir, cachedAt: entry.cachedAt };
  } catch {
    return null;
  }
}

/** Cached items a bare slug may name in a view: the org item, or the given project's item. */
export function findCachedLibraryRefsForSlug(
  orgId: string,
  slug: string,
  project: string | null,
  options: LibraryCacheOptions = {},
): string[] {
  const index = readLibraryIndex(orgId, options);
  return Object.entries(index.items)
    .filter(([, entry]) => entry.item.slug === slug)
    .filter(
      ([, entry]) =>
        entry.item.scope === "org" ||
        (project !== null && (entry.item.project?.slug === project || entry.item.project?.id === project)),
    )
    .sort(([, a], [, b]) => (a.item.scope === b.item.scope ? 0 : a.item.scope === "org" ? -1 : 1))
    .map(([ref]) => ref);
}

function updateIndex(
  orgId: string,
  options: LibraryCacheOptions,
  mutate: (index: LibraryCacheIndex, now: string) => void,
): void {
  try {
    const root = libraryCacheRoot(orgId, options);
    mkdirSync(root, { recursive: true });
    const index = readLibraryIndex(orgId, options);
    const now = (options.now?.() ?? new Date()).toISOString();
    mutate(index, now);
    index.updatedAt = now;
    const path = join(root, INDEX_FILE);
    const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Best effort: the cache never fails a command.
  }
}

/** `a/b.md` under `root`, or null when the path is absolute, empty or climbs out. */
function safeJoin(root: string, relative: string): string | null {
  if (!relative || relative.includes("\0") || relative.startsWith("/") || relative.includes("\\")) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const target = resolve(root, ...segments);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : null;
}

function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_");
  return cleaned || "_";
}

/** For tests: list the version directories cached for an org. */
export function listCachedVersionDirs(orgId: string, options: LibraryCacheOptions = {}): string[] {
  const root = libraryCacheRoot(orgId, options);
  const dirs: string[] = [];
  try {
    for (const scope of readdirSync(root, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      for (const entry of readdirSync(join(root, scope.name), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) dirs.push(join(scope.name, entry.name));
      }
    }
  } catch {
    return [];
  }
  return dirs.sort();
}
