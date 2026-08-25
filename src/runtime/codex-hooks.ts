import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RAVI_CODEX_BASH_HOOK_STATUS = "ravi codex bash permission gate";
export const RAVI_CODEX_LEGACY_TOOL_HOOK_STATUS = "ravi codex native tool permission gate";
export const RAVI_CODEX_BASH_HOOK_MATCHER = "^(Bash|shell)$";
export const RAVI_CODEX_BASH_HOOK_COMMAND = "codex-bash-hook";
export const RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND = "codex-tool-hook";

export interface CodexHookEnsureResult {
  path: string;
  changed: boolean;
  signature: string;
}

export interface CodexHookInspection {
  path: string;
  exists: boolean;
  validJson: boolean;
  parseError?: string;
  ok: boolean;
  matcherOk: boolean;
  preferredCommand: boolean;
  staleCommand: boolean;
  staleStatus: boolean;
  reasons: string[];
}

export function getGlobalCodexConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".codex");
}

export function getCodexHooksPath(configDir = getGlobalCodexConfigDir()): string {
  return join(configDir, "hooks.json");
}

export function ensureCodexBashHookConfig(configDir = getGlobalCodexConfigDir()): CodexHookEnsureResult {
  const hooksPath = getCodexHooksPath(configDir);
  mkdirSync(configDir, { recursive: true });

  const nextConfig = upsertRaviCodexBashHook(readCodexHooksConfig(hooksPath));
  const nextJson = JSON.stringify(nextConfig, null, 2) + "\n";
  const currentJson = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : null;
  const changed = currentJson !== nextJson;
  if (changed) {
    writeFileSync(hooksPath, nextJson, "utf8");
  }

  return { path: hooksPath, changed, signature: nextJson };
}

export function inspectCodexHookConfig(raw: string | null, hooksPath: string): CodexHookInspection {
  if (raw === null) {
    return {
      path: hooksPath,
      exists: false,
      validJson: false,
      ok: false,
      matcherOk: false,
      preferredCommand: false,
      staleCommand: false,
      staleStatus: false,
      reasons: ["global Codex hooks file is missing"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      path: hooksPath,
      exists: true,
      validJson: false,
      parseError: error instanceof Error ? error.message : String(error),
      ok: false,
      matcherOk: false,
      preferredCommand: false,
      staleCommand: false,
      staleStatus: false,
      reasons: ["global Codex hooks file is not valid JSON"],
    };
  }

  return inspectParsedCodexHookConfig(parsed, hooksPath);
}

export function inspectParsedCodexHookConfig(value: unknown, hooksPath: string): CodexHookInspection {
  const groups = listPreToolUseGroups(value);
  if (!groups) {
    return {
      path: hooksPath,
      exists: true,
      validJson: true,
      ok: false,
      matcherOk: false,
      preferredCommand: false,
      staleCommand: false,
      staleStatus: false,
      reasons: ["Ravi Codex bash governance is missing from PreToolUse"],
    };
  }

  const raviGroups = groups.filter(isRaviCodexHookGroup);
  if (raviGroups.length === 0) {
    return {
      path: hooksPath,
      exists: true,
      validJson: true,
      ok: false,
      matcherOk: false,
      preferredCommand: false,
      staleCommand: false,
      staleStatus: false,
      reasons: ["Ravi Codex bash governance is missing from PreToolUse"],
    };
  }

  const matcherOk = raviGroups.some((group) => group.matcher === RAVI_CODEX_BASH_HOOK_MATCHER);
  const preferredCommand = raviGroups.some((group) =>
    listHookCommands(group).some(
      (command) =>
        commandIncludesHookName(command, RAVI_CODEX_BASH_HOOK_COMMAND) &&
        !commandIncludesHookName(command, RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND),
    ),
  );
  const staleCommand = raviGroups.some((group) =>
    listHookCommands(group).some((command) => commandIncludesHookName(command, RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND)),
  );
  const staleStatus = raviGroups.some((group) =>
    listHookStatusMessages(group).includes(RAVI_CODEX_LEGACY_TOOL_HOOK_STATUS),
  );

  const reasons: string[] = [];
  if (!matcherOk) {
    reasons.push(`PreToolUse matcher must be exactly \`${RAVI_CODEX_BASH_HOOK_MATCHER}\``);
  }
  if (staleCommand) {
    reasons.push(
      `stale PreToolUse command \`codex-tool-hook\` must be rewritten to \`${RAVI_CODEX_BASH_HOOK_COMMAND}\``,
    );
  }
  if (!preferredCommand && !staleCommand) {
    reasons.push(`PreToolUse command must invoke \`ravi context ${RAVI_CODEX_BASH_HOOK_COMMAND}\``);
  }
  if (staleStatus && reasons.length === 0) {
    reasons.push("legacy Ravi Codex tool-hook status is still present");
  }

  return {
    path: hooksPath,
    exists: true,
    validJson: true,
    ok: reasons.length === 0 && raviGroups.length === 1 && matcherOk && preferredCommand,
    matcherOk,
    preferredCommand,
    staleCommand,
    staleStatus,
    reasons,
  };
}

export function upsertRaviCodexBashHook(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = asRecord(config.hooks) ?? {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const raviGroup = {
    matcher: RAVI_CODEX_BASH_HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: buildRaviCodexHookCommand(),
        statusMessage: RAVI_CODEX_BASH_HOOK_STATUS,
      },
    ],
  };

  const nextPreToolUse = preToolUse.filter((group) => !isRaviCodexHookGroup(group));
  nextPreToolUse.push(raviGroup);

  return {
    ...config,
    hooks: {
      ...hooks,
      PreToolUse: nextPreToolUse,
    },
  };
}

