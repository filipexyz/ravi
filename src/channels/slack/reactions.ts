import { normalizeReactionEmoji } from "../../utils/reaction-emoji.js";
import { cleanSlackId, envelopeEvent } from "./routing.js";
import type { SlackEventPayload, SlackSocketEnvelope } from "./types.js";

export interface SlackInboundReaction {
  readonly targetMessageId: string;
  readonly emoji: string;
  readonly senderId: string;
}

export function slackInboundReactionFromEnvelope(envelope: SlackSocketEnvelope): SlackInboundReaction | null {
  const event = slackReactionAddedEvent(envelope);
  if (!event) return null;

  const senderId = cleanSlackId(event.user);
  const reaction = typeof event.reaction === "string" ? event.reaction : "";
  const item = slackReactionItem(event);
  const targetMessageId = cleanSlackId(item?.ts);
  const itemType = typeof item?.type === "string" ? item.type.trim() : "";
  if (!senderId || !reaction.trim() || !targetMessageId) return null;
  if (itemType && itemType !== "message") return null;

  return {
    targetMessageId,
    emoji: normalizeReactionEmoji(reaction),
    senderId,
  };
}

function slackReactionAddedEvent(envelope: SlackSocketEnvelope): SlackEventPayload | undefined {
  const nested = envelopeEvent(envelope);
  if (nested?.type === "reaction_added") return nested;
  const payload = envelope.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as SlackEventPayload;
    if (record.type === "reaction_added") return record;
  }
  return undefined;
}

function slackReactionItem(event: SlackEventPayload): { type?: string; ts?: string } | undefined {
  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as { type?: unknown; ts?: unknown };
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    ts: typeof record.ts === "string" ? record.ts : undefined,
  };
}
