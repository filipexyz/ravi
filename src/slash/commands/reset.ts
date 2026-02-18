/**
 * /reset — Reset the agent session for the current chat
 *
 * Usage:
 *   DM:    /reset              (resets the routed agent)
 *   Group: /reset @bot         (resets the mentioned bot's session in this group)
 *
 * 1. Aborts the streaming SDK session synchronously (in-process)
 * 2. Resets the session (clears SDK state but keeps routing/metadata)
 */

import { resolveRoute } from "../../router/resolver.js";
import { resetSession } from "../../router/sessions.js";
import { getBotInstance } from "../../daemon.js";
import { logger } from "../../utils/logger.js";
import type { SlashCommand, SlashContext } from "../registry.js";

const log = logger.child("reset");

export const resetCommand: SlashCommand = {
  name: "reset",
  description: "Reseta a sessão do agent nesse chat. Em grupo: /reset @agent",
  permission: "admin",
  handler: async (ctx: SlashContext): Promise<string> => {
    // In groups: require @mention (confirms which bot to reset)
    if (ctx.isGroup && !ctx.mentions?.length) {
      return "⚠️ Em grupo, use /reset @agent (mencione o bot que quer resetar)";
    }

    // Resolve session by route (group route or DM route)
    const resolved = resolveRoute(ctx.routerConfig, {
      phone: ctx.senderId,
      channel: ctx.plugin.id,
      accountId: ctx.accountId,
      isGroup: ctx.isGroup,
      groupId: ctx.isGroup ? ctx.chatId : undefined,
    });

    if (!resolved) {
      return "⚠️ No route configured for this account";
    }

    const { sessionName, sessionKey } = resolved;
    const agentId = resolved.agent.id;

    log.info("/reset called", { sessionName, sessionKey, agentId, isGroup: ctx.isGroup });

    const bot = getBotInstance();
    const aborted = bot?.abortSession(sessionName) ?? false;
    log.info("/reset abort result", { sessionName, aborted, botExists: !!bot });

    const reset = resetSession(sessionKey);
    log.info("/reset result", { sessionKey, reset });

    if (aborted || reset) {
      return `✅ Sessão resetada (${agentId})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${agentId})`;
  },
};
