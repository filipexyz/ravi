/**
 * App packages (spec apps/store, "Package"): a folder of UTF-8 text files.
 * The tree hash reuses the Library formula, so the same folder hashes the same
 * from git, from a bundle file or from the Console.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { libraryContentHash } from "../../library/package.js";
import { AppStoreError } from "./types.js";

export const APP_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxPackageBytes: 1024 * 1024,
  maxPathLength: 200,
});

const SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export interface AppPackageFile {
  path: string;
  content: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A relative path with no dot files, no `..`, no backslashes and no empty segments. */
export function isSafePackagePath(path: string): boolean {
  if (!path || path.length > APP_PACKAGE_LIMITS.maxPathLength) return false;
  return path.split("/").every((segment) => SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..");
}

export function packageTreeHash(files: readonly AppPackageFile[]): string {
  return libraryContentHash(files.map((file) => ({ path: file.path, sha256: sha256Hex(file.content) })));
}

/** Check limits and paths; returns the files sorted by path. Throws APP_PACKAGE_INVALID. */
export function checkPackageFiles(files: readonly AppPackageFile[]): AppPackageFile[] {
  const problems: string[] = [];
  if (files.length === 0) problems.push("the package has no files");
  if (files.length > APP_PACKAGE_LIMITS.maxFiles) {
    problems.push(`the package has ${files.length} files; the limit is ${APP_PACKAGE_LIMITS.maxFiles}`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!isSafePackagePath(file.path)) problems.push(`unsafe path: ${file.path}`);
    if (seen.has(file.path)) problems.push(`duplicate path: ${file.path}`);
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > APP_PACKAGE_LIMITS.maxFileBytes) problems.push(`${file.path} is larger than 256 KiB`);
    if (file.content.startsWith("﻿")) problems.push(`${file.path} starts with a byte order mark`);
    if (file.content.includes("\0")) problems.push(`${file.path} is not text`);
    total += bytes;
  }
  if (total > APP_PACKAGE_LIMITS.maxPackageBytes) problems.push("the package is larger than 1 MiB");
  if (!seen.has("ravi.app.json")) problems.push("the package has no ravi.app.json at its root");
  if (problems.length > 0) {
    throw new AppStoreError("APP_PACKAGE_INVALID", `Invalid app package: ${problems.join("; ")}.`, 1, { problems });
  }
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Read every entry of a folder. Anything that is not a regular file or a
 * directory (a symlink, a socket) and any unsafe name fails, so the hash
 * covers exactly what is on disk.
 */
export function readPackageDir(root: string): AppPackageFile[] {
  const files: AppPackageFile[] = [];
  const problems: string[] = [];
  const visit = (dir: string, prefix: string, depth: number) => {
    if (depth > 8) {
      problems.push(`${prefix || "."} is nested too deep`);
      return;
    }
    for (const entry of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) problems.push(`${rel} is a symbolic link`);
      else if (stat.isDirectory()) visit(full, rel, depth + 1);
      else if (!stat.isFile()) problems.push(`${rel} is not a regular file`);
      else {
        const bytes = readFileSync(full);
        const content = bytes.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(bytes)) problems.push(`${rel} is not UTF-8 text`);
        files.push({ path: rel, content });
      }
    }
  };
  visit(root, "", 0);
  if (problems.length > 0) {
    throw new AppStoreError("APP_PACKAGE_INVALID", `Invalid app package: ${problems.join("; ")}.`, 1, { problems });
  }
  return checkPackageFiles(files);
}

export function writePackageDir(root: string, files: readonly AppPackageFile[]): void {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const file of checkPackageFiles(files)) {
    const target = join(root, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, file.content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  }
}