export function isRaviCodexHookGroup(value: unknown): boolean {
  const group = asRecord(value);
  if (!group) {
    return false;
  }

  const handlers = Array.isArray(group.hooks) ? group.hooks : [];
  return handlers.some((handler) => {
    const entry = asRecord(handler);
    if (!entry) {
      return false;
    }
    if (
      entry.statusMessage === RAVI_CODEX_BASH_HOOK_STATUS ||
      entry.statusMessage === RAVI_CODEX_LEGACY_TOOL_HOOK_STATUS
    ) {
      return true;
    }
    return (
      typeof entry.command === "string" &&
      (commandIncludesHookName(entry.command, RAVI_CODEX_BASH_HOOK_COMMAND) ||
        commandIncludesHookName(entry.command, RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND))
    );
  });
}

export function buildRaviCodexHookCommand(): string {
  const configuredRaviBin = process.env.RAVI_BIN?.trim();
  if (configuredRaviBin) {
    return [configuredRaviBin, "context", RAVI_CODEX_BASH_HOOK_COMMAND].map(shellEscape).join(" ");
  }

  const bundlePath = process.argv[1];
  if (isRunnableRaviCliEntrypoint(bundlePath)) {
    return [process.execPath, bundlePath, "context", RAVI_CODEX_BASH_HOOK_COMMAND].map(shellEscape).join(" ");
  }

  const sourceRaviBin = resolveSourceRaviBinPath();
  if (sourceRaviBin) {
    return [sourceRaviBin, "context", RAVI_CODEX_BASH_HOOK_COMMAND].map(shellEscape).join(" ");
  }

  return ["ravi", "context", RAVI_CODEX_BASH_HOOK_COMMAND].map(shellEscape).join(" ");
}

function readCodexHooksConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return { hooks: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return asRecord(parsed) ?? { hooks: {} };
  } catch {
    return { hooks: {} };
  }
}

function listPreToolUseGroups(value: unknown): unknown[] | null {
  const root = asRecord(value);
  const hooks = asRecord(root?.hooks);
  if (!hooks || !Array.isArray(hooks.PreToolUse)) {
    return null;
  }
  return hooks.PreToolUse;
}

function listHookCommands(group: unknown): string[] {
  const record = asRecord(group);
  const handlers = Array.isArray(record?.hooks) ? record.hooks : [];
  return handlers.flatMap((handler) => {
    const entry = asRecord(handler);
    return typeof entry?.command === "string" ? [entry.command] : [];
  });
}

function listHookStatusMessages(group: unknown): string[] {
  const record = asRecord(group);
  const handlers = Array.isArray(record?.hooks) ? record.hooks : [];
  return handlers.flatMap((handler) => {
    const entry = asRecord(handler);
    return typeof entry?.statusMessage === "string" ? [entry.statusMessage] : [];
  });
}

function commandIncludesHookName(command: string, hookName: string): boolean {
  return command.split(/\s+/).some((token) => token.replace(/^['"]|['"]$/g, "") === hookName);
}

function isRunnableRaviCliEntrypoint(entrypoint?: string): entrypoint is string {
  if (!entrypoint || !existsSync(entrypoint)) {
    return false;
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(entrypoint)) {
    return false;
  }
  return entrypoint.endsWith("/dist/bundle/index.js") || entrypoint.endsWith("/src/cli/index.ts");
}

function resolveSourceRaviBinPath(): string | null {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const candidate = join(dirname(dirname(dirname(modulePath))), "bin", "ravi");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function shellEscape(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
