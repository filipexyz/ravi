/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against the Permission Provider Runtime.
 *
 * Layers:
 * 1. Env spoofing check (RAVI_* override)
 * 2. Executable permissions (execute executable:<name>)
 * 3. Session scope (access session:<name>)
 *
 * Note: ravi CLI group-level scope (execute group:<name>) is handled by
 * enforceScopeCheck() in the CLI process, not here.
 */

import {
  analyzeBashCommand,
  checkDangerousPatterns,
  analyzeOutputRedirects,
  parseBashCommand,
  stripShellQuoting,
  UNCONDITIONAL_BLOCKS,
  type ShellOutputRedirect,
} from "./parser.js";
import { collectShellLevels, type ShellLevel } from "./shell-structure.js";
import { checkExecutablePath, isInterpreterName, isShellName } from "./executable-path.js";
import { logger } from "../utils/logger.js";
import { getScopeContext } from "../permissions/scope.js";
import { findOpenAskGrant } from "../sessions/ask-grants.js";
import {
  canWithCapabilities,
  canWithCapabilityContext,
  materializeSubjectCapabilities,
} from "../permissions/provider-runtime.js";
import { authorizeRestrictedAppCommand } from "../apps/restricted-turn.js";
import { isWithheldByDeny } from "../permissions/capability-snapshot.js";
import { emitPermissionDeniedAudit, recordAndEmitPermissionDenial } from "../permissions/denials.js";
import { buildAuditContextProvenance, type AuditContextProvenance } from "../permissions/audit-provenance.js";
import {
  fileWriteToolTargets,
  providerConfigWriteDenial,
  isActorBreakGlassLimited,
} from "../permissions/provider-config-paths.js";
import type { ContextCapability, ContextRecord, ContextSource } from "../router/router-db.js";

const log = logger.child("bash:hook");

function buildBashDeniedAuditEvent(
  command: string,
  decision: BashPermissionDecision,
  agentId?: string,
  ctx?: BashPermissionContext,
): {
  type: string;
  agentId: string;
  denied: string;
  reason: string;
  blockType?: string;
  detail?: { commandChars: number };
  context?: AuditContextProvenance;
} | null {
  if (decision.allowed || !decision.denialType) {
    return null;
  }

  const resolvedAgentId = agentId ?? "unknown";
  const detail = { commandChars: command.length };
  const provenance = buildAuditContextProvenance(ctx);
  const contextFields = provenance ? { context: provenance } : {};

  if (decision.denialType === "env_spoofing") {
    return {
      type: "env_spoofing",
      agentId: resolvedAgentId,
      denied: "RAVI_* override",
      reason: decision.reason ?? "Cannot override RAVI environment variables",
      detail,
      ...contextFields,
    };
  }

  if (decision.denialType === "executable") {
    return {
      type: "executable",
      agentId: resolvedAgentId,
      denied: command.split(/\s+/)[0] ?? "unknown",
      reason: decision.reason ?? "Bash command denied by Ravi",
      detail,
      ...contextFields,
    };
  }

  if (decision.denialType === "shell_syntax") {
    return {
      type: "shell_syntax",
      agentId: resolvedAgentId,
      denied: decision.syntaxRule ?? "restricted_syntax",
      blockType: decision.syntaxRule ?? "restricted_syntax",
      reason: decision.reason ?? "Command is outside the restricted shell syntax policy",
      detail,
      ...contextFields,
    };
  }

  if (decision.denialType === "session_scope") {
    return {
      type: "session_scope",
      agentId: resolvedAgentId,
      denied: extractRaviTarget(command) ?? "unknown",
      reason: decision.reason ?? "Bash command denied by Ravi",
      detail,
      ...contextFields,
    };
  }

  return null;
}

/**
 * Hook input structure from Claude Agent SDK.
 */
interface PreToolUseHookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** The session's working directory; relative tool paths resolve against it. */
  cwd?: string;
  /**
   * For an `mcp__*` tool, where the runtime got the server's definition.
   * `source: "sdk"` is a server the host process registered itself; any other
   * value is configuration the runtime loaded on its own (`project`, `user`,
   * `plugin` and so on), and `name` is then whatever that configuration says.
   */
  mcp_server?: { name?: unknown; source?: unknown };
}

/**
 * Hook context from Claude Agent SDK.
 */
interface HookContext {
  signal: AbortSignal;
}

/**
 * Hook callback type from Claude Agent SDK.
 */
type HookCallback = (
  input: PreToolUseHookInput,
  toolUseId: string | null,
  context: HookContext,
) => Promise<Record<string, unknown>>;

/**
 * Hook callback matcher type from Claude Agent SDK.
 */
interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
}

/**
 * Extract ravi CLI tool name from a bash command.
 * e.g. "ravi sessions send ..." → "sessions_send"
 *      "ravi daemon restart ..." → "daemon_restart"
 *      "ravi agents list" → "agents_list"
 *
 * Returns null if not a ravi command or can't parse.
 */
