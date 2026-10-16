/**
 * A local skill folder as a Library version: the files `ravi skills publish`
 * sends, checked against the Console's limits before any request.
 *
 * spec: skills/library
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parseSkillContent } from "../skills/manager.js";
import { isLibrarySlug, isReservedLibrarySlug } from "./refs.js";

export const LIBRARY_ENTRY_FILE = "SKILL.md";
export const LIBRARY_LIMITS = {
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxVersionBytes: 1024 * 1024,
  maxPathLength: 255,
  maxNameLength: 120,
  maxDescriptionLength: 1024,
  maxNoteLength: 500,
} as const;

const PATH_PATTERN = /^[A-Za-z0-9._\-/]+$/;
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "__pypackages__"]);
const MAX_DEPTH = 8;

export type LibraryPackageIssueCode = "LIBRARY_PACKAGE_INVALID" | "LIBRARY_SLUG_RESERVED" | "LIBRARY_REF_INVALID";

export class LibraryPackageError extends Error {
  constructor(
    readonly code: LibraryPackageIssueCode,
    message: string,
    readonly issues: Array<{ path: string[]; code: string; message: string }> = [],
  ) {
    super(message);
    this.name = "LibraryPackageError";
  }
}

export interface LibraryPackageFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface LibraryPackage {
  dir: string;
  slug: string;
  name: string;
  description: string;
  files: LibraryPackageFile[];
  totalBytes: number;
  contentHash: string;
}

export interface ReadLibraryPackageOptions {
  slug?: string;
  name?: string;
}

export function isSafeLibraryPath(path: string): boolean {
  if (!path || path.length > LIBRARY_LIMITS.maxPathLength || !PATH_PATTERN.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** SHA-256 over `path NUL file-sha256 LF` for each file, sorted by path (same as the Console). */
export function libraryContentHash(files: ReadonlyArray<Pick<LibraryPackageFile, "path" | "sha256">>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Read and check a skill folder. Throws {@link LibraryPackageError}. */
export function readLibraryPackage(dir: string, options: ReadLibraryPackageOptions = {}): LibraryPackage {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    throw invalid("The folder does not exist.", ["dir"]);
  }
  if (!stat.isDirectory()) throw invalid("Pass the skill folder (the directory that holds SKILL.md).", ["dir"]);

  const paths = listPackagePaths(dir);
  if (paths.length > LIBRARY_LIMITS.maxFiles) {
    throw invalid(`A Library skill holds at most ${LIBRARY_LIMITS.maxFiles} files; this folder has more.`, ["files"]);
  }
  if (!paths.includes(LIBRARY_ENTRY_FILE)) throw invalid("The folder has no SKILL.md at its root.", ["SKILL.md"]);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: LibraryPackageFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (!isSafeLibraryPath(path)) {
      throw invalid(`File path not allowed: ${path.slice(0, 120)}. Use A-Z a-z 0-9 . _ - / only.`, [path]);
    }
    const buffer = readFileSync(join(dir, ...path.split("/")));
    if (buffer.byteLength > LIBRARY_LIMITS.maxFileBytes) {
      throw invalid(`${path} is larger than ${LIBRARY_LIMITS.maxFileBytes / 1024} KiB.`, [path]);
    }
    let content: string;
    try {
      content = decoder.decode(buffer);
    } catch {
      throw invalid(`${path} is not UTF-8 text. A Library skill holds text files only.`, [path]);
    }
    totalBytes += buffer.byteLength;
    files.push({ path, content, bytes: buffer.byteLength, sha256: sha256(content) });
  }
  if (totalBytes > LIBRARY_LIMITS.maxVersionBytes) {
    throw invalid(`A Library skill is at most ${LIBRARY_LIMITS.maxVersionBytes / 1024 / 1024} MiB in total.`, [
      "files",
    ]);
  }

  const entry = files.find((file) => file.path === LIBRARY_ENTRY_FILE)!;
  const parsed = parseSkillContent(entry.content, "library", join(dir, LIBRARY_ENTRY_FILE), dir);
  const description = parsed.description?.trim() ?? "";
  if (!description) throw invalid("SKILL.md needs a `description` in its frontmatter.", ["SKILL.md", "description"]);
  if (description.length > LIBRARY_LIMITS.maxDescriptionLength) {
    throw invalid(`The description is longer than ${LIBRARY_LIMITS.maxDescriptionLength} characters.`, [
      "SKILL.md",
      "description",
    ]);
  }

  // `parsed.name` is the frontmatter `name`, else the folder name.
  const slug = (options.slug?.trim() || parsed.name || basename(dir)).trim().toLowerCase();
  if (!isLibrarySlug(slug)) {
    throw new LibraryPackageError(
      "LIBRARY_REF_INVALID",
      `"${slug.slice(0, 80)}" is not a valid Library slug: 1-64 characters of a-z, 0-9 and -, starting and ending with a letter or digit. Pass --slug.`,
      [{ path: ["slug"], code: "LIBRARY_REF_INVALID", message: "Invalid slug." }],
    );
  }
  if (isReservedLibrarySlug(slug)) {
    throw new LibraryPackageError(
      "LIBRARY_SLUG_RESERVED",
      `"${slug}" names a skill that ships with Ravi (or uses the ravi- prefix). Pick another slug with --slug.`,
      [{ path: ["slug"], code: "LIBRARY_SLUG_RESERVED", message: "Reserved slug." }],
    );
  }
  const name = (options.name?.trim() || parsed.name || slug).trim();
  if (name.length > LIBRARY_LIMITS.maxNameLength) {
    throw invalid(`The name is longer than ${LIBRARY_LIMITS.maxNameLength} characters.`, ["name"]);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir, slug, name, description, files, totalBytes, contentHash: libraryContentHash(files) };
}

export function checkLibraryNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > LIBRARY_LIMITS.maxNoteLength) {
    throw invalid(`--note is longer than ${LIBRARY_LIMITS.maxNoteLength} characters.`, ["note"]);
  }
  return trimmed;
}

/**
 * Relative paths of the folder's regular files. Dot entries, dependency
 * folders and symlinks are not packaged.
 */
function listPackagePaths(root: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      throw invalid(`Folders nest deeper than ${MAX_DEPTH} levels: ${prefix.slice(0, 120)}.`, [prefix]);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), relative, depth + 1);
      } else if (entry.isFile()) {
        paths.push(relative);
        if (paths.length > LIBRARY_LIMITS.maxFiles) return;
      }
    }
  };
  walk(root, "", 0);
  return paths.sort();
}

function invalid(message: string, path: string[]): LibraryPackageError {
  return new LibraryPackageError("LIBRARY_PACKAGE_INVALID", message, [
    { path, code: "LIBRARY_PACKAGE_INVALID", message },
  ]);
}
