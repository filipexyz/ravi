/**
 * Where a turn's answer goes, recorded on its runtime context when the turn
 * starts (`turnReplyTarget`). A call made during the turn reads it to know
 * who will read the answer: a relay carries no chat of its own, so its
 * compartment does not say where the session will post.
 *
 * - `none`: the answer is posted to no chat (a waiting CLI reads it from the
 *   transcript, an observation, an observer session).
 * - `chat`: the chat the runtime bound for the answer.
 * - `unresolved`: no chat was bound when the turn started, but one may still
 *   be found when the answer is sent, so it is not `none`.
 */

export const TURN_REPLY_TARGET_METADATA_KEY = "turnReplyTarget";

export type TurnReplyTarget =
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "chat"; channel: string; chatId: string; canonicalChatId?: string; instanceId?: string };

export interface TurnReplyTargetInput {
  /** The turn posts nothing to a chat (`suppressChatEmit`). */
  suppressed: boolean;
  target: { channel?: string; chatId?: string; canonicalChatId?: string; instanceId?: string } | null | undefined;
}

export function buildTurnReplyTarget(input: TurnReplyTargetInput): TurnReplyTarget {
  if (input.suppressed) return { kind: "none" };
  const channel = cleanString(input.target?.channel);
  const chatId = cleanString(input.target?.chatId);
  if (!channel || !chatId) return { kind: "unresolved" };
  const canonicalChatId = cleanString(input.target?.canonicalChatId);
  const instanceId = cleanString(input.target?.instanceId);
  return {
    kind: "chat",
    channel,
    chatId,
    ...(canonicalChatId ? { canonicalChatId } : {}),
    ...(instanceId ? { instanceId } : {}),
  };
}

/** The recorded reply target, or null when the context has none (or a malformed one). */
export function readTurnReplyTarget(metadata: Record<string, unknown> | null | undefined): TurnReplyTarget | null {
  const value = metadata?.[TURN_REPLY_TARGET_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "none" || record.kind === "unresolved") return { kind: record.kind };
  if (record.kind !== "chat") return null;
  const target = buildTurnReplyTarget({
    suppressed: false,
    target: {
      channel: stringValue(record.channel),
      chatId: stringValue(record.chatId),
      canonicalChatId: stringValue(record.canonicalChatId),
      instanceId: stringValue(record.instanceId),
    },
  });
  return target.kind === "chat" ? target : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