function extractRaviToolName(command: string): string | null {
  const match = command.match(/(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+([\w-]+)\s+([\w-]+)/);
  if (match) {
    return `${match[1]}_${match[2]}`;
  }
  return null;
}

/**
 * Extract the first positional argument from a ravi CLI command.
 * e.g. "ravi sessions send main 'msg'" → "main"
 *      "ravi sessions list" → null
 *      "ravi sessions read my-session" → "my-session"
 */
function extractRaviTarget(command: string): string | null {
  const match = command.match(
    /(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+[\w-]+\s+[\w-]+\s+(?:(?:-\w+\s+\S+\s+)*)["']?([^"'\s]+)/,
  );
  return match?.[1] ?? null;
}

/** A literal variable name, as opposed to `$X`, `${X}` or a brace expansion. */
const LITERAL_ENV_NAME = /^[A-Za-z_]\w*$/;

/**
 * The argument lists that follow each `env` in a command. `env` may be named by
 * any path or letter case (`/usr/bin/env`, and `ENV` on a case-insensitive filesystem).
 */
function findEnvInvocations(command: string): string[][] {
  const invocations: string[][] = [];
  for (const segment of command.split(/[;&|\n()]/)) {
    const tokens = segment.trim().split(/\s+/);
    tokens.forEach((token, index) => {
      if (/(?:^|\/)env$/i.test(token)) invocations.push(tokens.slice(index + 1));
    });
  }
  return invocations;
}

/**
 * Classify what one `env` invocation does to the environment of the command it runs.
 * Fail closed: the only options left alone are `-u NAME`, `-uNAME`, `--unset NAME` and
 * `--unset=NAME` with a literal, non-RAVI name. Anything else counts as a modified environment.
 */
function inspectEnvInvocation(args: string[]): "unchanged" | "modified" | "drops-ravi" {
  let modified = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (!arg.startsWith("-")) {
      if (/^[A-Za-z_]\w*=/.test(arg)) continue;
      break; // the command env runs
    }
    let name: string | undefined;
    if (arg === "-u" || arg === "--unset") name = args[++i];
    else if (arg.startsWith("--unset=")) name = arg.slice("--unset=".length);
    else if (/^-u./.test(arg)) name = arg.slice(2);
    else {
      modified = true;
      continue;
    }
    if (name === undefined || !LITERAL_ENV_NAME.test(name) || name.startsWith("RAVI_")) return "drops-ravi";
  }
  return modified ? "modified" : "unchanged";
}

/**
 * Check if a command attempts to override RAVI_* env vars (identity/config spoofing).
 * Blocks ALL RAVI_* env var overrides for non-superadmin agents.
 */
function checkEnvSpoofing(rawCommand: string): { allowed: boolean; reason?: string } {
  // Match on what the shell will actually run: `r'a'vi` and `R"A"VI_X=` are `ravi` and `RAVI_X=`,
  // and a backslash-newline joins two lines into one command.
  const command = stripShellQuoting(rawCommand.replace(/\\\r?\n/g, ""));
  if (/\bRAVI_\w+\s*=/.test(command)) {
    return {
      allowed: false,
      reason: "Cannot override RAVI environment variables",
    };
  }
  const envInvocations = findEnvInvocations(command).map(inspectEnvInvocation);
  // Dropping or blanking the runtime context key would turn the agent into the
  // local operator (`env -u RAVI_CONTEXT_KEY ravi ...`, `unset RAVI_CONTEXT_KEY`,
  // `printf -v RAVI_CONTEXT_KEY ''`).
  if (
    envInvocations.includes("drops-ravi") ||
    /(?:^|[\s;&|(])unset\s+(?:-[a-z]+\s+)*[^;&|\n]*\bRAVI_\w+/.test(command) ||
    /(?:^|[\s;&|(])export\s+-n\s+[^;&|\n]*\bRAVI_\w+/.test(command) ||
    /(?:^|[\s;&|(])printf\s+[^;&|\n]*-v\s*RAVI_\w+/.test(command) ||
    /(?:^|[\s;&|(])(?:declare|typeset|local|readonly|read|mapfile|readarray)\s+[^;&|\n]*\bRAVI_\w+/.test(command) ||
    /(?:^|[\s;&|(])for\s+RAVI_\w+\s/.test(command)
  ) {
    return {
      allowed: false,
      reason: "Cannot drop RAVI environment variables",
    };
  }
  // Any other env option (`-i`, `-`, `-S`, bundles such as `-iu`, GNU abbreviations
  // such as `--uns`) and `exec -c` can hand ravi a cleared or rewritten environment.
  // Only refuse when ravi is involved, so `env -i PATH=/usr/bin node x.js` keeps working.
  const clearsEnvironment =
    envInvocations.includes("modified") || /(?:^|[\s;&|(])exec\s+(?:-\w*c\w*)(?=\s|$)/.test(command);
  // Case-insensitive: on a default macOS filesystem `./bin/RAVI` runs ravi.
  if (clearsEnvironment && /\bravi\b/i.test(command)) {
    return {
      allowed: false,
      reason: "Cannot run ravi with a cleared or modified RAVI environment",
    };
  }
  return { allowed: true };
}

/**
 * The text the shell runs, level by level: substitutions are checked as their
 * own text and a quoted here-document body (data) is left out. A body or
 * here-string is code when a shell or interpreter in the command reads it
 * (`sh <<'EOF'`, `cat <<'EOF' | sh`): then the whole command is checked. Falls
 * back to the raw command when the structure cannot be analyzed.
 */
function shellTextForIdentityChecks(command: string): string {
  try {
    const levels = collectShellLevels(command);
    const buildsInput = levels.some((level) => level.codeInputs.length > 0);
    const readsCode = (name: string) => isShellName(name) || isInterpreterName(name);
    if (buildsInput && analyzeBashCommand(command).commands.some((analyzed) => readsCode(analyzed.name))) {
      return command;
    }
    return levels.map((level) => level.text).join("\n");
  } catch {
    // no-cause: unanalyzable text is checked whole, here-doc data included, which only refuses more
    return command;
  }
}

/** Redirect targets that discard output or send it back to the terminal instead of writing a file. */
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Commands that require session scope check on the target argument */
const SESSION_TARGET_COMMANDS = new Set([
  "sessions_send",
  "sessions_ask",
  "sessions_answer",
  "sessions_execute",
  "sessions_inform",
  "sessions_read",
  "sessions_info",
  "sessions_reset",
  "sessions_delete",
  "sessions_rename",
  "sessions_set-display",
  "sessions_set-model",
  "sessions_set-thinking",
  "sessions_set-ttl",
  "sessions_extend",
  "sessions_keep",
]);

interface BashHookOptions {
  getAgentId: () => string | undefined;
  /**
   * Names of the in-process MCP servers this session attached itself. Their
   * tools are part of the runtime: the agent setting that attaches the server
   * is the grant. Every other MCP tool needs `use tool:<name>`.
   */
  hostMcpServers?: readonly string[];
}

/**
 * The Claude runtime ignores a PreToolUse hook that throws and runs the tool.
 * A permission hook therefore turns its own failure into a denial.
 */
function failClosed(name: string, hook: HookCallback): HookCallback {
  return async (input, toolUseId, context) => {
    try {
      return await hook(input, toolUseId, context);
    } catch (error) {
      log.error("Permission hook failed; denying the tool call", { hook: name, tool: input?.tool_name, error });
      return buildPreToolUseDenyResult(
        `Permission denied: Ravi could not check this ${name === "bash" ? "command" : "tool call"} because its permission check failed.`,
      );
    }
  };
}

/** The server behind a denied MCP tool, for the denial record. Its text is untrusted. */
function describeMcpServer(server: PreToolUseHookInput["mcp_server"]): { name: string; source: string } | undefined {
  if (!server || typeof server.name !== "string" || typeof server.source !== "string") return undefined;
  return { name: server.name.slice(0, 128), source: server.source.slice(0, 32) };
}

/**
 * True only for a tool of an in-process server the host registered. The
 * `mcp__<server>__` prefix proves nothing: a server from the runtime's own
 * configuration may reuse the name, and both then answer under that prefix.
 * The provenance decides, and only for an MCP tool name: a built-in tool is
 * never exempt, whatever arrives beside it.
 */
function isHostMcpTool(
  input: PreToolUseHookInput,
  toolName: string,
  hostMcpServers: readonly string[] | undefined,
): boolean {
  const server = input.mcp_server;
  if (!server || !hostMcpServers || hostMcpServers.length === 0) return false;
  if (!toolName.startsWith("mcp__")) return false;
  return server.source === "sdk" && typeof server.name === "string" && hostMcpServers.includes(server.name);
}

/**
 * A name under a host server's prefix that arrived without provenance: the
 * Claude Code that ran the call is too old to report it (a remote-spawn host, a
 * replaced executable). The call is checked like any other tool; this only
 * lets the denial say why a host tool was refused.
 */
function isUnattributedHostMcpName(
  input: PreToolUseHookInput,
  toolName: string,
  hostMcpServers: readonly string[] | undefined,
): boolean {
  if (input.mcp_server !== undefined || !hostMcpServers) return false;
  return hostMcpServers.some((name) => toolName.startsWith(`mcp__${name}__`));
}

export interface BashPermissionContext {
  contextId?: string;
  context?: ContextRecord;
  agentId?: string;
  kind?: string | null;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
  capabilities?: ContextCapability[];
  metadata?: Record<string, unknown> | null;
  /** The shell's starting directory, which relative redirect targets resolve against. */
  cwd?: string;
}

/**
 * Named shell-policy refusals. `unknown_parse`: the analyzer could not model the
 * command. `shell_launcher`: a launcher (xargs, find -exec, env, timeout, ...)
 * would start a shell or interpreter. `untrusted_executable_path`: the real
 * binary is outside trusted directories. `execution_override`: the command
 * changes which program runs (PATH, loader, git hooks/config).
 */
export type BashSyntaxRule =
  | "restricted_syntax"
  | "unparseable_command"
  | "indirect_execution"
  | "unknown_parse"
  | "shell_launcher"
  | "untrusted_executable_path"
  | "execution_override";

export interface BashPermissionDecision {
  allowed: boolean;
  reason?: string;
  denialType?: "env_spoofing" | "executable" | "session_scope" | "shell_syntax";
  syntaxRule?: BashSyntaxRule;
  toolName?: string | null;
  deniedCapabilities?: Array<{ relation: string; objectType: string; objectId: string }>;
  /** The guard's own failure, when the refusal comes from a defect rather than a rule. */
  cause?: unknown;
}

function hasContextCapabilities(ctx: BashPermissionContext): ctx is BashPermissionContext & {
  capabilities: ContextCapability[];
} {
  return Array.isArray(ctx.capabilities);
}

function canWithBashContext(
  ctx: BashPermissionContext,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  // A person who can grant it approved this capability for this context (the
  // approval service adds it with `source: "approval"`). It holds for that
  // context whatever the agent's ceiling says: otherwise an approved command is
  // asked for, approved, and still refused.
  if (hasApprovalGrant(ctx, permission, objectType, objectId)) return true;
  // Resolved agent-identity / delegated turns use the live executor ceiling so
  // `ravi agents permissions` expansions and reductions apply on the next
  // PreToolUse check without requiring a session reset. Unresolved actors and
  // observation-narrowed turns stay bound to the issued snapshot. User-overlay
  // turns need both: the snapshot holds agent ∩ contact chat grants, and the
  // live ceiling may only narrow it further.
  if (canUseLiveExecutorCeiling(ctx)) {
    // A person's turn in an ungoverned chat carries `deny_*` entries for the
    // agent's break-glass the person does not hold; the live ceiling must not
    // reopen them (no system admin, no arbitrary commands).
    if (hasContextCapabilities(ctx) && isWithheldByDeny(ctx.capabilities, permission, objectType, objectId)) {
      return false;
    }
    if (isUserOverlayTurn(ctx)) {
      return (
        hasContextCapabilities(ctx) &&
        canWithCapabilityContext(ctx, permission, objectType, objectId) &&
        canWithMaterializedAgentCapabilities(ctx, permission, objectType, objectId)
      );
    }
    return canWithMaterializedAgentCapabilities(ctx, permission, objectType, objectId);
  }
  // Every other issued context (root or derived child such as `cli-runtime`
  // or `app-runtime`) is bounded by its own capabilities. Falling back to the
  // agent's materialized grants would let a narrowed child of a superadmin
  // agent exceed what it was issued.
  if (hasContextCapabilities(ctx)) {
    return canWithCapabilityContext(ctx, permission, objectType, objectId);
  }
  // No issued context at all (nothing to narrow): use the agent's own grants.
  if (ctx.agentId) {
    return canWithMaterializedAgentCapabilities(ctx, permission, objectType, objectId);
  }
  return false;
}

function hasApprovalGrant(
  ctx: BashPermissionContext,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  const approved = (ctx.capabilities ?? []).filter((capability) => capability.source === "approval");
  return approved.length > 0 && canWithCapabilities(approved, permission, objectType, objectId);
}

function isDelegatedBashContext(ctx: Pick<BashPermissionContext, "kind" | "metadata">): boolean {
  if (ctx.kind === "turn-runtime" || ctx.kind === "invocation-runtime") return true;
  return ctx.metadata?.authorityMode === "delegated" || ctx.metadata?.authorityMode === "agent-identity";
}

function canUseLiveExecutorCeiling(ctx: BashPermissionContext): boolean {
  if (!ctx.agentId) return false;
  // Owner authority: the turn carries the owner's own power, not the agent's ceiling
  // (`permissions/owner-authority`); the issued snapshot is the bound.
  if (typeof ctx.metadata?.ownerAuthority === "string") return false;
  if (!isDelegatedBashContext(ctx)) return false;
  if (isUnresolvedAgentIdentityActor(ctx)) return false;
  if (hasTurnCapabilityNarrowing(ctx)) return false;
  return true;
}

function isUnresolvedAgentIdentityActor(ctx: Pick<BashPermissionContext, "metadata">): boolean {
  return ctx.metadata?.actorResolution === "missing_contact";
}

function isUserOverlayTurn(ctx: Pick<BashPermissionContext, "metadata">): boolean {
  return ctx.metadata?.actorAuthorizationMode === "user-overlay";
}

function hasTurnCapabilityNarrowing(ctx: Pick<BashPermissionContext, "metadata">): boolean {
  if (ctx.metadata?.relayNarrowing === true) return true;
  const count = ctx.metadata?.turnCapabilityCount;
  if (typeof count === "number" && count > 0) return true;
  return Array.isArray(ctx.metadata?.turnCapabilities) && ctx.metadata.turnCapabilities.length > 0;
}

function canWithMaterializedAgentCapabilities(
  ctx: Pick<BashPermissionContext, "agentId">,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (!ctx.agentId) return false;
  return canWithCapabilities(materializeSubjectCapabilities("agent", ctx.agentId), permission, objectType, objectId);
}

function isSuperadminContext(ctx: BashPermissionContext): boolean {
  return canWithBashContext(ctx, "admin", "system", "*");
}

/** Already-issued arbitrary execution authority, including all context narrowing. */
export function canExecuteArbitraryShell(ctx: BashPermissionContext): boolean {
  return canWithBashContext(ctx, "execute", "executable", "*");
}

/**
 * Environment variables that change which program runs or make a program run
 * other code: the search path, dynamic loaders, shell startup files, pagers,
 * editors and git's command hooks. Assigning them is execution authority.
 */
const EXECUTION_ENV_NAMES = new Set([
  "PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "CDPATH",
  "PAGER",
  "MANPAGER",
  "EDITOR",
  "VISUAL",
  "LESSOPEN",
  "LESSCLOSE",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_PROXY_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
]);

/** Editors git may be told to skip with a command that does nothing. */
const NO_OP_EDITOR_NAMES = new Set(["GIT_EDITOR", "GIT_SEQUENCE_EDITOR"]);
const NO_OP_EDITOR_VALUES = new Set(["true", ":"]);

function isExecutionEnvName(name: string): boolean {
  return EXECUTION_ENV_NAMES.has(name) || /^(?:LD_|DYLD_|GIT_CONFIG_(?:KEY|VALUE)_)/.test(name);
}

/** `git -c` keys that cannot make git run a program. Every other key needs arbitrary execution. */
const SAFE_GIT_CONFIG_KEY =
  /^(?:color\.[\w.-]+|user\.(?:name|email)|core\.(?:quotepath|abbrev|autocrlf|safecrlf)|safe\.directory|advice\.[\w.-]+|init\.defaultbranch|log\.(?:date|decorate|abbrevcommit)|column\.ui|diff\.(?:noprefix|renames|algorithm)|pull\.rebase|push\.default|commit\.gpgsign|tag\.gpgsign|merge\.conflictstyle)$/i;

/** git subcommands/options that hand git a program or shell string to run. */
const GIT_EXECUTION_OPTIONS: Record<string, RegExp> = {
  rebase: /^(?:-x|--exec(?:=.*)?|-x.+)$/,
  difftool: /^(?:-x|--extcmd(?:=.*)?)$/,
  fetch: /^(?:--upload-pack(?:=.*)?)$/,
  pull: /^(?:--upload-pack(?:=.*)?)$/,
  clone: /^(?:-u|--upload-pack(?:=.*)?|--template(?:=.*)?)$/,
  "ls-remote": /^(?:--upload-pack(?:=.*)?)$/,
  push: /^(?:--receive-pack(?:=.*)?|--exec(?:=.*)?)$/,
  archive: /^(?:--exec(?:=.*)?)$/,
  grep: /^(?:-O.*|--open-files-in-pager(?:=.*)?)$/,
};
const GIT_EXECUTING_SUBCOMMANDS: Record<string, (argv: Array<string | null>) => boolean> = {
  bisect: (argv) => argv.includes("run"),
  submodule: (argv) => argv.includes("foreach"),
  "filter-branch": () => true,
  "filter-repo": () => true,
};

/** `git config` options whose value is the next word. */
const GIT_CONFIG_VALUE_OPTIONS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);

/**
 * Why this `git config` can make a later git command run a program, if it can.
 * Storing `core.pager`, `core.fsmonitor` or `alias.x=!cmd` is the same as
 * `git -c` with that key, only persistent. Reads, unsets and keys in
 * {@link SAFE_GIT_CONFIG_KEY} are allowed.
 */
function gitConfigWrite(argv: Array<string | null>): string | undefined {
  const words: string[] = [];
  let reads = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === null) return "git config with a dynamic argument can store a program";
    if (arg === "-e" || arg === "--edit") return "git config --edit runs an editor";
    if (arg === "--rename-section") return "git config --rename-section can turn a section into aliases";
    // Reads, and removals: deleting a key cannot add a program to run.
    if (
      /^--(?:get(?:-all|-regexp|-urlmatch|-color(?:bool)?)?|list|unset(?:-all)?|remove-section)$/.test(arg) ||
      arg === "-l"
    ) {
      reads = true;
      continue;
    }
    if (GIT_CONFIG_VALUE_OPTIONS.has(arg)) {
      index++;
      continue;
    }
    if (arg === "--") {
      words.push(...(argv.slice(index + 1) as Array<string | null>).map((word) => word ?? ""));
      break;
    }
    if (arg.startsWith("-")) continue;
    words.push(arg);
  }
  // git 2.46+ subcommand syntax: `git config get|list|set|unset|...`.
  const [verb] = words;
  if (verb === "get" || verb === "list" || verb === "unset") return undefined;
  if (verb === "edit") return "git config edit runs an editor";
  if (verb === "rename-section") return "git config rename-section can turn a section into aliases";
  const assignment = verb === "set" ? words.slice(1) : words;
  if (reads || assignment.length < 2) return undefined;
  const key = assignment[0]!;
  return SAFE_GIT_CONFIG_KEY.test(key) ? undefined : `git config ${key} can store a program for git to run`;
}

/** Why this git invocation can run an arbitrary program, if it can. */
function gitExecutionOverride(argv: Array<string | null>): string | undefined {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === null) return "git with a dynamic global option";
    if (arg === "-c") {
      const setting = argv[index + 1];
      const key = setting?.split("=")[0];
      if (!key || !SAFE_GIT_CONFIG_KEY.test(key)) return `git -c ${key ?? "<dynamic>"} can run a program`;
      index += 2;
      continue;
    }
    if (arg.startsWith("--config-env") || arg.startsWith("--exec-path")) {
      return `git ${arg.split("=")[0]} can run a program`;
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  const subcommand = argv[index];
  if (typeof subcommand !== "string") return undefined;
  const rest = argv.slice(index + 1);
  if (subcommand === "config") return gitConfigWrite(rest);
  if (GIT_EXECUTING_SUBCOMMANDS[subcommand]?.(rest)) return `git ${subcommand} runs commands it is given`;
  const options = GIT_EXECUTION_OPTIONS[subcommand];
  const offending = options ? rest.find((arg) => arg !== null && options.test(arg)) : undefined;
  return offending ? `git ${subcommand} ${offending.split("=")[0]} runs a program it is given` : undefined;
}

function shellSyntaxDenial(syntaxRule: BashSyntaxRule, reason: string): BashPermissionDecision {
  return { allowed: false, reason, denialType: "shell_syntax", syntaxRule };
}

function unknownParseDenial(detail: string): BashPermissionDecision {
  return shellSyntaxDenial(
    "unknown_parse",
    `Ravi could not analyze this command (unknown_parse): ${detail}. Commands the guard cannot model are refused; split it into simpler commands.`,
  );
}

function checkExecutablePermissionsForContext(command: string, ctx: BashPermissionContext): BashPermissionDecision {
  // The restricted parser bounds named executable grants. It cannot make an
  // already-authorized arbitrary host process safer by refusing its shell form.
  // Environment identity and Ravi session/tool authorization remain separate.
  if (canExecuteArbitraryShell(ctx)) return { allowed: true };

  // Preserve quoting here: the parser distinguishes literal data from active
  // substitutions. stripShellQuoting is for identity text checks, not syntax.
  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    if (patternCheck.code === "unknown_parse") return unknownParseDenial(patternCheck.reason ?? "unsupported syntax");
    return shellSyntaxDenial("restricted_syntax", patternCheck.reason ?? "Command uses restricted shell syntax");
  }

  // Analysis: what runs, from where. Authority is decided below, never in the parser.
  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    if (parsed.code === "unknown_parse") return unknownParseDenial(parsed.error ?? "unsupported syntax");
    return shellSyntaxDenial("unparseable_command", parsed.error || "Failed to parse command");
  }
  const commands = parsed.commands ?? [];

  const BUILTIN_EXECUTABLES = new Set(["ravi"]);
  const blocked: string[] = [];

  // 1. Executable identity: the real binary, not the basename the agent typed.
  //    `/tmp/p/git` is checked as the file it is, before its name means anything.
  const changesDirectory = commands.some((analyzed) => ["cd", "pushd", "popd"].includes(analyzed.name));
  for (const analyzed of commands) {
    const pathCheck = checkExecutablePath(analyzed.word, { cwd: ctx.cwd, changesDirectory });
    if (!pathCheck.ok) {
      return shellSyntaxDenial(
        pathCheck.rule,
        `Restricted shell policy does not allow this executable: ${pathCheck.reason}.`,
      );
    }
  }

  // 2. Launchers: a shell or interpreter behind xargs/find -exec/env/timeout/...
  //    is arbitrary execution, whatever grants the launcher and payload have.
  for (const analyzed of commands) {
    if (analyzed.launchesShellString) {
      return shellSyntaxDenial(
        "shell_launcher",
        `Restricted shell policy does not allow ${analyzed.name}: ${analyzed.launchesShellString}. This needs arbitrary execution authority (execute:executable:*).`,
      );
    }
    // A shell behind a launcher is always arbitrary execution. A non-shell
    // interpreter (`timeout 120 bun test`, `nohup bun run dev`) is no more than
    // running it directly: its own grant decides below, and inline code is
    // already refused. Arguments read from xargs input can be `-c code`, so
    // an interpreter that receives them stays refused.
    const launchedInterpreter = isInterpreterName(analyzed.name) && analyzed.openArgs === true;
    if (analyzed.origin === "launcher" && (isShellName(analyzed.name) || launchedInterpreter)) {
      return shellSyntaxDenial(
        "shell_launcher",
        `Restricted shell policy does not allow ${analyzed.launcher} to launch the interpreter ${analyzed.name}. This needs arbitrary execution authority (execute:executable:*).`,
      );
    }
  }

  // 3. Shells, eval and source anywhere in the command.
  for (const exec of parsed.executables) {
    if (UNCONDITIONAL_BLOCKS.has(exec)) {
      blocked.push(exec);
    }
  }

  if (blocked.length > 0) {
    return shellSyntaxDenial(
      "indirect_execution",
      `Restricted shell policy does not allow indirect execution through: ${blocked.join(", ")}`,
    );
  }

  // 4. Settings that change which program runs: PATH, loaders, git config/hooks.
  // `GIT_EDITOR=true git rebase --continue` is the required non-interactive
  // form: an editor that is `true` or `:` runs nothing. Any other value, or a
  // value set through env/sudo/export, stays an override.
  const override = (parsed.assignmentValues ?? (parsed.assignments ?? []).map((name) => ({ name, value: null })))
    .filter(
      ({ name, value }) =>
        isExecutionEnvName(name) && !(NO_OP_EDITOR_NAMES.has(name) && value !== null && NO_OP_EDITOR_VALUES.has(value)),
    )
    .map(({ name }) => name)[0];
  if (override) {
    return shellSyntaxDenial(
      "execution_override",
      `Restricted shell policy does not allow setting ${override}: it changes which program runs. This needs arbitrary execution authority (execute:executable:*).`,
    );
  }
  for (const analyzed of commands) {
    if (analyzed.name !== "git") continue;
    // `printf -- '-c core.pager=id log' | xargs git`: the options git runs with
    // are read at run time, so the checks below cannot see them.
    const gitOverride = analyzed.openArgs
      ? `git with arguments ${analyzed.launcher ?? "its launcher"} reads from its input`
      : gitExecutionOverride(analyzed.argv);
    if (gitOverride) {
      return shellSyntaxDenial(
        "execution_override",
        `Restricted shell policy does not allow ${gitOverride}. This needs arbitrary execution authority (execute:executable:*).`,
      );
    }
  }

  // An allowed executable plus `> file` is a file write: `ravi crypto status > ~/.ravi/crypto.db`
  // would wipe the ledger. Restricted agents may only discard output unless they can write files anyway.
  let levels: ShellLevel[];
  try {
    levels = collectShellLevels(command);
  } catch (error) {
    // Unreachable after checkDangerousPatterns, which analyzes the same text; still a verdict, never an allow.
    return unknownParseDenial(error instanceof Error ? error.message : "unsupported syntax");
  }
  const redirects = analyzeRedirectsAcrossLevels(levels, ctx.cwd, changesDirectory);
  if (redirects.error) {
    return {
      allowed: false,
      reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot redirect output to files: ${redirects.error}`,
      deniedCapabilities: canWithBashContext(ctx, "use", "tool", "Write")
        ? [{ relation: "execute", objectType: "executable", objectId: "*" }]
        : [{ relation: "use", objectType: "tool", objectId: "Write" }],
    };
  }
  const fileWrites = redirects.writes.filter((write) => !HARMLESS_REDIRECT_TARGETS.has(write.target));
  const configWriteDenial = fileWrites
    .flatMap((write) =>
      write.cwds.map((cwd) =>
        providerConfigWriteDenial({
          can: (permission, objectType, objectId) => canWithBashContext(ctx, permission, objectType, objectId),
          agentId: ctx.agentId,
          targets: [write.target],
          cwd,
          restrictToWorkspace: isActorBreakGlassLimited(ctx),
        }),
      ),
    )
    .find(Boolean);
  if (configWriteDenial) {
    return {
      allowed: false,
      reason: configWriteDenial,
      deniedCapabilities: [{ relation: "execute", objectType: "executable", objectId: "*" }],
    };
  }
  if (fileWrites.length > 0 && !canWithBashContext(ctx, "use", "tool", "Write")) {
    return {
      allowed: false,
      reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot redirect output to files (${fileWrites.map((write) => write.target).join(", ")})`,
      deniedCapabilities: [{ relation: "use", objectType: "tool", objectId: "Write" }],
    };
  }

  for (const exec of parsed.executables) {
    if (BUILTIN_EXECUTABLES.has(exec)) continue;

    if (!canWithBashContext(ctx, "execute", "executable", exec)) {
      blocked.push(exec);
    }
  }

  if (blocked.length > 0) {
    return {
      allowed: false,
      reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot execute: ${blocked.join(", ")}`,
      deniedCapabilities: blocked.map((executable) => ({
        relation: "execute",
        objectType: "executable",
        objectId: executable,
      })),
    };
  }

  return { allowed: true };
}

/**
 * Output redirects at every level: a `> file` inside `$(...)` or a here-doc
 * substitution writes a file too. Nested levels start in the outer working
 * directory, so a directory change anywhere makes their targets unknowable.
 */
function analyzeRedirectsAcrossLevels(
  levels: ShellLevel[],
  cwd: string | undefined,
  changesDirectory: boolean,
): { writes: ShellOutputRedirect[]; error?: string } {
  const writes: ShellOutputRedirect[] = [];
  for (const level of levels) {
    const result = analyzeOutputRedirects(level.text, cwd);
    writes.push(...result.writes);
    if (result.error) return { writes, error: result.error };
    if (level.depth > 0 && result.writes.length > 0 && changesDirectory) {
      return { writes, error: "Cannot resolve output redirects inside a substitution after a directory change" };
    }
  }
  return { writes };
}

function canAccessSessionWithBashContext(ctx: BashPermissionContext, targetNameOrKey: string): boolean {
  if (!ctx.agentId && !hasContextCapabilities(ctx)) return true;

  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  return canWithBashContext(ctx, "access", "session", targetNameOrKey);
}

/** `sessions answer` options that take a value; every other `--flag` is a boolean. */
const ANSWER_VALUE_OPTIONS = new Set(["--channel", "--to", "--barrier"]);

/**
 * The asker named by `ravi sessions answer`, read the way the CLI reads it: options may
 * come before the target, with or without a value. Null when the line cannot be read.
 */
function extractAnswerTarget(command: string): string | null {
  const match = command.match(/(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+sessions\s+answer\b(.*)$/s);
  if (!match) return null;
  const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      if (!token.includes("=") && ANSWER_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    return token.replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

/** An open Ask from the answered session to this one: it authorizes this answer and nothing else. */
function answersOpenAsk(command: string, ctx: BashPermissionContext): boolean {
  const target = extractAnswerTarget(command);
  return Boolean(target && findOpenAskGrant(target, ctx.sessionKey));
}

function checkScopePermissionForContext(
  command: string,
  toolName: string | null,
  ctx: BashPermissionContext,
): { allowed: boolean; reason?: string; deniedCapabilities?: BashPermissionDecision["deniedCapabilities"] } {
  if (!toolName) return { allowed: true };

  if (SESSION_TARGET_COMMANDS.has(toolName)) {
    const target = extractRaviTarget(command);
    if (
      target &&
      !canAccessSessionWithBashContext(ctx, target) &&
      !(toolName === "sessions_answer" && answersOpenAsk(command, ctx))
    ) {
      // An open Ask from the target to this session lets it answer that Ask, and only
      // answer: read, recap, send and the rest still need access to the session.
      return {
        allowed: false,
        reason: `Permission denied: agent:${ctx.agentId ?? "unknown"} cannot access session:${target}`,
        deniedCapabilities: [{ relation: "access", objectType: "session", objectId: target }],
      };
    }
  }

  return { allowed: true };
}

export function buildPreToolUseDenyResult(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function emitBashDeniedAudit(
  command: string,
  decision: BashPermissionDecision,
  agentId?: string,
  ctx?: BashPermissionContext,
): void {
  const event = buildBashDeniedAuditEvent(command, decision, agentId, ctx);
  if (!event) {
    return;
  }

  emitPermissionDeniedAudit(event);
}

function recordAndEmitBashPermissionDenial(
  command: string,
  decision: BashPermissionDecision,
  ctx: BashPermissionContext,
  agentId?: string,
): void {
  if (decision.allowed) return;
  if (decision.denialType === "env_spoofing") {
    emitBashDeniedAudit(command, decision, agentId, ctx);
    return;
  }
  const subjectId = agentId ?? ctx.agentId;
  if (!subjectId) {
    emitBashDeniedAudit(command, decision, agentId, ctx);
    return;
  }
  const provenance = buildAuditContextProvenance(ctx);
  const audit = buildBashDeniedAuditEvent(command, decision, agentId, ctx);
  if (!audit) return;

  for (const denied of decision.deniedCapabilities ?? []) {
    recordAndEmitPermissionDenial({
      subjectType: "agent",
      subjectId,
      agentId: subjectId,
      sessionKey: ctx.sessionKey,
      sessionName: ctx.sessionName,
      contextId: ctx.contextId ?? ctx.context?.contextId,
      relation: denied.relation,
      objectType: denied.objectType,
      objectId: denied.objectId,
      reason: decision.reason,
      command: `[REDACTED:content length=${command.length}]`,
      detail: provenance ? { context: provenance } : undefined,
      audit,
    });
  }

  if ((decision.deniedCapabilities ?? []).length === 0) {
    emitPermissionDeniedAudit(audit);
  }
}

export function evaluateBashPermission(command: string, ctx: BashPermissionContext = {}): BashPermissionDecision {
  // An exception here must never reach a caller as "no decision": the SDK hook
  // and the runtime command authorizer both treat a thrown guard as unknown.
  try {
    return decideBashPermission(command, ctx);
  } catch (error) {
    return guardFailureDenial(error);
  }
}

/** A defect in the guard is a refusal with the defect as its cause, never an allow. */
function guardFailureDenial(error: unknown): BashPermissionDecision {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ...unknownParseDenial(`the guard failed while checking it (${detail})`),
    cause: error,
  };
}

function decideBashPermission(command: string, ctx: BashPermissionContext): BashPermissionDecision {
  const isSuperadmin = isSuperadminContext(ctx);
  const spoofResult = isSuperadmin ? { allowed: true } : checkEnvSpoofing(shellTextForIdentityChecks(command));
  if (!spoofResult.allowed) {
    return {
      allowed: false,
      reason: spoofResult.reason,
      denialType: "env_spoofing",
    };
  }

  const execResult = checkExecutablePermissionsForContext(command, ctx);
  if (!execResult.allowed) {
    return {
      allowed: false,
      reason: execResult.reason,
      denialType: execResult.denialType ?? "executable",
      ...(execResult.syntaxRule ? { syntaxRule: execResult.syntaxRule } : {}),
      deniedCapabilities: execResult.deniedCapabilities,
    };
  }

  const toolName = extractRaviToolName(command);
  const scopeResult = checkScopePermissionForContext(command, toolName, ctx);
  if (!scopeResult.allowed) {
    return {
      allowed: false,
      reason: scopeResult.reason,
      denialType: "session_scope",
      toolName,
      deniedCapabilities: scopeResult.deniedCapabilities,
    };
  }

  return {
    allowed: true,
    toolName,
  };
}

/**
 * Create a bash permission hook for the SDK.
 *
 * Validates:
 * 1. Env spoofing (RAVI_* override)
 * 2. Executable permissions
 * 3. Session scope
 */
export function createBashPermissionHook(options: BashHookOptions): HookCallbackMatcher {
  const bashPermissionHook: HookCallback = async (input, _toolUseId, _context) => {
    const command = input.tool_input?.command as string | undefined;

    if (!command) {
      return {};
    }

    const agentId = options.getAgentId();
    const scopeCtx = getScopeContext();
    const bashContext = {
      agentId,
      contextId: scopeCtx.contextId,
      context: scopeCtx.context,
      kind: scopeCtx.context?.kind,
      sessionKey: scopeCtx.sessionKey,
      sessionName: scopeCtx.sessionName,
      source: scopeCtx.source,
      capabilities: scopeCtx.context?.capabilities,
      metadata: scopeCtx.context?.metadata,
      ...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
    };
    const decision = evaluateBashPermission(command, bashContext);

    if (!decision.allowed) {
      log.warn("Bash command blocked", {
        commandChars: command.length,
        reason: decision.reason,
        denialType: decision.denialType,
      });
      recordAndEmitBashPermissionDenial(command, decision, bashContext, agentId);
      return buildPreToolUseDenyResult(decision.reason ?? "Bash command denied by Ravi policy");
    }

    log.debug("Bash command allowed", {
      commandChars: command.length,
      raviTool: decision.toolName,
    });

    // Observação de intenção (ex.: uso de `gh` vira acompanhamento de PR). Roda
    // depois do "pode rodar", nunca decide nada, e é o mesmo ponto para todos os
    // runtimes que passam pelo hook in-process.
    if (command.includes("gh")) {
      const { observeGhBashCommand } = await import("../hooks/gh-watch.js");
      await observeGhBashCommand(command, {
        agentId: bashContext.agentId,
        sessionKey: bashContext.sessionKey,
        sessionName: bashContext.sessionName,
        source: bashContext.source,
      });
    }

    return {};
  };

  return {
    // The Claude runtime also runs `Bash`-matched hooks, with a Bash-shaped
    // input, for the shell command of its Monitor tool. Keep this matcher: a
    // hook without one sees that call only under the tool's own name.
    matcher: "Bash",
    hooks: [failClosed("bash", bashPermissionHook)],
  };
}

/**
 * Create a tool permission hook for the SDK.
 *
 * Intercepts ALL tool calls and checks via the Permission Provider Runtime.
 * This ensures permission changes take effect immediately without
 * needing to restart the session.
 *
 * Every tool name is checked against `use tool:<name>`: built-in tools, tools
 * of MCP servers the runtime loaded from its own configuration or plugins
 * (`mcp__<server>__<tool>`), and tools a newer runtime adds. A list of known
 * names is not consulted, because a name outside it would run unchecked.
 */
export function createToolPermissionHook(options: BashHookOptions): HookCallbackMatcher {
  const toolPermissionHook: HookCallback = async (input) => {
    const agentId = options.getAgentId();
    const toolName = input.tool_name;
    if (typeof toolName !== "string" || !toolName) {
      return buildPreToolUseDenyResult("Permission denied: a tool call without a tool name cannot be checked");
    }

    if (isHostMcpTool(input, toolName, options.hostMcpServers)) return {};

    if (!agentId) {
      const reason = `Permission denied: missing agent identity cannot use tool:${toolName}`;
      const mcpServer = describeMcpServer(input.mcp_server);
      log.warn("Tool blocked without agent identity", { tool: toolName, ...(mcpServer ? { mcpServer } : {}) });
      emitPermissionDeniedAudit({
        type: "tool",
        agentId: "unknown",
        denied: `tool:${toolName}`,
        reason,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }

    const scopeCtx = getScopeContext();
    const bashContext = {
      agentId,
      contextId: scopeCtx.contextId,
      context: scopeCtx.context,
      kind: scopeCtx.context?.kind,
      sessionKey: scopeCtx.sessionKey,
      sessionName: scopeCtx.sessionName,
      source: scopeCtx.source,
      capabilities: scopeCtx.context?.capabilities,
      metadata: scopeCtx.context?.metadata,
    };

    // This is an exception for this invocation, never a Bash grant.
    const trustedAppCall =
      toolName === "Bash" &&
      typeof input.tool_input?.command === "string" &&
      authorizeRestrictedAppCommand(input.tool_input.command, scopeCtx.context, {
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      }).approved;
    // Check whether the agent can use this tool.
    if (!trustedAppCall && !canWithBashContext(bashContext, "use", "tool", toolName)) {
      const provenance = buildAuditContextProvenance(scopeCtx);
      const mcpServer = describeMcpServer(input.mcp_server);
      const unattributedHostTool = isUnattributedHostMcpName(input, toolName, options.hostMcpServers);
      const reason = `Permission denied: agent:${agentId} cannot use tool:${toolName}${
        unattributedHostTool
          ? ". The runtime did not report which MCP server owns this tool, so it is checked like a tool of a configured server"
          : ""
      }`;
      log.warn("Tool blocked", {
        agentId,
        tool: toolName,
        ...(mcpServer ? { mcpServer } : {}),
        ...(unattributedHostTool ? { unattributedHostTool } : {}),
      });
      recordAndEmitPermissionDenial({
        subjectType: "agent",
        subjectId: agentId,
        agentId,
        sessionKey: scopeCtx.sessionKey,
        sessionName: scopeCtx.sessionName,
        contextId: scopeCtx.contextId,
        relation: "use",
        objectType: "tool",
        objectId: toolName,
        reason,
        detail:
          provenance || mcpServer
            ? { ...(provenance ? { context: provenance } : {}), ...(mcpServer ? { mcpServer } : {}) }
            : undefined,
        audit: {
          type: "tool",
          agentId,
          denied: `tool:${toolName}`,
          reason,
          ...(provenance ? { context: provenance } : {}),
        },
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }

    const configWriteDenial = providerConfigWriteDenial({
      can: (permission, objectType, objectId) => canWithBashContext(bashContext, permission, objectType, objectId),
      agentId,
      targets: fileWriteToolTargets(toolName, input.tool_input),
      cwd: input.cwd,
      restrictToWorkspace: isActorBreakGlassLimited(bashContext),
    });
    if (configWriteDenial) {
      log.warn("Tool blocked: provider settings write", { agentId, tool: toolName });
      emitPermissionDeniedAudit({ type: "tool", agentId, denied: `tool:${toolName}`, reason: configWriteDenial });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: configWriteDenial,
        },
      };
    }

    return {};
  };

  return {
    // No matcher = fires for ALL tools
    hooks: [failClosed("tool", toolPermissionHook)],
  };
}

export type { HookCallbackMatcher };
