/**
 * Scope Isolation Module
 *
 * Central module for verifying agent access to resources.
 * Delegates all permission checks to the REBAC engine.
 */

import { getContext } from "../cli/context.js";
import { agentCan } from "./engine.js";
import type { SessionEntry } from "../router/types.js";
import type { ScopeType } from "../cli/decorators.js";

// ============================================================================
// Scope Context
// ============================================================================

export interface ScopeContext {
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
}

/**
 * Get the current scope context from the CLI context.
 */
export function getScopeContext(): ScopeContext {
  const ctx = getContext();
  return {
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
    sessionName: ctx?.sessionName,
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
export function canAccessSession(
  ctx: ScopeContext,
  targetNameOrKey: string
): boolean {
  if (!ctx.agentId) return true;

  // Own session
  if (ctx.sessionName && ctx.sessionName === targetNameOrKey) return true;
  if (ctx.sessionKey && ctx.sessionKey === targetNameOrKey) return true;

  return agentCan(ctx.agentId, "access", "session", targetNameOrKey);
}

/**
 * Filter a list of sessions to only those accessible by the current context.
 */
export function filterAccessibleSessions(
  ctx: ScopeContext,
  sessions: SessionEntry[]
): SessionEntry[] {
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
export function canModifySession(
  ctx: ScopeContext,
  targetNameOrKey: string
): boolean {
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
  contactSessions?: { agentId: string }[]
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

/**
 * Check if the current context can write contacts (add/approve/block/delete).
 */
export function canWriteContacts(ctx: ScopeContext): boolean {
  return agentCan(ctx.agentId, "write_contacts", "system", "*");
}

// ============================================================================
// Resource Access (cron, triggers, outbound)
// ============================================================================

/**
 * Check if the current context can access a resource owned by an agent.
 * Ownership is checked directly (agent_id match), not via relations.
 */
export function canAccessResource(
  ctx: ScopeContext,
  resourceAgentId: string | undefined
): boolean {
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
  commandName?: string
): {
  allowed: boolean;
  errorMessage: string;
} {
  if (scope === "open" || scope === "resource") {
    return { allowed: true, errorMessage: "" };
  }

  const ctx = getScopeContext();

  switch (scope) {
    case "superadmin": {
      const allowed = agentCan(ctx.agentId, "admin", "system", "*");
      return {
        allowed,
        errorMessage: allowed ? "" : `Permission denied: agent:${ctx.agentId} requires admin on system:*`,
      };
    }
    case "admin": {
      // Check group-level access first (e.g., execute group:agents)
      const groupAllowed = agentCan(
        ctx.agentId,
        "execute",
        "group",
        groupName ?? "*"
      );
      if (groupAllowed) return { allowed: true, errorMessage: "" };

      // Check subcommand-level access (e.g., execute group:agents_list)
      if (commandName && groupName) {
        const cmdAllowed = agentCan(
          ctx.agentId,
          "execute",
          "group",
          `${groupName}_${commandName}`
        );
        if (cmdAllowed) return { allowed: true, errorMessage: "" };
      }

      const target = commandName && groupName ? `group:${groupName}_${commandName}` : `group:${groupName ?? "*"}`;
      return { allowed: false, errorMessage: `Permission denied: agent:${ctx.agentId} requires execute on ${target}` };
    }
    case "writeContacts":
      return {
        allowed: canWriteContacts(ctx),
        errorMessage: canWriteContacts(ctx) ? "" : `Permission denied: agent:${ctx.agentId} requires write_contacts`,
      };
    default:
      // Fail-secure: unknown scope = deny
      return { allowed: false, errorMessage: `Permission denied: agent:${ctx.agentId} — unknown scope "${scope}"` };
  }
}
