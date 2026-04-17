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

    const rawArgs = ctx.args.join(" ");
    const force = rawArgs.includes("--force") || rawArgs.includes("-f");
    const reason = ctx.args.filter((a) => a !== "--force" && a !== "-f").join(" ") || "server restarted";

    log.info("/restart called", { reason, by: ctx.senderId, isGroup: ctx.isGroup, force });

    // Safety check: block restart if tasks are actively running
    if (!force) {
      try {
        const { dbGetActiveTasksBlocking } = await import("../../tasks/task-db.js");
        const activeTasks = dbGetActiveTasksBlocking();
        if (activeTasks.length > 0) {
          const summary = activeTasks
            .slice(0, 5)
            .map((t: { id: string; title: string; status: string }) => `• ${t.id} "${t.title}" (${t.status})`)
            .join("\n");
          const extra = activeTasks.length > 5 ? `\n... e mais ${activeTasks.length - 5} tasks` : "";
          return (
            `⛔ Restart bloqueado: ${activeTasks.length} task(s) em andamento.\n\n` +
            `${summary}${extra}\n\n` +
            `O restart mata todas as sessões e interrompe trabalho ativo.\n` +
            `Use /restart --force para ignorar.`
          );
        }
      } catch (err) {
        log.warn("Failed to check active tasks", { error: String(err) });
      }
    }

    // Strip RAVI_* env vars so the child doesn't think it's inside daemon
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("RAVI_")) delete cleanEnv[key];
    }

    const args = ["daemon", "restart", "-m", reason];
    if (force) args.push("--force");

    const child = spawn("ravi", args, {
      detached: true,
      stdio: "ignore",
      env: cleanEnv,
    });
    child.unref();

    return `🔄 Restarting... (${reason})`;
  },
};
