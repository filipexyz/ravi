/**
 * React Commands - Emoji reactions
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { notif } from "../../notif.js";

@Group({
  name: "react",
  description: "Emoji reactions",
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

    await notif.emit("ravi.outbound.reaction", {
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
