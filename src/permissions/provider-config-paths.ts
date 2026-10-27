import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
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
  const segments = path.split(/[\\/]+/);
  return segments.some((segment) => PROVIDER_CONFIG_DIRS.has(segment)) || PROVIDER_CONFIG_FILES.has(basename(path));
}

function realpathOfNearestExisting(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...rest);
  } catch {
    return path;
  }
}

export function isProviderConfigPath(path: string, cwd?: string): boolean {
  const raw = path.trim();
  if (!raw) return false;
  if (hasProviderConfigSegment(raw)) return true;
  const absolute = resolve(cwd ?? process.cwd(), raw.replace(/^~(?=\/|$)/, homedir()));
  return hasProviderConfigSegment(absolute) || hasProviderConfigSegment(realpathOfNearestExisting(absolute));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
