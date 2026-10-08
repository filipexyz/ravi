import type { RouterConfig } from "../../router/types.js";
import { resolveSlackInstanceAliases } from "./instance-alias.js";

/** Slack public/private channel ids (`C…` / legacy private `G…`). DMs are not seeded. */
const SLACK_CONVERSATION_ID = /^[CG][A-Z0-9]{6,}$/;

export interface RouteSeededSlackChat {
  instanceId: string;
  platformChatId: string;
  chatType: "group";
}

type SeedConfig = Pick<RouterConfig, "routes" | "instances" | "instanceToAccount" | "channels">;

/**
 * A Slack channel gets its canonical chat on its first inbound message. Until
 * then `sessions attach` has nothing to attach. When an operator already routed
 * the channel (`group:<id>`) on exactly one Slack account, that route names the
 * same chat identity the Socket Mode inbound will upsert, so attach may seed it.
 * Returns null when the ref is not a Slack channel id, no exact route names it,
 * or routes on different Slack accounts make the owner ambiguous.
 */
export function resolveRouteSeededSlackChat(config: SeedConfig, ref: string): RouteSeededSlackChat | null {
  const platformChatId = ref
    .trim()
    .replace(/^group:/i, "")
    .toUpperCase();
  if (!SLACK_CONVERSATION_ID.test(platformChatId)) return null;

  const instanceIds = new Set<string>();
  for (const route of config.routes) {
    const pattern = route.pattern.trim().toUpperCase();
    if (pattern !== `GROUP:${platformChatId}`) continue;
    if (route.channel && route.channel !== "slack") continue;
    if (!isSlackAccount(config, route.accountId)) continue;
    instanceIds.add(resolveSlackInstanceAliases(config, route.accountId).canonical);
  }
  if (instanceIds.size !== 1) return null;
  const [instanceId] = instanceIds;
  return { instanceId, platformChatId, chatType: "group" };
}

function isSlackAccount(config: SeedConfig, accountId: string): boolean {
  const channel = config.channels?.[accountId];
  if (channel) return channel.enabled !== false && channel.provider === "slack";
  const instance = config.instances?.[accountId];
  return instance?.channel === "slack" && instance.enabled !== false;
}
