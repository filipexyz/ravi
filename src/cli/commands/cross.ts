/**
 * Cross Commands - Cross-session messaging
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { getSession, listSessions } from "../../router/sessions.js";
import { notif } from "../../notif.js";

@Group({
  name: "cross",
  description: "Cross-session messaging",
})
export class CrossCommands {
  @Command({ name: "send", description: "Send a message to another session" })
  async send(
    @Arg("target", { description: "Target session key" }) target: string,
    @Arg("message", { description: "Message to send" }) message: string
  ) {
    // Get target session to find its source (channel/account/chat)
    const targetSession = getSession(target);
    if (!targetSession) {
      console.error(`Session not found: ${target}`);
      console.log("\nAvailable sessions:");
      for (const s of listSessions()) {
        console.log(`  - ${s.sessionKey}`);
      }
      return { success: false, error: "Session not found" };
    }

    // Check if target has channel info
    if (!targetSession.lastChannel || !targetSession.lastTo) {
      console.error(`Session has no channel info: ${target}`);
      console.log("The target session must have received at least one message from a channel.");
      return { success: false, error: "No channel info" };
    }

    // Build source from target session's last source
    const source = {
      channel: targetSession.lastChannel,
      accountId: targetSession.lastAccountId ?? "default",
      chatId: targetSession.lastTo,
    };

    // Build the cross-session prompt using system command format
    // The agent's system prompt instructs it to respond ONLY with the message content
    const crossPrompt = `[Sistema] Notifique: ${message}`;

    // Emit to target session's prompt topic
    await notif.emit(`ravi.${target}.prompt`, {
      prompt: crossPrompt,
      source,
    });
    console.log(`✓ Message sent to ${target}`);
    return { success: true, target, source };
  }

  @Command({ name: "list", description: "List sessions with channel info" })
  list() {
    const sessions = listSessions();

    console.log("\nSessions with channel routing:\n");
    console.log("  SESSION KEY                                          CHANNEL    CHAT");
    console.log("  ---------------------------------------------------  ---------  ----");

    for (const s of sessions) {
      const key = s.sessionKey.padEnd(51);
      const channel = (s.lastChannel ?? "-").padEnd(9);
      const chat = s.lastTo ?? "-";
      console.log(`  ${key}  ${channel}  ${chat}`);
    }

    console.log(`\n  Total: ${sessions.length} sessions`);
  }
}
