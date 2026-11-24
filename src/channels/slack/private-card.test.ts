import { describe, expect, it } from "bun:test";

import { deliverSlackPrivateCard } from "./private-card.js";

const CARD = { text: "Fechar esta thread?", blocks: [{ type: "section", text: { type: "mrkdwn", text: "x" } }] };
const TARGET = { accountId: "ravi-slack", chatId: "C0CHAN", userId: "U0PERSON", threadTs: "1795189835.360089" };

function requestWith(reply: unknown) {
  const sent: Array<{ topic: string; payload: Record<string, unknown>; timeoutMs: number | undefined }> = [];
  const requestReply = (async (topic: string, payload: Record<string, unknown>, timeoutMs?: number) => {
    sent.push({ topic, payload, timeoutMs });
    return reply;
  }) as never;
  return { sent, requestReply };
}

describe("a card only one person sees", () => {
  it("asks the gateway to send it privately to that person, in the thread, through the account", async () => {
    const { sent, requestReply } = requestWith({ success: true, messageId: "1795190000.000100" });

    await deliverSlackPrivateCard(TARGET, CARD, requestReply);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.topic).toBe("ravi.outbound.deliver");
    expect(sent[0]?.payload).toEqual({
      channel: "slack",
      accountId: "ravi-slack",
      to: "C0CHAN",
      text: "Fechar esta thread?",
      blocks: CARD.blocks,
      privateTo: ["U0PERSON"],
      threadId: "1795189835.360089",
    });
  });

  it("sends it at channel level when no thread is named", async () => {
    const { sent, requestReply } = requestWith({ messageId: "1.1" });

    await deliverSlackPrivateCard({ accountId: "a", chatId: "C1", userId: "U1" }, CARD, requestReply);

    expect(sent[0]?.payload).not.toHaveProperty("threadId");
    expect(sent[0]?.payload.privateTo).toEqual(["U1"]);
  });

  it("is delivered when the gateway names the message of any delivery, ephemeral or DM", async () => {
    const { requestReply } = requestWith({ deliveries: [{ userId: "U0PERSON", kind: "dm", messageId: "2.2" }] });

    await deliverSlackPrivateCard(TARGET, CARD, requestReply);
  });

  it("throws when the gateway did not confirm a message, with the reason it gave", async () => {
    const refused = requestWith({ success: false, error: "channel_not_found" });
    await expect(deliverSlackPrivateCard(TARGET, CARD, refused.requestReply)).rejects.toThrow(
      "Slack did not confirm the private card: channel_not_found",
    );

    const silent = requestWith({});
    await expect(deliverSlackPrivateCard(TARGET, CARD, silent.requestReply)).rejects.toThrow(
      "Slack did not confirm the private card",
    );
  });

  it("lets a request that failed or timed out reach the caller", async () => {
    const requestReply = (async () => {
      throw new Error("Request timeout");
    }) as never;

    await expect(deliverSlackPrivateCard(TARGET, CARD, requestReply)).rejects.toThrow("Request timeout");
  });
});
