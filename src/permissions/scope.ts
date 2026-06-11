/**
 * Scope Isolation Module
 *
 * Central module for verifying agent access to resources.
 * Delegates all permission checks to the REBAC engine.
 */

import { getContext } from "../cli/context.js";
import { agentCan } from "./engine.js";
import { recordPermissionDenial } from "./denials.js";
import { explainPermissionDecision, summarizePermissionGrantState, type ExplainGrantState } from "./explain.js";
import { buildAuditContextProvenance, type AuditContextProvenance } from "./audit-provenance.js";
import { publish, closeNats } from "../nats.js";
import type { ContextRecord, ContextSource } from "../router/router-db.js";
import type { SessionEntry } from "../router/types.js";
import type { ScopeType } from "../cli/decorators.js";

/** Pending audit publishes — flushed before process exits */
const pendingAudits: Promise<void>[] = [];

/**
 * Flush pending audit events and exit the process.
 * Must be called instead of process.exit() when audit events may be in flight.
 */
export async function flushAuditAndExit(code: number): Promise<never> {
  if (pendingAudits.length > 0) {
    await Promise.allSettled(pendingAudits);
    await closeNats();
  }
  process.exit(code);
}

/**
 * Emit an audit event via NATS (fire-and-forget, flushed on exit).
 */
function emitAudit(event: {
  type: string;
  agentId: string;
  denied: string;
  reason: string;
  detail?: string;
  blockType?: string;
  missingPrincipals?: string[];
  missingPrincipalDetails?: MissingPrincipalDetail[];
  recommendedGrantSubjects?: string[];
  command?: string;
  denialId?: number;
  dedupeKey?: string;
  context?: AuditContextProvenance;
}): void {
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;
  const enriched = {
    ...event,
    dedupeKey: event.dedupeKey ?? buildAuditDeniedDedupeKey(event),
  };
  const p = publish("ravi.audit.denied", enriched as unknown as Record<string, unknown>).catch((err) => {
    console.error("[audit] emitAudit failed", err);
  });
  pendingAudits.push(p);
}

function buildAuditDeniedDedupeKey(event: { type: string; agentId: string; denied: string; reason: string }): string {
  return ["audit.denied", event.type, event.agentId, event.denied, event.reason].map(normalizeDedupePart).join(":");
}

