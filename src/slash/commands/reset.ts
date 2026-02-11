/**
 * /reset — Reset the agent session for the current chat
 *
 * 1. Aborts the streaming SDK session synchronously (in-process)
 * 2. Deletes the session entry from the database
 */

import { resolveRoute } from "../../router/resolver.js";
import { deleteSession } from "../../router/sessions.js";
import { getBotInstance } from "../../daemon.js";
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

    // Abort streaming session synchronously (no notif delay)
    const bot = getBotInstance();
    const aborted = bot?.abortSession(resolved.sessionKey) ?? false;

    const deleted = deleteSession(resolved.sessionKey);

    if (aborted || deleted) {
      return `✅ Sessão resetada (${resolved.agent.id})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${resolved.agent.id})`;
  },
};
