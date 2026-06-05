import { describe, expect, it } from "bun:test";
import { getTriggerEventDedupeKey } from "../runner.js";

describe("trigger runner event dedupe", () => {
  it("keys local inbox mail events by trigger, topic, and message identity", () => {
    const trigger = { id: "trg_mail" };
    const event = {
      topic: "ravi.inbox.mail.received",
      data: {
        inboxItemId: "inbox_1",
        sourceId: "mail_msg_1",
        mail: {
          messageId: "mail_msg_1",
          subject: "Invoice",
        },
      },
    };

    expect(getTriggerEventDedupeKey(trigger, event)).toBe(
      ["trg_mail", "ravi.inbox.mail.received", "inbox_1"].join("\0"),
    );
    expect(
      getTriggerEventDedupeKey(trigger, {
        ...event,
        data: {
          ...event.data,
          inboxItemId: "inbox_2",
          sourceId: "mail_msg_2",
          mail: { messageId: "mail_msg_2", subject: "Invoice" },
        },
      }),
    ).not.toBe(getTriggerEventDedupeKey(trigger, event));
  });

  it("falls back to a stable payload hash when the event has no explicit id", () => {
    const trigger = { id: "trg_custom" };
    const first = getTriggerEventDedupeKey(trigger, {
      topic: "custom.topic",
      data: { b: 2, a: { z: true, y: "same" } },
    });
    const second = getTriggerEventDedupeKey(trigger, {
      topic: "custom.topic",
      data: { a: { y: "same", z: true }, b: 2 },
    });

    expect(first).toBe(second);
    expect(first).toStartWith("trg_custom\0custom.topic\0payload:");
  });
});
