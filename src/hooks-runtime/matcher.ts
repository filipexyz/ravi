import { resolve, isAbsolute } from "node:path";
import { expandHome } from "../router/index.js";
import type { HookRecord, NormalizedHookEvent } from "./types.js";

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const placeholder = "__HOOK_GLOBSTAR__";
  const escaped = escapeRegex(pattern.replace(/\*\*/g, placeholder))
    .replace(new RegExp(placeholder, "g"), ".*")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function splitMatcherPatterns(matcher: string): string[] {
  return matcher
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeScopePath(value: string): string {
  const expanded = expandHome(value.trim());
  return resolve(expanded);
}

function pathFallsWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function getMatcherCandidates(event: NormalizedHookEvent): string[] {
  switch (event.eventName) {
    case "PreToolUse":
    case "PostToolUse":
      return event.toolName ? [event.toolName] : [];
    case "CwdChanged":
      return event.path ? [event.path] : event.cwd ? [event.cwd] : [];
    case "FileChanged":
      return event.paths && event.paths.length > 0 ? event.paths : event.path ? [event.path] : [];
    case "SessionStart":
    case "Stop":
      return event.sessionName ? [event.sessionName] : [];
  }
}

export function matchesHookScope(hook: HookRecord, event: NormalizedHookEvent): boolean {
  if (hook.scopeType === "global") {
    return true;
  }

  const scopeValue = hook.scopeValue?.trim();
  if (!scopeValue) {
    return false;
  }

  switch (hook.scopeType) {
    case "agent":
      return event.agentId === scopeValue;
    case "session":
      return event.sessionName === scopeValue || event.sessionKey === scopeValue;
    case "task":
      return event.taskId === scopeValue;
    case "workspace": {
      const root = normalizeScopePath(scopeValue);
      const candidates = [event.workspace, event.cwd, event.path, ...(event.paths ?? [])].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      return candidates.some((candidate) => pathFallsWithin(root, normalizeScopePath(candidate)));
    }
    default:
      return false;
  }
}

export function matchesHookMatcher(hook: HookRecord, event: NormalizedHookEvent): boolean {
  if (!hook.matcher?.trim()) {
    return true;
  }

  const patterns = splitMatcherPatterns(hook.matcher);
  if (patterns.length === 0) {
    return true;
  }

  const candidates = getMatcherCandidates(event);
  if (candidates.length === 0) {
    return false;
  }

  return patterns.some((pattern) => {
    const regex = globToRegex(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

export function matchesHook(hook: HookRecord, event: NormalizedHookEvent): boolean {
  if (!hook.enabled) return false;
  if (hook.eventName !== event.eventName) return false;
  if (!matchesHookScope(hook, event)) return false;
  if (!matchesHookMatcher(hook, event)) return false;
  return true;
}

export function resolveToolFilePaths(event: Pick<NormalizedHookEvent, "toolName" | "toolInput" | "cwd">): string[] {
  const toolName = event.toolName;
  const toolInput = event.toolInput ?? {};
  const cwd = event.cwd ?? process.cwd();

  const candidates: string[] = [];

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = toolInput.file_path;
    if (typeof filePath === "string" && filePath.trim()) {
      candidates.push(filePath.trim());
    }
  }

  if (toolName === "NotebookEdit") {
    const notebookPath = toolInput.notebook_path;
    if (typeof notebookPath === "string" && notebookPath.trim()) {
      candidates.push(notebookPath.trim());
    }
  }

  return candidates.map((candidate) => {
    const expanded = expandHome(candidate);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  });
}

export function resolveChangedCwd(
  event: Pick<NormalizedHookEvent, "toolName" | "toolInput" | "cwd">,
): string | undefined {
  const toolName = event.toolName;
  const toolInput = event.toolInput ?? {};
  const cwd = event.cwd ?? process.cwd();

  if (toolName === "EnterWorktree") {
    const nextPath = toolInput.path ?? toolInput.cwd;
    if (typeof nextPath === "string" && nextPath.trim()) {
      const expanded = expandHome(nextPath.trim());
      return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    }
  }

  if (toolName === "Bash") {
    const command = toolInput.command;
    if (typeof command !== "string" || !command.trim()) {
      return undefined;
    }

    const match = command.match(/(?:^|&&|\|\||;|\n)\s*cd\s+((?:"[^"]+"|'[^']+'|[^;&|\n])+)/);
    if (!match?.[1]) {
      return undefined;
    }

    const rawPath = match[1].trim().replace(/^['"]|['"]$/g, "");
    const expanded = expandHome(rawPath);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  }

  return undefined;
}
