/**
 * Cross Commands - Cross-session messaging
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { getSession, listSessions } from "../../router/sessions.js";
import { deriveSourceFromSessionKey } from "../../router/session-key.js";
import { getContext } from "../context.js";
import { notif } from "../../notif.js";

const VALID_TYPES = ["send", "contextualize", "execute", "ask", "answer"] as const;
type CrossType = (typeof VALID_TYPES)[number];

const PREFIX_MAP: Record<CrossType, string> = {
  send: "[System] Send:",
  contextualize: "[System] Context:",
  execute: "[System] Execute:",
  ask: "[System] Ask:",
  answer: "[System] Answer:",
};

@Group({
  name: "cross",
  description: "Cross-session messaging",
})
export class CrossCommands {
  @Command({ name: "send", description: "Send a typed message to another session" })
  async send(
    @Arg("target", { description: "Target session key" }) target: string,
    @Arg("type", { description: "Message type: send | contextualize | execute | ask | answer" }) type: string,
    @Arg("message", { description: "Message to send" }) message: string
  ) {
    // Validate type
    if (!VALID_TYPES.includes(type as CrossType)) {
      console.error(`Invalid type: ${type}`);
      console.log(`Valid types: ${VALID_TYPES.join(", ")}`);
      return { success: false, error: "Invalid type" };
    }

    // Resolve source: existing session > derive from key > none
    let source: { channel: string; accountId: string; chatId: string } | undefined;
    let sourceOrigin: string;

    const targetSession = getSession(target);
    if (targetSession?.lastChannel && targetSession.lastTo) {
      source = {
        channel: targetSession.lastChannel,
        accountId: targetSession.lastAccountId ?? "default",
        chatId: targetSession.lastTo,
      };
      sourceOrigin = "session";
    } else {
      const derived = deriveSourceFromSessionKey(target);
      if (derived) {
        source = derived;
        sourceOrigin = "derived";
      } else {
        sourceOrigin = "none";
      }
    }

    const crossType = type as CrossType;
    let prompt: string;

    if (crossType === "ask" || crossType === "answer") {
      // Include origin session so the agent knows where to reply / who answered
      const ctx = getContext();
      const origin = ctx?.sessionKey ?? "unknown";
      prompt = `${PREFIX_MAP[crossType]} [from: ${origin}] ${message}`;
    } else {
      prompt = `${PREFIX_MAP[crossType]} ${message}`;
    }

    await notif.emit(`ravi.${target}.prompt`, { prompt, source } as Record<string, unknown>);

    if (source) {
      console.log(`✓ [${type}] sent to ${target} (routing: ${source.channel}, src: ${sourceOrigin})`);
    } else {
      console.log(`✓ [${type}] sent to ${target} (no routing — response won't reach a channel)`);
    }

    return { success: true, target, type, source };
  }

  @Command({ name: "list", description: "List sessions with channel info" })
  list() {
    const sessions = listSessions();

    console.log("\nSessions with channel routing:\n");
    console.log("  SESSION KEY                                          CHANNEL    NAME");
    console.log("  ---------------------------------------------------  ---------  ----");

    for (const s of sessions) {
      const key = s.sessionKey.padEnd(51);
      const channel = (s.lastChannel ?? "-").padEnd(9);
      const name = s.displayName ?? s.lastTo ?? "-";
      console.log(`  ${key}  ${channel}  ${name}`);
    }

    console.log(`\n  Total: ${sessions.length} sessions`);
  }
}
