/**
 * /reset — Reset the agent session for the current chat
 *
 * 1. Aborts the streaming SDK session synchronously (in-process)
 * 2. Deletes the session entry from the database
 */

import { resolveRoute } from "../../router/resolver.js";
import { deleteSession } from "../../router/sessions.js";
import { getBotInstance } from "../../daemon.js";
import { logger } from "../../utils/logger.js";
import type { SlashCommand, SlashContext } from "../registry.js";

const log = logger.child("reset");

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

    log.info("/reset called", { sessionKey: resolved.sessionKey, agentId: resolved.agent.id });

    // Abort streaming session synchronously (no notif delay)
    const bot = getBotInstance();
    const aborted = bot?.abortSession(resolved.sessionKey) ?? false;
    log.info("/reset abort result", { sessionKey: resolved.sessionKey, aborted, botExists: !!bot });

    const deleted = deleteSession(resolved.sessionKey);
    log.info("/reset delete result", { sessionKey: resolved.sessionKey, deleted });

    if (aborted || deleted) {
      return `✅ Sessão resetada (${resolved.agent.id})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${resolved.agent.id})`;
  },
};
