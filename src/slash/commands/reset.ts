/**
 * /reset — Reset the agent session for the current chat
 *
 * 1. Emits abort event so the bot kills the streaming SDK process
 * 2. Deletes the session entry from the database
 */

import { resolveRoute } from "../../router/resolver.js";
import { deleteSession } from "../../router/sessions.js";
import { notif } from "../../notif.js";
import type { SlashCommand, SlashContext } from "../registry.js";

export const resetCommand: SlashCommand = {
  name: "reset",
  description: "Reseta a sessão do agent nesse chat",
  permission: "admin",
  handler: async (ctx: SlashContext): Promise<string> => {
    const resolved = resolveRoute(ctx.routerConfig, {
      phone: ctx.senderId,
      channel: ctx.plugin.id,
      accountId: ctx.accountId,
      isGroup: ctx.isGroup,
      groupId: ctx.isGroup ? ctx.chatId : undefined,
    });

    // Abort streaming session (kills SDK process in bot.ts)
    await notif.emit("ravi.session.abort", {
      sessionKey: resolved.sessionKey,
    });

    const deleted = deleteSession(resolved.sessionKey);

    if (deleted) {
      return `✅ Sessão resetada (${resolved.agent.id})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${resolved.agent.id})`;
  },
};
