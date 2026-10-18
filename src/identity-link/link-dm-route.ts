/**
 * The private chat of a person who just linked, routed to the agent that
 * asked them to link.
 *
 * The person was talking to the agent in a group and was asked to write in
 * private. When that private chat would not reach any agent (the instance has
 * no default agent, or holds unknown DMs for pairing), Ravi creates the route
 * itself, as the operator would with `ravi instances routes add`. A chat that
 * already reaches an agent, an explicit route, and an instance with DMs
 * closed are left as they are.
 */

import { configStore } from "../config-store.js";
import { getContact, removeAccountPending } from "../contacts.js";
import { publish } from "../nats.js";
import { matchRoute } from "../router/resolver.js";
import { dbCreateRoute, dbGetAgent, dbGetRoute } from "../router/router-db.js";
import type { RouterConfig } from "../router/types.js";
import { logger } from "../utils/logger.js";
import type { ContactLinkState } from "./link-states-db.js";

const log = logger.child("identity:link-route");

export type LinkDmRouteOutcome = "created" | "reaches_agent" | "dm_closed" | "skipped";

export interface LinkDmRouteDeps {
  getConfig?: () => RouterConfig;
  /** Tell the daemon and the channel runner that routes changed. */
  emitConfigChanged?: () => void;
}

export function ensureLinkedDmRoute(
  state: Pick<ContactLinkState, "channel" | "accountId" | "agentId" | "routePattern">,
  deps: LinkDmRouteDeps = {},
): LinkDmRouteOutcome {
  const pattern = state.routePattern;
  if (!pattern || !state.agentId || !dbGetAgent(state.agentId)) return "skipped";
  if (dbGetRoute(pattern, state.accountId)) return "reaches_agent";

  const config = (deps.getConfig ?? (() => configStore.getConfig()))();
  const matched = matchRoute(config, { phone: pattern, channel: state.channel, accountId: state.accountId });
  if (matched) {
    const dmPolicy = matched.route?.policy ?? config.instances?.[state.accountId]?.dmPolicy ?? "open";
    if (dmPolicy === "closed") return "dm_closed";
    if (dmPolicy !== "pairing" || getContact(pattern)?.status === "allowed") return "reaches_agent";
  }

  try {
    dbCreateRoute({
      pattern,
      accountId: state.accountId,
      agent: state.agentId,
      channel: state.channel,
      policy: "open",
    });
  } catch (error) {
    // Another daemon created it first.
    if (error instanceof Error && error.message.startsWith("Route already exists")) return "reaches_agent";
    throw error;
  }
  removeAccountPending(state.accountId, pattern);
  log.info("Routed a linked person's private chat", {
    accountId: state.accountId,
    agentId: state.agentId,
    channel: state.channel,
  });
  const emit =
    deps.emitConfigChanged ??
    (() => {
      configStore.refresh();
      publish("ravi.config.changed", { reason: "identity_link_dm_route" }, { quietConnect: true }).catch(() => {});
    });
  emit();
  return "created";
}
