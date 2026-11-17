import { getContact, getContactById, resolvePlatformIdentity } from "../contacts.js";
import { loadRouterConfig } from "../router/index.js";
import { dbGetInstance, dbGetInstanceByInstanceId } from "../router/router-db.js";
import {
  resolveScopedSlackIdentity,
  resolveSlackInstanceAliases,
  SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
} from "../channels/slack/instance-alias.js";

/** account_pending.phone is a legacy column name, not the sender's channel. */
export function resolvePendingContact(entry: { accountId: string; phone: string }) {
  const instance = dbGetInstance(entry.accountId) ?? dbGetInstanceByInstanceId(entry.accountId);
  const channel = instance?.channel ?? "unknown";
  if (channel !== "slack") {
    return {
      channel,
      instanceId: instance?.instanceId ?? entry.accountId,
      contact: getContact(entry.phone),
      identity: null,
      ambiguous: false,
    };
  }

  const aliases = resolveSlackInstanceAliases(loadRouterConfig(), entry.accountId);
  const resolved = resolveScopedSlackIdentity(
    aliases,
    (instanceId) => resolvePlatformIdentity({ channel, instanceId, platformUserId: entry.phone }),
    (identity) => (identity.ownerType && identity.ownerId ? `${identity.ownerType}:${identity.ownerId}` : null),
  );
  return {
    channel,
    instanceId: aliases.canonical,
    contact:
      resolved.identity?.ownerType === "contact" && resolved.identity.ownerId
        ? getContactById(resolved.identity.ownerId)
        : null,
    identity: resolved.identity,
    ambiguous: resolved.reason === SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
  };
}
