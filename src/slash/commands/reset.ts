/**
 * /reset — Reset the agent session for the current chat
 *
 * Usage:
 *   DM:    /reset              (resets the routed agent)
 *   Group: /reset              (resets the routed agent for this group)
 *   Group: /reset @agentName   (resets a specific agent — by ID or mention)
 *
 * 1. Aborts the streaming SDK session synchronously (in-process)
 * 2. Deletes the session entry from the database
 */

import { resolveRoute } from "../../router/resolver.js";
import { deleteSession } from "../../router/sessions.js";
import { buildSessionKey } from "../../router/session-key.js";
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

    const sessionKey = buildSessionKey({
      agentId,
      channel: ctx.plugin.id,
      accountId: ctx.accountId,
      peerKind: ctx.isGroup ? "group" : "dm",
      peerId: ctx.isGroup ? ctx.chatId : ctx.senderId,
      dmScope: ctx.isGroup ? undefined : "per-peer",
    });

    log.info("/reset called", { sessionKey, agentId, isGroup: ctx.isGroup });

    const bot = getBotInstance();
    const aborted = bot?.abortSession(sessionKey) ?? false;
    log.info("/reset abort result", { sessionKey, aborted, botExists: !!bot });

    const deleted = deleteSession(sessionKey);
    log.info("/reset delete result", { sessionKey, deleted });

    if (aborted || deleted) {
      return `✅ Sessão resetada (${agentId})`;
    }
    return `✅ Nenhuma sessão ativa encontrada (${agentId})`;
  },
};
