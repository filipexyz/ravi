import { configStore } from "../config-store.js";
import { runtimeChannelsMatch } from "./session-chat-identity.js";
import type { RuntimeMessageTarget } from "./host-session.js";

/**
 * Stable identity for the external chat/thread that owns one physical runtime
 * turn. A session may be attached to many surfaces, but a provider turn may
 * only ever answer one of them.
 */
export function runtimeTurnSurfaceKey(source: RuntimeMessageTarget | null | undefined): string {
  if (!source) return "internal";

  if (source.canonicalChatId) {
    return JSON.stringify(["canonical", source.canonicalChatId, source.threadId ?? ""]);
  }

  return JSON.stringify([
    source.channel,
    source.accountId,
    source.instanceId ?? "",
    source.chatId,
    source.threadId ?? "",
  ]);
}

export function isSameRuntimeTurnSurface(
  left: RuntimeMessageTarget | null | undefined,
  right: RuntimeMessageTarget | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  if ((left.threadId ?? "") !== (right.threadId ?? "")) return false;
  if (left.canonicalChatId && right.canonicalChatId) {
    return left.canonicalChatId === right.canonicalChatId;
  }

  // Scheduled prompts may carry only transport identity. Resolve account
  // aliases only when necessary; conflicting explicit instances stay separate.
  if (!runtimeChannelsMatch(left.channel, right.channel) || !left.chatId || left.chatId !== right.chatId) return false;
  if (left.instanceId && right.instanceId && left.instanceId !== right.instanceId) return false;
  if (left.accountId && left.accountId === right.accountId) return true;
  const leftInstance = left.instanceId ?? (left.accountId ? configStore.resolveInstanceId(left.accountId) : undefined);
  const rightInstance =
    right.instanceId ?? (right.accountId ? configStore.resolveInstanceId(right.accountId) : undefined);
  return Boolean(leftInstance && rightInstance && leftInstance === rightInstance);
}
