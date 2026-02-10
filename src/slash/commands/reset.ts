/**
 * /reset — Reset the agent session for the current chat
 */

import { resolveRoute } from "../../router/resolver.js";
import { deleteSession } from "../../router/sessions.js";
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

    const deleted = deleteSession(resolved.sessionKey);

    if (deleted) {
      return `✅ Sessão resetada (${resolved.agent.id})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${resolved.agent.id})`;
  },
};
