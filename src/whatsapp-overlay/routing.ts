export interface OmniRouteTargetInput {
  chatId: string;
  instanceName: string;
  chatType?: string | null;
  title?: string | null;
}

export interface OmniRouteTarget {
  instanceName: string;
  sourceChatId: string;
  routePattern: string;
  peerKind: "dm" | "group";
  peerId: string;
  chatType: "dm" | "group";
  groupId: string | null;
  title: string | null;
}

export function deriveOmniRouteTarget(input: OmniRouteTargetInput): OmniRouteTarget {
  const sourceChatId = clean(input.chatId);
  if (!sourceChatId) {
    throw new Error("Missing chatId for Omni route target");
  }

  const instanceName = clean(input.instanceName);
  if (!instanceName) {
    throw new Error("Missing instance for Omni route target");
  }

  const normalizedType = clean(input.chatType);
  const isGroup = isOmniGroupChat(sourceChatId, normalizedType);
  const bareId = sourceChatId.replace(/^group:/i, "").replace(/@.*$/, "");

  return {
    instanceName,
    sourceChatId,
    routePattern: isGroup ? `group:${bareId}` : bareId,
    peerKind: isGroup ? "group" : "dm",
    peerId: isGroup ? `group:${bareId}` : bareId,
    chatType: isGroup ? "group" : "dm",
    groupId: isGroup ? `group:${bareId}` : null,
    title: clean(input.title),
  };
}

export function isOmniGroupChat(chatId: string | null | undefined, chatType?: string | null): boolean {
  const normalizedType = clean(chatType)?.toLowerCase();
  if (normalizedType === "group") return true;
  if (normalizedType === "dm") return false;

  const normalizedChatId = clean(chatId)?.toLowerCase();
  return Boolean(normalizedChatId && (normalizedChatId.startsWith("group:") || normalizedChatId.endsWith("@g.us")));
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
