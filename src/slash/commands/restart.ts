/**
 * /restart — Restart the daemon with "server restarted" notification
 *
 * Usage:
 *   DM:    /restart              (restarts the daemon)
 *   DM:    /restart reason here  (restarts with custom reason)
 *   Group: /restart @bot         (same, but requires @mention like /reset)
 *
 * Spawns `ravi daemon restart` in a child process and returns immediately.
 */

import { spawn } from "node:child_process";
import { resolveRoute } from "../../router/resolver.js";
import { logger } from "../../utils/logger.js";
import type { SlashCommand, SlashContext } from "../registry.js";

const log = logger.child("restart");

export const restartCommand: SlashCommand = {
  name: "restart",
  description: "Restarta o daemon. Em grupo: /restart @agent",
  permission: "admin",
  handler: async (ctx: SlashContext): Promise<string> => {
    // In groups: require @mention (same UX as /reset)
    if (ctx.isGroup && !ctx.mentions?.length) {
      return "⚠️ Em grupo, use /restart @agent (mencione o bot)";
    }

    const reason = ctx.args.join(" ").trim() || "server restarted";
    const resolved = resolveRoute(ctx.routerConfig, {
      phone: ctx.senderId,
      channel: ctx.channelType,
      accountId: ctx.accountId,
      isGroup: ctx.isGroup,
      groupId: ctx.isGroup ? ctx.chatId : undefined,
    });

    log.info("/restart called", { reason, by: ctx.senderId, isGroup: ctx.isGroup, sessionName: resolved?.sessionName });

    // Replace daemon-level env with the slash command's route context. The CLI
    // restart handoff will persist this context before spawning the actual restart.
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("RAVI_")) delete cleanEnv[key];
    }
    if (resolved) {
      cleanEnv.RAVI_SESSION_KEY = resolved.sessionKey;
      cleanEnv.RAVI_SESSION_NAME = resolved.sessionName;
      cleanEnv.RAVI_AGENT_ID = resolved.agent.id;
    }

    const args = ["daemon", "restart", "-m", reason];

    const child = spawn("ravi", args, {
      detached: true,
      stdio: "ignore",
      env: cleanEnv,
    });
    child.unref();

    return `🔄 Restarting... (${reason})`;
  },
};
