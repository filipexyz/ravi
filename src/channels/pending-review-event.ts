// The events an inbound held for owner review emits, on every channel path
// (omni consumer, Slack Socket Mode). Event-driven review workflows listen on
// these topics, so both paths build them here and only the transport differs.

export interface PendingReviewInput {
  /** Channel type the inbound arrived on (`whatsapp-baileys`, `slack`, ...). */
  channel: string;
  accountId: string;
  senderId: string;
  chatId: string;
  isGroup: boolean;
}

export interface PendingReviewEvent {
  topic: "ravi.contacts.pending" | "ravi.chats.pending";
  payload: Record<string, unknown>;
}

/**
 * A held person emits `ravi.contacts.pending`. A held chat emits
 * `ravi.chats.pending` plus the legacy `ravi.contacts.pending`, marked
 * deprecated, for listeners that predate the chat topic.
 */
export function pendingReviewEvents(input: PendingReviewInput): PendingReviewEvent[] {
  const payload = {
    type: "account",
    reviewKind: input.isGroup ? "chat" : "contact",
    channel: input.channel,
    accountId: input.accountId,
    senderId: input.senderId,
    chatId: input.chatId,
    isGroup: input.isGroup,
  };
  if (!input.isGroup) return [{ topic: "ravi.contacts.pending", payload }];
  return [
    { topic: "ravi.chats.pending", payload },
    {
      topic: "ravi.contacts.pending",
      payload: { ...payload, deprecated: true, replacementTopic: "ravi.chats.pending" },
    },
  ];
}
