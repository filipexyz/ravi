/**
 * Cross Commands - Cross-session messaging
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getSession, findSessionByChatId, listSessions } from "../../router/sessions.js";
import { deriveSourceFromSessionKey } from "../../router/session-key.js";
import { getContext } from "../context.js";
import { notif } from "../../notif.js";
import type { ChannelContext } from "../../bot.js";

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
    @Arg("target", { description: "Target session key or contact ID" }) target: string,
    @Arg("type", { description: "Message type: send | contextualize | execute | ask | answer" }) type: string,
    @Arg("message", { description: "Message to send" }) message: string,
    @Arg("sender", { required: false, description: "Who originally requested this (for ask/answer attribution)" }) sender?: string,
    @Option({ flags: "--channel <channel>", description: "Delivery channel (whatsapp, matrix)" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Delivery target (phone, room ID)" }) to?: string
  ) {
    // Validate type
    if (!VALID_TYPES.includes(type as CrossType)) {
      console.error(`Invalid type: ${type}`);
      console.log(`Valid types: ${VALID_TYPES.join(", ")}`);
      return { success: false, error: "Invalid type" };
    }

    // Validate target is a full session key
    if (!target.includes(":")) {
      // Looks like a short name (e.g., "main" instead of "agent:main:main")
      const sessions = listSessions();
      const suggestions = sessions
        .filter(s => s.sessionKey.includes(target))
        .map(s => {
          const routing = s.lastChannel && s.lastTo
            ? `→ ${s.lastChannel}:${s.lastTo}`
            : "(no routing)";
          return `  ${s.sessionKey} ${routing}`;
        });

      console.error(`[ERROR] Invalid target: "${target}"`);
      console.error(`Target must be a full session key (e.g., agent:main:main)\n`);

      if (suggestions.length > 0) {
        console.log(`Did you mean:\n${suggestions.join("\n")}`);
      } else {
        console.log(`Available sessions:`);
        for (const s of sessions.slice(0, 10)) {
          const routing = s.lastChannel && s.lastTo
            ? `→ ${s.lastChannel}:${s.lastTo}`
            : "(no routing)";
          console.log(`  ${s.sessionKey} ${routing}`);
        }
        if (sessions.length > 10) {
          console.log(`  ... and ${sessions.length - 10} more (use cross_list to see all)`);
        }
      }
      return { success: false, error: `Invalid target: ${target}` };
    }

    // If target doesn't look like a session key, resolve via chatId lookup
    let resolvedTarget = target;
    if (!target.startsWith("agent:")) {
      const match = findSessionByChatId(target);
      if (match) {
        resolvedTarget = match.sessionKey;
      }
    }

    // Verify session exists
    const targetSession = getSession(resolvedTarget);
    if (!targetSession) {
      const sessions = listSessions();
      console.error(`[ERROR] Session not found: "${resolvedTarget}"\n`);
      console.log(`Available sessions:`);
      for (const s of sessions.slice(0, 10)) {
        const routing = s.lastChannel && s.lastTo
          ? `→ ${s.lastChannel}:${s.lastTo}`
          : "(no routing)";
        console.log(`  ${s.sessionKey} ${routing}`);
      }
      if (sessions.length > 10) {
        console.log(`  ... and ${sessions.length - 10} more (use cross_list to see all)`);
      }
      if (sessions.length === 0) {
        console.log(`  (no active sessions)`);
      }
      return { success: false, error: `Session not found: ${resolvedTarget}` };
    }

    // Resolve source (delivery routing)
    // Priority: explicit --channel/--to > session lastChannel > derived from key
    let source: { channel: string; accountId: string; chatId: string } | undefined;
    let sourceOrigin: string;

    if (channel && to) {
      // Explicit routing — no ambiguity
      source = { channel, accountId: "default", chatId: to };
      sourceOrigin = "explicit";
    } else if (targetSession?.lastChannel && targetSession.lastTo) {
      source = {
        channel: targetSession.lastChannel,
        accountId: targetSession.lastAccountId ?? "default",
        chatId: targetSession.lastTo,
      };
      sourceOrigin = "session";
    } else {
      const derived = deriveSourceFromSessionKey(resolvedTarget);
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
      // Include origin session and optional sender for attribution
      const ctx = getContext();
      const origin = ctx?.sessionKey ?? "unknown";
      const senderTag = sender ? `, sender: ${sender}` : "";
      prompt = `${PREFIX_MAP[crossType]} [from: ${origin}${senderTag}] ${message}`;
    } else {
      prompt = `${PREFIX_MAP[crossType]} ${message}`;
    }

    // Recover stored channel context from target session (group info, etc.)
    let context: ChannelContext | undefined;
    if (targetSession?.lastContext) {
      try {
        context = JSON.parse(targetSession.lastContext) as ChannelContext;
      } catch {
        // ignore parse errors
      }
    }

    await notif.emit(`ravi.${resolvedTarget}.prompt`, { prompt, source, context } as Record<string, unknown>);

    if (source) {
      const resolved = resolvedTarget !== target ? ` (resolved from ${target})` : "";
      console.log(`✓ [${type}] sent to ${resolvedTarget}${resolved} (routing: ${source.channel}:${source.chatId}, src: ${sourceOrigin})`);
    } else {
      console.log(`✓ [${type}] sent to ${resolvedTarget} (no routing — response won't reach a channel)`);
    }

    return { success: true, target: resolvedTarget, type, source };
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
