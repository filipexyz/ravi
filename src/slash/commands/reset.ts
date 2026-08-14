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
import { getSession, resetSessionIfUnchanged } from "../../router/sessions.js";
import { runProviderSessionLifecycleMutation } from "../../runtime/provider-session-lifecycle.js";
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
      channel: ctx.channelType,
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

    const session = getSession(sessionKey);
    const reset = session
      ? await runProviderSessionLifecycleMutation({
          session: { displayId: session.runtimeSessionDisplayId, params: session.runtimeSessionParams },
          mutate: () => resetSessionIfUnchanged(session),
        })
      : false;
    const bot = getBotInstance();
    const aborted = reset
      ? (bot?.abortSession(sessionName, {
          source: "slash",
          action: "/reset",
          reason: "slash_reset",
          actor: ctx.senderId,
        }) ?? false)
      : false;
    log.info("/reset abort result", { sessionName, aborted, botExists: !!bot });
    log.info("/reset result", { sessionKey, reset });

    if (reset) {
      return `✅ Sessão resetada (${agentId})`;
    }
    if (aborted) {
      return `⚠️ A execução foi interrompida, mas o reset não foi aplicado (${agentId})`;
    }
    if (session) {
      return `⚠️ A sessão mudou; o reset não foi aplicado (${agentId})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${agentId})`;
  },
};
