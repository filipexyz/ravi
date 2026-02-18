/**
 * React Commands - Emoji reactions
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";

@Group({
  name: "react",
  description: "Emoji reactions",
  scope: "open",
})
export class ReactCommands {
  @Command({ name: "send", description: "Send an emoji reaction to a message" })
  async send(
    @Arg("messageId", { description: "Message ID to react to (from [mid:ID] tag)" }) messageId: string,
    @Arg("emoji", { description: "Emoji to react with" }) emoji: string
  ) {
    const ctx = getContext();
    const source = ctx?.source;

    if (!source) {
      fail("No channel context available — cannot determine where to send reaction");
    }

    const { channel, accountId, chatId } = source;

    await nats.emit("ravi.outbound.reaction", {
      channel,
      accountId,
      chatId,
      messageId,
      emoji,
    });

    console.log(`✓ Reaction ${emoji} sent to message ${messageId}`);
    return { success: true, messageId, emoji, channel, chatId };
  }
}
