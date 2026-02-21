/**
 * Route Resolver
 *
 * Resolves phone numbers to agents and session keys.
 */

import type {
  RouterConfig,
  AgentConfig,
  RouteConfig,
  ResolvedRoute,
  DmScope,
} from "./types.js";
import { buildSessionKey } from "./session-key.js";
import { generateSessionName, ensureUniqueName } from "./session-name.js";
import { getOrCreateSession, findSessionByAttributes, updateSessionName } from "./sessions.js";
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
 */
export function findRoute(
  phone: string,
  routes: RouteConfig[],
  accountId?: string
): RouteConfig | null {
  // Strict account scoping — no cross-account fallback (security: prevents
  // messages on one account from silently routing to another account's agent)
  const candidates = accountId
    ? routes.filter(r => r.accountId === accountId)
    : routes;

  // Sort by priority (higher first)
  const sorted = [...candidates].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const route of sorted) {
    if (matchPattern(phone, route.pattern)) {
      return route;
    }
  }

  return null;
}

/**
 * Resolve a phone number to an agent and session key
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
  }
): ResolvedRoute | null {
  const { phone, channel, accountId, isGroup, groupId } = params;

  // Find matching route — scoped to the account that received the message
  // For groups, match against "group:<id>" pattern (strip @g.us suffix)
  const normalizedGroupId = groupId ? `group:${groupId.replace(/@.*$/, "")}` : undefined;
  const routeTarget = isGroup ? normalizedGroupId ?? phone : phone;
  const effectiveAccount = accountId;
  const route = findRoute(routeTarget, config.routes, effectiveAccount);

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
  const dmScope: DmScope =
    route?.dmScope ?? agent.dmScope ?? config.defaultDmScope;

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

  // Resolve or generate session name
  // Check if session already exists (has a name)
  const agentCwd = expandHome(agent.cwd);
  const existing = getOrCreateSession(sessionKey, agentId, agentCwd);
  let sessionName = existing.name;

  if (!sessionName) {
    // Generate a name for this session
    const isMain = dmScope === "main";
    const nameOpts = {
      isMain,
      chatType: isGroup ? "group" as const : "dm" as const,
      peerKind: resolvedPeerKind,
      peerId: isGroup ? groupId : phone,
      groupName: existing.displayName ?? existing.subject ?? undefined,
      threadId: params.threadId,
    };
    const baseName = generateSessionName(agentId, nameOpts);
    sessionName = ensureUniqueName(baseName);
    // Persist the name
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
    route: route ?? undefined,
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
