import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { normalizeRuntimeBuiltinToolName } from "../cli/tool-registry.js";
import type { CapabilityContextLike } from "./capability-context.js";
import { canWithCapabilityContext } from "./provider-runtime.js";

/**
 * Runtime providers load their own settings from these places (Claude Code's
 * `<cwd>/.claude/settings.json` with `settingSources: ["project"]`, `.mcp.json`,
 * Codex and Pi config dirs), and those settings can run host commands as hooks
 * or MCP servers on later turns, outside the turn's executable ceiling.
 */
const PROVIDER_CONFIG_DIRS = new Set([".claude", ".codex", ".pi"]);
const PROVIDER_CONFIG_FILES = new Set([".mcp.json"]);
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATCH_PATH_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function hasProviderConfigSegment(path: string): boolean {
  // Treat case variants conservatively too: the daemon may run on a
  // case-insensitive filesystem where .CoDeX is the provider's .codex.
  const segments = path.toLowerCase().split(/[\\/]+/);
  return (
    segments.some((segment) => PROVIDER_CONFIG_DIRS.has(segment)) ||
    PROVIDER_CONFIG_FILES.has(basename(path).toLowerCase())
  );
}

/**
 * Resolve filesystem traversal in kernel order: follow a symlink before the
 * next `..`. path.resolve/realpath on the normalized path loses that ordering.
 * Missing final components are allowed (writes may create them); unreadable
 * paths and link cycles are indeterminate and must fail closed at the caller.
 */
export function physicalPathForPermissionCheck(path: string, cwd = process.cwd()): string | null {
  const base = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
  const absolute = isAbsolute(path) ? path : `${base}${sep}${path}`;
  let current = parse(absolute).root;
  const pending = absolute.slice(current.length).split(sep);
  let symlinks = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    try {
      if (lstatSync(next).isSymbolicLink()) {
        if (++symlinks > 40) return null;
        const target = readlinkSync(next);
        if (isAbsolute(target)) current = parse(target).root;
        pending.unshift(...target.split(sep));
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    current = next;
  }
  return current;
}

export function isProviderConfigPath(path: string, cwd?: string): boolean {
  // Whitespace is part of a filesystem name, including a symlink's name.
  const raw = path;
  if (!raw) return false;
  if (hasProviderConfigSegment(raw)) return true;
  const expanded = raw.replace(/^~(?=\/|$)/, homedir());
  const absolute = resolve(cwd ?? process.cwd(), expanded);
  const physical = physicalPathForPermissionCheck(expanded, cwd);
  return physical === null || hasProviderConfigSegment(absolute) || hasProviderConfigSegment(physical);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The paths a file-writing tool call would change, by the input shapes the providers use. */
export function fileWriteToolTargets(toolName: string, input: unknown): string[] {
  const nativeName = normalizeRuntimeBuiltinToolName(toolName) ?? toolName;
  if (!FILE_WRITE_TOOLS.has(nativeName) || !input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const targets = [record.file_path, record.notebook_path, record.path, record.filePath]
    .map(stringValue)
    .filter((value): value is string => Boolean(value));
  for (const text of [record.patch, record.input, record.content].map(stringValue)) {
    if (!text?.includes("*** ")) continue;
    for (const match of text.matchAll(PATCH_PATH_LINE)) targets.push(match[1]!.trim());
  }
  if (Array.isArray(record.changes)) {
    for (const change of record.changes) {
      const path = stringValue((change as Record<string, unknown> | null)?.path);
      if (path) targets.push(path);
    }
  }
  return targets;
}

type CanCheck = (permission: string, objectType: string, objectId: string) => boolean;

export function contextCan(context: CapabilityContextLike | undefined): CanCheck {
  return (permission, objectType, objectId) =>
    !context || canWithCapabilityContext(context, permission, objectType, objectId);
}

/**
 * The reason to deny a tool call that writes provider settings, or undefined.
 * Only principals that can already run any host executable may write them.
 */
export function providerConfigWriteDenial(input: {
  can: CanCheck;
  agentId?: string | null;
  targets: string[];
  cwd?: string;
}): string | undefined {
  const protectedTargets = input.targets.filter((target) => isProviderConfigPath(target, input.cwd));
  if (protectedTargets.length === 0) return undefined;
  if (input.can("admin", "system", "*") || input.can("execute", "executable", "*")) return undefined;
  return `Permission denied: agent:${input.agentId ?? "unknown"} cannot write runtime provider settings (${protectedTargets.join(", ")}); they can run host commands and need execute:executable:* or admin:system:*`;
}
