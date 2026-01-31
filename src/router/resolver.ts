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
  // Exact match
  if (!pattern.includes("*")) {
    return phone === pattern;
  }

  // All match
  if (pattern === "*") {
    return true;
  }

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\*/g, ".*"); // * -> .*

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(phone);
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

  // Get agent: contacts DB > route > default
  const agentId = contactAgentId ?? route?.agent ?? config.defaultAgent;
  const agent = config.agents[agentId];

  if (!agent) {
    log.error(`Agent not found: ${agentId}`);
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Determine DM scope
  const dmScope: DmScope =
    route?.dmScope ?? agent.dmScope ?? config.defaultDmScope;

  // Build session key
  const sessionKey = buildSessionKey({
    agentId,
    channel,
    accountId,
    peerKind: isGroup ? "group" : "dm",
    peerId: isGroup ? groupId : phone,
    dmScope,
  });

  log.debug("Resolved route", {
    phone,
    agentId,
    dmScope,
    sessionKey,
    matchedPattern: route?.pattern,
  });

  return {
    agent,
    dmScope,
    sessionKey,
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
