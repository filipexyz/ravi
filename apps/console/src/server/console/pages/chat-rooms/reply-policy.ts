// When the agent answers (K4) and how stored rows become ChatMessage.

import type { PageChatReplyPolicy } from "@/server/console/pages/chat/site-settings";

import type { ChatMessageRecord } from "./store";
import type { ChatMessage, ChatRoomKind } from "./types";

/**
 * Whether a new human message starts an agent turn. Private room: always.
 * Shared room: when the site says `always`, when the message calls the agent
 * (`@ravi` or `@<assistant name>`), when it clicks one of the agent's
 * buttons, or while only one person has ever written in the room (then the
 * room is still a one-to-one conversation).
 */
export function shouldAgentReply(input: {
  roomKind: ChatRoomKind;
  replyPolicy: PageChatReplyPolicy;
  assistantName: string;
  text: string;
  isAction: boolean;
  humanAuthorCount: number;
}): boolean {
  if (input.roomKind === "private") return true;
  if (input.replyPolicy === "always") return true;
  if (input.isAction) return true;
  if (mentionsAgent(input.text, input.assistantName)) return true;
  return input.humanAuthorCount <= 1;
}

/** `@ravi` or `@<assistant name>` (case and accents ignored), as a word. */
export function mentionsAgent(text: string, assistantName: string): boolean {
  const normalized = fold(text);
  const names = new Set(["ravi", fold(assistantName)].filter(Boolean));
  for (const name of names) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "u");
    if (pattern.test(normalized)) return true;
  }
  return false;
}

function fold(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

/** The wire shape of a stored message. A deleted message keeps its place but loses its content. */
export function toChatMessage(record: ChatMessageRecord): ChatMessage {
  const deleted = Boolean(record.deletedAt);
  return {
    id: record.id,
    roomId: record.roomId,
    seq: record.seq,
    author:
      record.authorType === "user" && record.authorUserId
        ? {
            type: "user",
            userId: record.authorUserId,
            displayName: record.authorName,
            role: record.authorRole === "guest" ? "guest" : "member",
          }
        : record.authorType === "agent"
          ? { type: "agent", displayName: record.authorName }
          : { type: "system", displayName: "Ravi" },
    text: deleted ? "" : record.body,
    parts: deleted ? [] : record.parts,
    status: record.status,
    source: record.source,
    clientMessageId: record.clientMessageId,
    anchor: deleted ? null : (record.anchor ?? null),
    createdAt: record.createdAt.toISOString(),
    editedAt: record.editedAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
  };
}
