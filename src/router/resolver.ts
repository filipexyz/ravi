/**
 * Route Resolver
 *
 * Resolves phone numbers to agents and session keys.
 */

import type { RouterConfig, AgentConfig, RouteConfig, MatchedRoute, ResolvedRoute, DmScope } from "./types.js";
import { buildSessionKey } from "./session-key.js";
import { generateSessionName, ensureUniqueName } from "./session-name.js";
import { getOrCreateSession, updateSessionName, getSessionByName } from "./sessions.js";
import { logger } from "../utils/logger.js";

const log = logger.child("router");

/**
 * Match a phone number against a pattern
 *
 * Patterns:
 * - Exact: "5511999999999"
 * - Prefix: "5511*" (matches 5511...)
 * - Suffix: "*999999999" (matches ...999999999)
 * - Contains: "*999*" (matches ...999...)
 * - All: "*"
 */
export function matchPattern(phone: string, pattern: string): boolean {
  const p = phone.toLowerCase();
  const pat = pattern.toLowerCase();

  // Exact match
  if (!pat.includes("*")) {
    return p === pat;
  }

  // All match
  if (pat === "*") {
    return true;
  }

  // Convert glob to regex (case-insensitive)
  const regexStr = pat
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\*/g, ".*"); // * -> .*

  const regex = new RegExp(`^${regexStr}$`, "i");
  return regex.test(p);
}

/**
 * Find the best matching route for a phone number.
 * When accountId is provided, only routes for that exact account are considered.
 * When channel is provided, channel-specific routes are preferred over channel-agnostic ones.
 */