function normalizeDedupePart(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

interface ScopeDenialDiagnosis {
  blockType: string;
  detail: string;
  missingPrincipals: string[];
  missingPrincipalDetails: MissingPrincipalDetail[];
  recommendedGrantSubjects: string[];
  grantState?: ExplainGrantState;
  branchStates?: Array<{ branch: string; principal: string | null; state: ExplainGrantState; verdict: string }>;
  nearMissRelations?: unknown[];
  revocationEvents?: unknown[];
}

interface MissingPrincipalDetail {
  branch: "actor" | "surface" | "agent";
  principal: string;
  displayName?: string;
  resolution?: string;
}

function recordScopeDenial(input: {
  ctx: ScopeContext;
  relation: string;
  objectType: string;
  objectId: string;
  reason: string;
  command?: string;
}) {
  const provenance = buildAuditContextProvenance(input.ctx);
  const diagnosis = buildScopeDenialDiagnosis(input, provenance);
  return recordPermissionDenial({
    subjectType: "agent",
    subjectId: input.ctx.agentId,
    agentId: input.ctx.agentId,
    sessionKey: input.ctx.sessionKey,
    sessionName: input.ctx.sessionName,
    contextId: input.ctx.contextId,
    relation: input.relation,
    objectType: input.objectType,
    objectId: input.objectId,
    reason: input.reason,
    command: input.command,
    detail: {
      ...(provenance ? { context: provenance } : {}),
      diagnosis,
    },
  });
}

function scopeAuditMetadata(
  ctx: ScopeContext,
  denial: { id: number } | null | undefined,
  requested: { relation: string; objectType: string; objectId: string },
) {
  const provenance = buildAuditContextProvenance(ctx);
  const diagnosis = buildScopeDenialDiagnosis({ ctx, ...requested }, provenance);
  return {
    ...(denial?.id ? { denialId: denial.id } : {}),
    ...(provenance ? { context: provenance } : {}),
    detail: diagnosis.detail,
    blockType: diagnosis.blockType,
    missingPrincipals: diagnosis.missingPrincipals,
    missingPrincipalDetails: diagnosis.missingPrincipalDetails,
    recommendedGrantSubjects: diagnosis.recommendedGrantSubjects,
  };
}

function buildScopeDenialDiagnosis(
  input: {
    ctx: ScopeContext;
    relation: string;
    objectType: string;
    objectId: string;
  },
  provenance = buildAuditContextProvenance(input.ctx),
): ScopeDenialDiagnosis {
  const target = `${input.objectType}:${input.objectId}`;
  const grant = `${input.relation} ${target}`;
  const missingPrincipals: string[] = [];
  const missingPrincipalDetails: MissingPrincipalDetail[] = [];
  const missingBranches: string[] = [];
  const missingBranchTypes: string[] = [];
  const resolutionHints: string[] = [];
  const grantSummary = buildGrantStateSummary(input, provenance);

  if (provenance?.authorityMode === "delegated") {
    if (provenance.actorCapabilityCount === 0) {
      const principal = provenance.actorPrincipal ?? "actor:<unknown>";
      const displayName = provenance.actorDisplayName;
      const grantSubject = isActionableGrantSubject(principal, provenance.actorResolution) ? principal : null;
      missingPrincipals.push(principal);
      missingPrincipalDetails.push({
        branch: "actor",
        principal,
        ...(displayName ? { displayName } : {}),
        ...(provenance.actorResolution ? { resolution: provenance.actorResolution } : {}),
      });
      missingBranchTypes.push("actor");
      const resolution = provenance.actorResolution === "missing_contact" ? " without a resolved contact" : "";
      missingBranches.push(`actor ${formatPrincipalLabel(principal, displayName)}${resolution} has 0 capabilities`);
      if (!grantSubject && provenance.actorResolution === "missing_contact") {
        resolutionHints.push(`Resolve the actor contact before granting ${grant}`);
      } else if (!grantSubject) {
        resolutionHints.push(`Resolve the actor principal before granting ${grant}`);
      }
    }

    if (missingBranches.length > 0) {
      const uniquePrincipals = uniqueNonEmpty(missingPrincipals);
      const branchLabel = uniqueNonEmpty(missingBranchTypes).sort().join("_");
      const uniqueResolutionHints = uniqueNonEmpty(resolutionHints);
      const grantSubjects = uniquePrincipals.filter((principal) => isActionableGrantSubject(principal));
      const detailParts = [`Delegated scope denied for ${grant}: ${missingBranches.join("; ")}`];
      if (uniqueResolutionHints.length > 0) {
        detailParts.push(uniqueResolutionHints.join(". "));
      }
      if (grantSubjects.length > 0) {
        detailParts.push(`Grant ${grant} to ${grantSubjects.join(", ")}`);
      }
      return {
        blockType: branchLabel ? `delegated_${branchLabel}_capabilities_empty` : "delegated_capabilities_empty",
        detail: `${detailParts.join(". ")}.`,
        missingPrincipals: uniquePrincipals,
        missingPrincipalDetails: dedupeMissingPrincipalDetails(missingPrincipalDetails),
        recommendedGrantSubjects: grantSubjects,
        ...grantSummary,
      };
    }

    if (provenance.effectiveCapabilityCount === 0) {
      return {
        blockType: "delegated_effective_capabilities_empty",
        detail: `Delegated scope denied for ${grant}: effective capability snapshot is empty, but actor/surface counts did not identify a zero branch.`,
        missingPrincipals: [],
        missingPrincipalDetails: [],
        recommendedGrantSubjects: [],
        ...grantSummary,
      };
    }
  }

  const agentPrincipal = input.ctx.agentId ? `agent:${input.ctx.agentId}` : "agent:<unknown>";
  return {
    blockType: "agent_scope_missing_grant",
    detail: `Scope denied for ${grant}: ${agentPrincipal} lacks the required grant.`,
    missingPrincipals: [agentPrincipal],
    missingPrincipalDetails: [{ branch: "agent", principal: agentPrincipal }],
    recommendedGrantSubjects: [agentPrincipal],
    ...grantSummary,
  };
}

function buildGrantStateSummary(
  input: {
    ctx: ScopeContext;
    relation: string;
    objectType: string;
    objectId: string;
  },
  provenance?: AuditContextProvenance,
): Pick<ScopeDenialDiagnosis, "grantState" | "branchStates" | "nearMissRelations" | "revocationEvents"> {
  if (!input.ctx.agentId) return {};
  try {
    const decision = explainPermissionDecision({
      relation: input.relation,
      objectType: input.objectType,
      objectId: input.objectId,
      agentId: input.ctx.agentId,
      actor: provenance?.actorPrincipal ?? null,
      chat: provenance?.surfacePrincipal ?? null,
      sessionKey: input.ctx.sessionKey,
    });
    const summary = summarizePermissionGrantState(decision);
    return {
      grantState: summary.state,
      branchStates: summary.branchStates,
      nearMissRelations: summary.nearMissRelations.slice(0, 10),
      revocationEvents: summary.revocationEvents,
    };
  } catch {
    return {};
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function formatPrincipalLabel(principal: string, displayName?: string): string {
  const cleanName = displayName?.trim();
  return cleanName ? `${cleanName} (${principal})` : principal;
}

function isActionableGrantSubject(principal: string | undefined, resolution?: string): principal is string {
  if (!principal) return false;
  if (resolution === "missing_contact") return false;
  const normalized = principal.trim().toLowerCase();
  return (
    normalized !== "unknown" &&
    normalized !== "actor:<unknown>" &&
    normalized !== "surface:<unknown>" &&
    normalized !== "agent:<unknown>"
  );
}

function dedupeMissingPrincipalDetails(details: MissingPrincipalDetail[]): MissingPrincipalDetail[] {
  const seen = new Set<string>();
  return details.filter((detail) => {
    const key = `${detail.branch}:${detail.principal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Scope Context
// ============================================================================

export interface ScopeContext {
  contextId?: string;
  context?: ContextRecord;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
}

/**
 * Get the current scope context from the CLI context.
 */
export function getScopeContext(): ScopeContext {
  const ctx = getContext();
  return {
    contextId: ctx?.contextId,
    context: ctx?.context,
    agentId: ctx?.agentId ?? process.env.RAVI_AGENT_ID,
    sessionKey: ctx?.sessionKey ?? process.env.RAVI_SESSION_KEY,
    sessionName: ctx?.sessionName ?? process.env.RAVI_SESSION_NAME,
    source: ctx?.source,
  };
}

// ============================================================================
// Core Checks
// ============================================================================

/**
 * Check if scope enforcement is active.
 * Returns false (no enforcement) when:
 * - No agentId in context (CLI direct call, not from agent)
 * - Agent is superadmin (has admin relation)
 */
export function isScopeEnforced(ctx: ScopeContext): boolean {
  if (!ctx.agentId) return false;
  return !agentCan(ctx.agentId, "admin", "system", "*");
}

// ============================================================================
// Session Access
// ============================================================================

/**
 * Check if the current context can access a target session.
 *
 * Access is allowed when:
 * 1. No agent context (CLI direct) → always allowed
 * 2. Target is the agent's own session
 * 3. Agent has 'access' relation on session:<target> (including wildcards)
 */
export function canAccessSession(ctx: ScopeContext, targetNameOrKey: string): boolean {
  if (!ctx.agentId) return true;

  // Own session
  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  return agentCan(ctx.agentId, "access", "session", targetNameOrKey);
}

/**
 * Filter a list of sessions to only those accessible by the current context.
 */
export function filterAccessibleSessions(ctx: ScopeContext, sessions: SessionEntry[]): SessionEntry[] {
  if (!ctx.agentId) return sessions;

  return sessions.filter((s) => {
    const name = s.name ?? s.sessionKey;
    return canAccessSession(ctx, name);
  });
}

/**
 * Check if the current context can modify a session (reset/delete/rename).
 *
 * Allowed when:
 * 1. No agent context → always allowed
 * 2. Target is own session
 * 3. Agent has 'modify' relation on session:<target>
 */
export function canModifySession(ctx: ScopeContext, targetNameOrKey: string): boolean {
  if (!ctx.agentId) return true;

  // Own session
  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  return agentCan(ctx.agentId, "modify", "session", targetNameOrKey);
}

// ============================================================================
// Contact Access
// ============================================================================

/**
 * Check if the current context can access a contact.
 * Delegates to engine: checks read_contact, write_contacts, read_own_contacts, etc.
 */
export function canAccessContact(
  ctx: ScopeContext,
  contact: { tags: string[]; id: string },
  _agentConfig?: unknown,
  contactSessions?: { agentId: string }[],
): boolean {
  if (!ctx.agentId) return true;

  // write_contacts implies read
  if (agentCan(ctx.agentId, "write_contacts", "system", "*")) return true;

  // read_own_contacts: contact has sessions routed to this agent
  if (agentCan(ctx.agentId, "read_own_contacts", "system", "*")) {
    if (contactSessions?.some((s) => s.agentId === ctx.agentId)) return true;
  }

  // read_tagged_contacts: check each tag
  for (const tag of contact.tags) {
    if (agentCan(ctx.agentId, "read_tagged_contacts", "system", tag)) return true;
  }

  // Specific contact relation
  if (agentCan(ctx.agentId, "read_contact", "contact", contact.id)) return true;

  return false;
}

// ============================================================================
// Agent Visibility
// ============================================================================

/**
 * Check if the current context can view a specific agent.
 *
 * Allowed when:
 * 1. No agent context (CLI direct) → always allowed
 * 2. Agent is viewing itself
 * 3. Agent has 'view' relation on agent:<targetId>
 */
export function canViewAgent(ctx: ScopeContext, targetAgentId: string): boolean {
  if (!ctx.agentId) return true;

  // Own agent
  if (ctx.agentId === targetAgentId) return true;

  return agentCan(ctx.agentId, "view", "agent", targetAgentId);
}

/**
 * Filter a list of agents to only those visible by the current context.
 */
export function filterVisibleAgents<T extends { id: string }>(ctx: ScopeContext, agents: T[]): T[] {
  if (!ctx.agentId) return agents;

  return agents.filter((a) => canViewAgent(ctx, a.id));
}

/**
 * Check if the current context can write contacts (add/approve/block/delete).
 */
export function canWriteContacts(ctx: ScopeContext): boolean {
  return agentCan(ctx.agentId, "write_contacts", "system", "*");
}

// ============================================================================
// Resource Access (owned runtime resources)
// ============================================================================

/**
 * Check if the current context can access a resource owned by an agent.
 * Ownership is checked directly (agent_id match), not via relations.
 */
export function canAccessResource(ctx: ScopeContext, resourceAgentId: string | undefined): boolean {
  if (!ctx.agentId) return true;

  // Superadmin
  if (agentCan(ctx.agentId, "admin", "system", "*")) return true;

  // Resource has no owner → only superadmin
  if (!resourceAgentId) return false;

  // Own resource
  return ctx.agentId === resourceAgentId;
}

// ============================================================================
// Decorator Enforcement
// ============================================================================

/**
 * Check if the current context passes the given scope check.
 * Used by registry.ts and tools-export.ts for automatic enforcement.
 *
 * @param scope - The scope type from the decorator
 * @param groupName - The command group name (for "admin" scope → group:<name>)
 * @param commandName - The subcommand name (for granular "admin" scope → group:<name>_<cmd>)
 */
export function enforceScopeCheck(
  scope: ScopeType,
  groupName?: string,
  commandName?: string,
): {
  allowed: boolean;
  errorMessage: string;
} {
  if (scope === "resource") {
    return { allowed: true, errorMessage: "" };
  }

  const ctx = getScopeContext();

  if (scope === "open") {
    if (!ctx.agentId) return { allowed: true, errorMessage: "" };
    const groupAllowed = agentCan(ctx.agentId, "execute", "group", groupName ?? "*");
    const commandAllowed =
      commandName && groupName ? agentCan(ctx.agentId, "execute", "group", `${groupName}_${commandName}`) : false;
    if (groupAllowed || commandAllowed) return { allowed: true, errorMessage: "" };

    const target = commandName && groupName ? `group:${groupName}_${commandName}` : `group:${groupName ?? "*"}`;
    const objectId = commandName && groupName ? `${groupName}_${commandName}` : (groupName ?? "*");
    const reason = `Permission denied: agent:${ctx.agentId} requires execute on ${target}`;
    const denial = recordScopeDenial({
      ctx,
      relation: "execute",
      objectType: "group",
      objectId,
      reason,
      command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
    });
    emitAudit({
      type: "scope",
      agentId: ctx.agentId,
      denied: target,
      reason,
      ...scopeAuditMetadata(ctx, denial, { relation: "execute", objectType: "group", objectId }),
      command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
    });
    return { allowed: false, errorMessage: reason };
  }

  switch (scope) {
    case "superadmin": {
      const allowed = agentCan(ctx.agentId, "admin", "system", "*");
      if (!allowed) {
        const reason = `Permission denied: agent:${ctx.agentId} requires admin on system:*`;
        const denial = recordScopeDenial({
          ctx,
          relation: "admin",
          objectType: "system",
          objectId: "*",
          reason,
          command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
        });
        emitAudit({
          type: "scope",
          agentId: ctx.agentId!,
          denied: "system:*",
          reason,
          ...scopeAuditMetadata(ctx, denial, { relation: "admin", objectType: "system", objectId: "*" }),
          command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
        });
      }
      return {
        allowed,
        errorMessage: allowed ? "" : `Permission denied: agent:${ctx.agentId} requires admin on system:*`,
      };
    }
    case "admin": {
      // Check group-level access first (e.g., execute group:agents)
      const groupAllowed = agentCan(ctx.agentId, "execute", "group", groupName ?? "*");
      if (groupAllowed) return { allowed: true, errorMessage: "" };

      // Check subcommand-level access (e.g., execute group:agents_list)
      if (commandName && groupName) {
        const cmdAllowed = agentCan(ctx.agentId, "execute", "group", `${groupName}_${commandName}`);
        if (cmdAllowed) return { allowed: true, errorMessage: "" };
      }

      const target = commandName && groupName ? `group:${groupName}_${commandName}` : `group:${groupName ?? "*"}`;
      const objectId = commandName && groupName ? `${groupName}_${commandName}` : (groupName ?? "*");
      const reason = `Permission denied: agent:${ctx.agentId} requires execute on ${target}`;
      const denial = recordScopeDenial({
        ctx,
        relation: "execute",
        objectType: "group",
        objectId,
        reason,
        command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
      });
      emitAudit({
        type: "scope",
        agentId: ctx.agentId!,
        denied: target,
        reason,
        ...scopeAuditMetadata(ctx, denial, { relation: "execute", objectType: "group", objectId }),
        command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
      });
      return {
        allowed: false,
        errorMessage: `Permission denied: agent:${ctx.agentId} requires execute on ${target}`,
      };
    }
    case "writeContacts": {
      const wcAllowed = canWriteContacts(ctx);
      if (!wcAllowed) {
        const reason = `Permission denied: agent:${ctx.agentId} requires write_contacts`;
        const denial = recordScopeDenial({
          ctx,
          relation: "write_contacts",
          objectType: "system",
          objectId: "*",
          reason,
          command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
        });
        emitAudit({
          type: "scope",
          agentId: ctx.agentId!,
          denied: "write_contacts",
          reason,
          ...scopeAuditMetadata(ctx, denial, { relation: "write_contacts", objectType: "system", objectId: "*" }),
          command: groupName ? `${groupName}${commandName ? ` ${commandName}` : ""}` : undefined,
        });
      }
      return {
        allowed: wcAllowed,
        errorMessage: wcAllowed ? "" : `Permission denied: agent:${ctx.agentId} requires write_contacts`,
      };
    }
    default:
      // Fail-secure: unknown scope = deny
      return {
        allowed: false,
        errorMessage: `Permission denied: agent:${ctx.agentId} — unknown scope "${scope}"`,
      };
  }
}
