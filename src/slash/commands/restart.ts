/**
 * /restart — Restart the daemon with "server restarted" notification
 *
 * Usage:
 *   DM:    /restart              (restarts the daemon)
 *   DM:    /restart reason here  (restarts with custom reason)
 *   Group: /restart @bot         (same, but requires @mention like /reset)
 *
 * Spawns a detached `ravi daemon restart` process and returns immediately.
 */

import { spawn } from "node:child_process";
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

    const reason = ctx.args.length > 0 ? ctx.args.join(" ") : "server restarted";

    log.info("/restart called", { reason, by: ctx.senderId, isGroup: ctx.isGroup });

    // Strip RAVI_* env vars so the child doesn't think it's inside daemon
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("RAVI_")) delete cleanEnv[key];
    }

    const child = spawn("ravi", ["daemon", "restart", "-m", reason], {
      detached: true,
      stdio: "ignore",
      env: cleanEnv,
    });
    child.unref();

    return `🔄 Restarting... (${reason})`;
  },
};
