import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface MemoryGuardTargetInput {
  agentCwd: string;
  targetPath: string;
}

/**
 * Resolve a memory-guard target against one authenticated agent's canonical
 * stores. The returned path uses the real parent directory, so later IO does
 * not depend on a caller-controlled lexical path.
 */
export function resolveAuthorizedMemoryGuardTarget(input: MemoryGuardTargetInput): string {
  const expandedCwd = expandHome(input.agentCwd);
  if (!isAbsolute(expandedCwd)) {
    throw new Error("authenticated agent cwd must be absolute");
  }
  if (!isAbsolute(input.targetPath)) {
    throw new Error("--target must be an absolute path");
  }

  const lexicalRoot = resolve(expandedCwd);
  const lexicalTarget = resolve(input.targetPath);
  const lexicalIndex = join(lexicalRoot, "MEMORY.md");
  const lexicalTopics = join(lexicalRoot, "memory");

  if (!isAllowedStorePath(lexicalTarget, lexicalIndex, lexicalTopics)) {
    throw new Error("--target must be the authenticated agent's MEMORY.md or a file below its memory/ store");
  }

  assertExistingDirectory(lexicalRoot, "authenticated agent cwd");
  assertNoSymlinkComponents(lexicalRoot);
  assertNoSymlinkComponents(lexicalTarget);

  const lexicalParent = dirname(lexicalTarget);
  assertExistingDirectory(lexicalParent, "memory target parent");

  const realRoot = realpathSync(lexicalRoot);
  const realParent = realpathSync(lexicalParent);
  const realTarget = join(realParent, basename(lexicalTarget));
  const realIndex = join(realRoot, "MEMORY.md");
  const realTopics = join(realRoot, "memory");

  if (!isInside(realRoot, realParent) || !isAllowedStorePath(realTarget, realIndex, realTopics)) {
    throw new Error("--target escapes the authenticated agent's real cwd");
  }
  if (existsSync(realTarget) && !statSync(realTarget).isFile()) {
    throw new Error("--target must resolve to a regular file");
  }
  return realTarget;
}

function isAllowedStorePath(target: string, memoryIndex: string, memoryDir: string): boolean {
  if (target === memoryIndex) return true;
  const rel = relative(memoryDir, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertExistingDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
}

/** Reject every existing symlink component, including the target itself. */
function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`memory target contains a symlink component: ${current}`);
    }
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}
