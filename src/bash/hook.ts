/**
 * Bash Permission Hook
 *
 * SDK PreToolUse hook that intercepts Bash tool calls
 * and validates them against REBAC permissions.
 *
 * Layers:
 * 1. Env spoofing check (RAVI_* override)
 * 2. Executable permissions (via REBAC: execute executable:<name>)
 * 3. Session scope (via REBAC: access session:<name>)
 *
 * Note: ravi CLI group-level scope (execute group:<name>) is handled by
 * enforceScopeCheck() in the CLI process, not here.
 */

import { publish } from "../nats.js";
import { checkDangerousPatterns, parseBashCommand, UNCONDITIONAL_BLOCKS } from "./parser.js";
import { logger } from "../utils/logger.js";
import { getScopeContext, canAccessSession } from "../permissions/scope.js";
import { agentCan, canWithCapabilityContext } from "../permissions/engine.js";
import { recordPermissionDenial } from "../permissions/denials.js";
import { buildAuditContextProvenance, type AuditContextProvenance } from "../permissions/audit-provenance.js";
import { SDK_TOOLS } from "../cli/tool-registry.js";
import type { ContextCapability, ContextRecord, ContextSource } from "../router/router-db.js";

const log = logger.child("bash:hook");

/**
 * Emit an audit event via NATS (fire-and-forget).
 */
function emitAudit(event: {
  type: string;
  agentId: string;
  denied: string;
  reason: string;
  detail?: string;
  dedupeKey?: string;
  context?: AuditContextProvenance;
}): void {
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;
  publish("ravi.audit.denied", {
    ...event,
    dedupeKey: event.dedupeKey ?? buildAuditDeniedDedupeKey(event),
  } as unknown as Record<string, unknown>).catch(() => {});
}

function buildAuditDeniedDedupeKey(event: { type: string; agentId: string; denied: string; reason: string }): string {
  return ["audit.denied", event.type, event.agentId, event.denied, event.reason].map(normalizeDedupePart).join(":");
}

function normalizeDedupePart(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

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
  detail?: string;
  context?: AuditContextProvenance;
} | null {
  if (decision.allowed || !decision.denialType) {
    return null;
  }

  const resolvedAgentId = agentId ?? "unknown";
  const detail = command.slice(0, 200);
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

/**
 * Check if a command attempts to override RAVI_* env vars (identity/config spoofing).
 * Blocks ALL RAVI_* env var overrides for non-superadmin agents.
 */
function checkEnvSpoofing(command: string): { allowed: boolean; reason?: string } {
  if (/\bRAVI_\w+\s*=/.test(command)) {
    return {
      allowed: false,
      reason: "Cannot override RAVI environment variables",
    };
  }
  return { allowed: true };
}

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
}

export interface BashPermissionDecision {
  allowed: boolean;
  reason?: string;
  denialType?: "env_spoofing" | "executable" | "session_scope";
  toolName?: string | null;
  deniedCapabilities?: Array<{ relation: string; objectType: string; objectId: string }>;
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
  if (hasContextCapabilities(ctx)) {
    return canWithCapabilityContext(ctx, permission, objectType, objectId);
  }
  return agentCan(ctx.agentId, permission, objectType, objectId);
}

function isSuperadminContext(ctx: BashPermissionContext): boolean {
  return canWithBashContext(ctx, "admin", "system", "*");
}

