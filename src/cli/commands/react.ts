/**
 * React Commands - Emoji reactions
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, Arg, Option, Returns } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";

const reactSendReturnSchema = z.object({
  success: z.literal(true),
  topic: z.literal("ravi.outbound.reaction"),
  reaction: z.object({
    messageId: z.string(),
    emoji: z.string(),
  }),
  target: z.object({
    channel: z.string(),
    accountId: z.string(),
    chatId: z.string(),
  }),
  event: z
    .object({
      channel: z.string(),
      accountId: z.string(),
      chatId: z.string(),
      messageId: z.string(),
      emoji: z.string(),
    })
    .passthrough(),
});

@Group({
  name: "react",
  description: "Emoji reactions",
  scope: "open",
})
export class ReactCommands {
  @Command({ name: "send", description: "Send an emoji reaction to a message" })
  @Returns(reactSendReturnSchema)
  async send(
    @Arg("messageId", { description: "Message ID to react to (from [mid:ID] tag)" }) messageId: string,
    @Arg("emoji", { description: "Emoji to react with" }) emoji: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = getContext();
    const source = ctx?.source;

    if (!source) {
      fail("No channel context available — cannot determine where to send reaction");
    }

    const { channel, accountId, chatId } = source;

    const eventPayload = {
      channel,
      accountId,
      chatId,
      messageId,
      emoji,
    };

    await nats.emit("ravi.outbound.reaction", eventPayload);

    const payload = {
      success: true,
      topic: "ravi.outbound.reaction",
      reaction: {
        messageId,
        emoji,
      },
      target: {
        channel,
        accountId,
        chatId,
      },
      event: eventPayload,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`✓ Reaction ${emoji} sent to message ${messageId}`);
    }

    return payload;
  }
}
