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
  return runtimeTurnSurfaceKey(left) === runtimeTurnSurfaceKey(right);
}