export function findRoute(
  phone: string,
  routes: RouteConfig[],
  accountId?: string,
  channel?: string,
): RouteConfig | null {
  // Strict account scoping — no cross-account fallback (security: prevents
  // messages on one account from silently routing to another account's agent)
  const candidates = accountId ? routes.filter((r) => r.accountId === accountId) : routes;

  // Filter to routes that apply to this channel:
  // - routes with matching channel (exact)
  // - routes with no channel (applies to all)
  // Channel-specific routes take priority over channel-agnostic ones
  const channelCandidates = channel ? candidates.filter((r) => !r.channel || r.channel === channel) : candidates;

  // Sort: channel-specific first, then by priority (higher first)
  const sorted = [...channelCandidates].sort((a, b) => {
    // Channel-specific routes beat channel-agnostic ones
    const aSpecific = channel && a.channel === channel ? 1 : 0;
    const bSpecific = channel && b.channel === channel ? 1 : 0;
    if (bSpecific !== aSpecific) return bSpecific - aSpecific;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  for (const route of sorted) {
    if (matchPattern(phone, route.pattern)) {
      return route;
    }
  }

  return null;
}

/**
 * Pure routing: match a phone/group to an agent, DM scope, and session key.
 * No database access or session creation — safe for testing and dry-run contexts.
 */
export function matchRoute(
  config: RouterConfig,
  params: {
    phone: string;
    channel?: string;
    accountId?: string;
    isGroup?: boolean;
    groupId?: string;
    threadId?: string;
    peerKind?: string;
  },
): MatchedRoute | null {
  const { phone, channel, accountId, isGroup, groupId } = params;

  // Find matching route — scoped to the account that received the message
  // Priority order: thread:* > group:* > phone/*
  const normalizedGroupId = groupId ? `group:${groupId.replace(/@.*$/, "")}` : undefined;
  const normalizedThreadId = params.threadId ? `thread:${params.threadId}` : undefined;
  const effectiveAccount = accountId;

  // Try thread-specific route first (most specific)
  let route = normalizedThreadId ? findRoute(normalizedThreadId, config.routes, effectiveAccount, channel) : null;
  // Fall back to group route
  if (!route) {
    const routeTarget = isGroup ? (normalizedGroupId ?? phone) : phone;
    route = findRoute(routeTarget, config.routes, effectiveAccount, channel);
  }

  // Resolve agent: route > account-agent mapping > defaultAgent
  let agentId: string;
  if (route?.agent) {
    agentId = route.agent;
  } else if (effectiveAccount && config.accountAgents?.[effectiveAccount]) {
    agentId = config.accountAgents[effectiveAccount];
  } else if (!effectiveAccount || config.accountAgents?.[effectiveAccount] !== undefined) {
    agentId = config.defaultAgent;
  } else {
    // Account with no route match → skip (saved as account pending by consumer)
    log.debug("No route for account, skipping", { phone, accountId });
    return null;
  }

  const agent = config.agents[agentId];

  if (!agent) {
    log.error(`Agent not found: ${agentId}`);
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Determine DM scope
  const dmScope: DmScope = route?.dmScope ?? agent.dmScope ?? config.defaultDmScope;

  // Build session key (kept for backwards compat in DB PK)
  const resolvedPeerKind = (params.peerKind ?? (isGroup ? "group" : "dm")) as "dm" | "group" | "channel";
  const sessionKey = buildSessionKey({
    agentId,
    channel,
    accountId,
    peerKind: resolvedPeerKind,
    peerId: isGroup ? groupId : phone,
    dmScope,
    threadId: params.threadId,
  });

  return {
    agentId,
    agent,
    dmScope,
    sessionKey,
    route: route ?? undefined,
  };
}

/**
 * Resolve a phone number to an agent, session key, and session name.
 * Calls matchRoute() for pure routing, then creates/resolves the session (DB side effect).
 */
export function resolveRoute(
  config: RouterConfig,
  params: {
    phone: string;
    channel?: string;
    accountId?: string;
    isGroup?: boolean;
    groupId?: string;
    threadId?: string;
    peerKind?: string;
  },
): ResolvedRoute | null {
  const match = matchRoute(config, params);
  if (!match) return null;

  const { agentId, agent, dmScope, sessionKey, route } = match;
  const { isGroup, groupId, phone } = params;

  // If route forces a session name that already exists, route directly to it
  // without creating a new session. This enables sharing sessions across sources.
  const agentCwd = expandHome(agent.cwd);
  if (route?.session) {
    const target = getSessionByName(route.session);
    if (target && target.sessionKey !== sessionKey) {
      log.info("Route redirecting to existing session", {
        routeSession: route.session,
        targetKey: target.sessionKey,
        sourceKey: sessionKey,
      });
      return {
        agent,
        dmScope,
        sessionKey: target.sessionKey,
        sessionName: route.session,
        route,
      };
    }
  }

  const existing = getOrCreateSession(sessionKey, agentId, agentCwd);
  let sessionName = existing.name;

  // Route-forced session name takes precedence
  if (route?.session && existing.name !== route.session) {
    sessionName = route.session;
    updateSessionName(sessionKey, sessionName);
  } else if (!sessionName) {
    const resolvedPeerKind = (params.peerKind ?? (isGroup ? "group" : "dm")) as "dm" | "group" | "channel";
    const isMain = dmScope === "main";
    const nameOpts = {
      isMain,
      chatType: isGroup ? ("group" as const) : ("dm" as const),
      peerKind: resolvedPeerKind,
      peerId: isGroup ? groupId : phone,
      groupName: existing.displayName ?? existing.subject ?? undefined,
      threadId: params.threadId,
    };
    const baseName = generateSessionName(agentId, nameOpts);
    sessionName = ensureUniqueName(baseName);
    updateSessionName(sessionKey, sessionName);
  }

  log.debug("Resolved route", {
    phone,
    agentId,
    dmScope,
    sessionKey,
    sessionName,
    matchedPattern: route?.pattern,
  });

  return {
    agent,
    dmScope,
    sessionKey,
    sessionName,
    route,
  };
}

/**
 * Expand home directory in path
 */
export function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME ?? "");
  }
  return path;
}

/**
 * Get the CWD for an agent
 */
export function getAgentCwd(agent: AgentConfig): string {
  return expandHome(agent.cwd);
}
