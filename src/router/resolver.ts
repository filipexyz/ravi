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
import { getContactAgent } from "../contacts.js";

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
 * Find the best matching route for a phone number
 */
export function findRoute(
  phone: string,
  routes: RouteConfig[]
): RouteConfig | null {
  // Sort by priority (higher first)
  const sorted = [...routes].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

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
  }
): ResolvedRoute {
  const { phone, channel, accountId, isGroup, groupId } = params;

  // Check contacts DB for agent assignment
  const contactAgentId = getContactAgent(isGroup ? groupId ?? phone : phone);

  // Find matching route (fallback)
  // For groups, match against groupId; for DMs, match against phone
  const routeTarget = isGroup ? groupId ?? phone : phone;
  const route = findRoute(routeTarget, config.routes);

  // Check if accountId matches an agent (for Matrix multi-account)
  // If accountId is not "default" and matches an agent, use it
  const accountAgentId =
    accountId && accountId !== "default" && config.agents[accountId]
      ? accountId
      : undefined;

  // Get agent: contacts DB > route > accountId-as-agent > default
  const agentId = contactAgentId ?? route?.agent ?? accountAgentId ?? config.defaultAgent;
  const agent = config.agents[agentId];

  if (!agent) {
    log.error(`Agent not found: ${agentId}`);
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Determine DM scope
  const dmScope: DmScope =
    route?.dmScope ?? agent.dmScope ?? config.defaultDmScope;

  // Build session key (kept for backwards compat in DB PK)
  const sessionKey = buildSessionKey({
    agentId,
    channel,
    accountId,
    peerKind: isGroup ? "group" : "dm",
    peerId: isGroup ? groupId : phone,
    dmScope,
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
      peerKind: isGroup ? "group" as const : "dm" as const,
      peerId: isGroup ? groupId : phone,
      groupName: existing.displayName ?? existing.subject ?? undefined,
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
