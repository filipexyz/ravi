/**
 * /reset — Reset the agent session for the current chat
 *
 * Usage:
 *   DM:    /reset              (resets the routed agent)
 *   Group: /reset              (resets the routed agent for this group)
 *   Group: /reset @agentName   (resets a specific agent — by ID or mention)
 *
 * 1. Aborts the streaming SDK session synchronously (in-process)
 * 2. Resets the session (clears SDK state but keeps routing/metadata)
 */

import { resolveRoute } from "../../router/resolver.js";
import { resetSession, findSessionByAttributes } from "../../router/sessions.js";
import { getBotInstance } from "../../daemon.js";
import { getContact } from "../../contacts.js";
import { logger } from "../../utils/logger.js";
import type { SlashCommand, SlashContext } from "../registry.js";

const log = logger.child("reset");

/**
 * Resolve agent ID from a /reset argument.
 * Tries: direct agent ID → contact lookup (WhatsApp sends LID for mentions).
 */
function resolveAgentArg(
  raw: string,
  agents: Record<string, unknown>,
): string | null {
  // Direct agent ID
  if (agents[raw]) return raw;

  // Resolve via contacts (WhatsApp @mention sends LID/phone)
  const contact = getContact(raw);
  if (contact?.agent_id && agents[contact.agent_id]) return contact.agent_id;

  return null;
}

export const resetCommand: SlashCommand = {
  name: "reset",
  description: "Reseta a sessão do agent nesse chat. Em grupo: /reset @agent",
  permission: "admin",
  handler: async (ctx: SlashContext): Promise<string> => {
    // Resolve the agent to reset
    const arg = ctx.args[0];
    let agentId: string;

    if (arg) {
      const raw = arg.replace(/^@/, "");
      const resolved = resolveAgentArg(raw, ctx.routerConfig.agents);
      if (resolved) {
        agentId = resolved;
      } else {
        // Mention didn't resolve to an agent (e.g. WhatsApp LID) — fall through to route
        const routeResolved = resolveRoute(ctx.routerConfig, {
          phone: ctx.senderId,
          channel: ctx.plugin.id,
          accountId: ctx.accountId,
          isGroup: ctx.isGroup,
          groupId: ctx.isGroup ? ctx.chatId : undefined,
        });
        agentId = routeResolved.agent.id;
      }
    } else {
      // No argument: resolve by route (works for both DM and group)
      const resolved = resolveRoute(ctx.routerConfig, {
        phone: ctx.senderId,
        channel: ctx.plugin.id,
        accountId: ctx.accountId,
        isGroup: ctx.isGroup,
        groupId: ctx.isGroup ? ctx.chatId : undefined,
      });
      agentId = resolved.agent.id;
    }

    // Resolve route to find the session (this creates/finds it via resolver)
    const resolved = resolveRoute(ctx.routerConfig, {
      phone: ctx.senderId,
      channel: ctx.plugin.id,
      accountId: ctx.accountId,
      isGroup: ctx.isGroup,
      groupId: ctx.isGroup ? ctx.chatId : undefined,
    });

    const sessionName = resolved.sessionName;
    const sessionKey = resolved.sessionKey;

    log.info("/reset called", { sessionName, sessionKey, agentId, isGroup: ctx.isGroup });

    const bot = getBotInstance();
    // Try abort by session name first (streaming sessions are keyed by name)
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
