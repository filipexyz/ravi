/**
 * Cross Commands - Cross-session messaging
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { getSession, listSessions } from "../../router/sessions.js";
import { getContext } from "../context.js";
import { notif } from "../../notif.js";

const VALID_TYPES = ["send", "contextualize", "execute", "ask"] as const;
type CrossType = (typeof VALID_TYPES)[number];

const PREFIX_MAP: Record<CrossType, string> = {
  send: "[System] Send:",
  contextualize: "[System] Context:",
  execute: "[System] Execute:",
  ask: "[System] Ask:",
};

@Group({
  name: "cross",
  description: "Cross-session messaging",
})
export class CrossCommands {
  @Command({ name: "send", description: "Send a typed message to another session" })
  async send(
    @Arg("target", { description: "Target session key" }) target: string,
    @Arg("type", { description: "Message type: send | contextualize | execute | ask" }) type: string,
    @Arg("message", { description: "Message to send" }) message: string
  ) {
    // Validate type
    if (!VALID_TYPES.includes(type as CrossType)) {
      console.error(`Invalid type: ${type}`);
      console.log(`Valid types: ${VALID_TYPES.join(", ")}`);
      return { success: false, error: "Invalid type" };
    }

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

    const crossType = type as CrossType;
    const prompt = `${PREFIX_MAP[crossType]} ${message}`;

    const payload: Record<string, unknown> = { prompt, source };

    // For ask type, inject origin session key so bot can forward the response back
    if (crossType === "ask") {
      const ctx = getContext();
      if (ctx?.sessionKey) {
        payload.replyTo = ctx.sessionKey;
      }
    }

    await notif.emit(`ravi.${target}.prompt`, payload);
    console.log(`✓ [${type}] sent to ${target}`);
    return { success: true, target, type, source };
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
