import { describe, expect, it } from "bun:test";
import { pendingReviewEvents } from "./pending-review-event.js";

describe("pending review events", () => {
  it("announces a held person on the contacts topic", () => {
    expect(
      pendingReviewEvents({
        channel: "slack",
        accountId: "ravi-slack",
        senderId: "U0PEER",
        chatId: "D0PEER",
        isGroup: false,
      }),
    ).toEqual([
      {
        topic: "ravi.contacts.pending",
        payload: {
          type: "account",
          reviewKind: "contact",
          channel: "slack",
          accountId: "ravi-slack",
          senderId: "U0PEER",
          chatId: "D0PEER",
          isGroup: false,
        },
      },
    ]);
  });

  it("announces a held chat on the chats topic, plus the deprecated contacts topic", () => {
    const events = pendingReviewEvents({
      channel: "whatsapp-baileys",
      accountId: "main",
      senderId: "5511999999999",
      chatId: "120363000000000000@g.us",
      isGroup: true,
    });
    expect(events.map((event) => event.topic)).toEqual(["ravi.chats.pending", "ravi.contacts.pending"]);
    expect(events[0]?.payload).toMatchObject({ reviewKind: "chat", isGroup: true });
    expect(events[1]?.payload).toMatchObject({ deprecated: true, replacementTopic: "ravi.chats.pending" });
  });
});