function checkExecutablePermissionsForContext(
  command: string,
  ctx: BashPermissionContext,
): { allowed: boolean; reason?: string; deniedCapabilities?: BashPermissionDecision["deniedCapabilities"] } {
  if (canWithBashContext(ctx, "execute", "executable", "*")) {
    return { allowed: true };
  }

  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    return { allowed: false, reason: patternCheck.reason };
  }

  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    return { allowed: false, reason: parsed.error || "Failed to parse command" };
  }

  const BUILTIN_EXECUTABLES = new Set(["ravi"]);
  const blocked: string[] = [];

  for (const exec of parsed.executables) {
    if (UNCONDITIONAL_BLOCKS.has(exec)) {
      blocked.push(exec);
      continue;
    }

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

function canAccessSessionWithBashContext(ctx: BashPermissionContext, targetNameOrKey: string): boolean {
  if (!ctx.agentId && !hasContextCapabilities(ctx)) return true;

  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  if (!hasContextCapabilities(ctx)) {
    return canAccessSession(
      {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        sessionName: ctx.sessionName,
      },
      targetNameOrKey,
    );
  }

  return canWithCapabilityContext(ctx, "access", "session", targetNameOrKey);
}

function checkScopePermissionForContext(
  command: string,
  toolName: string | null,
  ctx: BashPermissionContext,
): { allowed: boolean; reason?: string; deniedCapabilities?: BashPermissionDecision["deniedCapabilities"] } {
  if (!toolName) return { allowed: true };

  if (SESSION_TARGET_COMMANDS.has(toolName)) {
    const target = extractRaviTarget(command);
    if (target && !canAccessSessionWithBashContext(ctx, target)) {
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

  emitAudit(event);
}

function recordBashPermissionDenial(
  command: string,
  decision: BashPermissionDecision,
  ctx: BashPermissionContext,
  agentId?: string,
): void {
  if (decision.allowed || decision.denialType === "env_spoofing") return;
  const subjectId = agentId ?? ctx.agentId;
  if (!subjectId) return;
  const provenance = buildAuditContextProvenance(ctx);

  for (const denied of decision.deniedCapabilities ?? []) {
    recordPermissionDenial({
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
      command,
      detail: provenance ? { context: provenance } : undefined,
    });
  }
}

export function evaluateBashPermission(command: string, ctx: BashPermissionContext = {}): BashPermissionDecision {
  const isSuperadmin = isSuperadminContext(ctx);
  const spoofResult = isSuperadmin ? { allowed: true } : checkEnvSpoofing(command);
  if (!spoofResult.allowed) {
    return {
      allowed: false,
      reason: spoofResult.reason,
      denialType: "env_spoofing",
    };
  }

  if (ctx.agentId || hasContextCapabilities(ctx)) {
    const execResult = checkExecutablePermissionsForContext(command, ctx);
    if (!execResult.allowed) {
      return {
        allowed: false,
        reason: execResult.reason,
        denialType: "executable",
        deniedCapabilities: execResult.deniedCapabilities,
      };
    }
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
 * 2. Executable permissions (via REBAC)
 * 3. Session scope (via REBAC)
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
    };
    const decision = evaluateBashPermission(command, bashContext);

    if (!decision.allowed && decision.denialType === "env_spoofing") {
      log.warn("Env spoofing blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId, bashContext);
      recordBashPermissionDenial(command, decision, bashContext, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    if (!decision.allowed && decision.denialType === "executable") {
      log.warn("Executable blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId, bashContext);
      recordBashPermissionDenial(command, decision, bashContext, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    if (!decision.allowed && decision.denialType === "session_scope") {
      log.warn("Scope check blocked", {
        command: command.slice(0, 200),
        reason: decision.reason,
      });
      emitBashDeniedAudit(command, decision, agentId, bashContext);
      recordBashPermissionDenial(command, decision, bashContext, agentId);

      return buildPreToolUseDenyResult(decision.reason!);
    }

    log.debug("Bash command allowed", {
      command: command.slice(0, 100),
      raviTool: decision.toolName,
    });

    return {};
  };

  return {
    matcher: "Bash",
    hooks: [bashPermissionHook],
  };
}

/**
 * Create a tool permission hook for the SDK.
 *
 * Intercepts ALL tool calls and checks via REBAC in real-time.
 * This ensures permission changes take effect immediately without
 * needing to restart the session.
 */
export function createToolPermissionHook(options: BashHookOptions): HookCallbackMatcher {
  const toolPermissionHook: HookCallback = async (input) => {
    const agentId = options.getAgentId();
    if (!agentId) return {};

    const toolName = input.tool_name;
    if (!toolName) return {};

    // Only check SDK built-in tools — MCP tools and CLI tools are not gated here
    if (!SDK_TOOLS.includes(toolName)) return {};

    // Check REBAC: can agent use this tool?
    if (!agentCan(agentId, "use", "tool", toolName)) {
      const scopeCtx = getScopeContext();
      const provenance = buildAuditContextProvenance(scopeCtx);
      const reason = `Permission denied: agent:${agentId} cannot use tool:${toolName}`;
      log.warn("Tool blocked", { agentId, tool: toolName });
      recordPermissionDenial({
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
        detail: provenance ? { context: provenance } : undefined,
      });
      emitAudit({
        type: "tool",
        agentId,
        denied: `tool:${toolName}`,
        reason,
        ...(provenance ? { context: provenance } : {}),
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }

    return {};
  };

  return {
    // No matcher = fires for ALL tools
    hooks: [toolPermissionHook],
  };
}

export type { HookCallbackMatcher };
