/** Shared bootstrap policy for the retained runner and its sandboxed child. */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const privateChildren = [".ravi", ".codex", ".ssh", ".omni", ".aws", ".config", ".npmrc"];

/** Paired lexical/canonical roots resolved before the child sandbox is installed. */
export interface RetainedProtectedRoots {
  version: 1;
  lexicalRoots: string[];
  canonicalRoots: string[];
}

/** Resolves missing descendants through the nearest existing ancestor; other errors fail closed. */
function resolveRoot(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(resolveRoot(dirname(path), realpath), basename(path));
  }
}

/** Captures every private child's target, including symlinks; tests inject only synthetic metadata. */
export function captureRetainedProtectedRoots(
  home: string,
  realpath: (path: string) => string = realpathSync,
): RetainedProtectedRoots {
  if (!isAbsolute(home)) throw new Error("Retained bootstrap home must be absolute");
  const lexicalRoots = privateChildren.map((name) => join(resolve(home), name));
  return { version: 1, lexicalRoots, canonicalRoots: lexicalRoots.map((root) => resolveRoot(root, realpath)) };
}

/** Rejects missing/malformed bootstrap authority without inspecting protected paths in the child. */
export function parseRetainedProtectedRoots(serialized: string | undefined): RetainedProtectedRoots {
  if (!serialized) throw new Error("Missing retained protected-root bootstrap");
  const value = JSON.parse(serialized) as RetainedProtectedRoots;
  const validRoots = (roots: unknown): roots is string[] =>
    Array.isArray(roots) &&
    roots.length === privateChildren.length &&
    roots.every((root) => typeof root === "string" && isAbsolute(root) && resolve(root) === root);
  if (value?.version !== 1 || !validRoots(value.lexicalRoots) || !validRoots(value.canonicalRoots)) {
    throw new Error("Invalid retained protected-root bootstrap");
  }
  return value;
}

/** Returns the identical deny set consumed by filesystem interception and the OS profile. */
export function retainedProtectedRootUnion(roots: RetainedProtectedRoots): string[] {
  return [...new Set([...roots.lexicalRoots, ...roots.canonicalRoots])];
}

/** Adds no-removal/network denial to the shared private-root policy on macOS. */
export function retainedMacProfile(roots: RetainedProtectedRoots): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write-unlink)",
    ...retainedProtectedRootUnion(roots).map(
      (root) => `(deny file-read* file-write* (subpath ${JSON.stringify(root)}))`,
    ),
    "",
  ].join("\n");
}
