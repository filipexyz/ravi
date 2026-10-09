/**
 * Private delivery for `ravi link`.
 *
 * The approval URL carries a single-use token, so it goes straight from the
 * daemon to the chat platform: never through `ravi.outbound.deliver`, NATS,
 * logs, agent output or the session transcript.
 */

import { resolveOutboundAccount } from "../channels/account-resolution.js";
import { canonicalChannelId } from "../channels/capabilities.js";
import { lookupSlackUserEmail, sendSlackText } from "../channels/slack/text-send.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { LinkRequester } from "../cloud-auth/link-identity.js";
import { resolveOmniConnection } from "../omni-config.js";
import { OmniSender } from "../omni/sender.js";

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;

export interface LinkChatTarget {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

/** Where the private message to the requester goes. Derived from the turn actor only. */
export interface LinkDmRoute {
  channel: "slack" | "whatsapp";
  accountId: string;
  recipient: string;
  /** Slack user id used for the optional email hint. */
  slackUserId?: string;
}

export interface LinkMessenger {
  /** Returns the chat the message landed in (Slack answers a user id with its DM channel). */
  send(target: LinkChatTarget, text: string, options?: { privateLink?: boolean }): Promise<{ chatId: string }>;
  /** Best-effort email of the person on the chat platform. Null when unknown. */
  lookupEmail(route: LinkDmRoute): Promise<string | null>;
}

/**
 * Resolve the private chat with the author. Slack posts to the user id (Slack
 * opens the DM with the app). WhatsApp answers in the same chat when the turn
 * is already a direct chat, otherwise messages the sender's own number.
 */
export function resolveLinkDmRoute(
  requester: LinkRequester,
  resolveAccount: typeof resolveOutboundAccount = resolveOutboundAccount,
): LinkDmRoute {
  const origin = requester.origin;
  const sender = requester.platformUserId;
  if (!origin || !sender) throw dmUnsupported();

  const channel = canonicalChannelId(origin.channel);
  if (channel === "slack") {
    const resolved = resolveAccount(origin.accountId, { channel: "slack" });
    if (resolved.kind !== "native" || resolved.provider !== "slack" || !SLACK_USER_ID_PATTERN.test(sender)) {
      throw dmUnsupported();
    }
    return { channel: "slack", accountId: resolved.accountId, recipient: sender, slackUserId: sender };
  }

  if (channel === "whatsapp") {
    const resolved = resolveAccount(origin.accountId, { channel: "whatsapp" });
    if (resolved.kind !== "omni") throw dmUnsupported();
    const recipient = isWhatsAppGroupChat(origin.chatId) ? sender : origin.chatId;
    if (isWhatsAppGroupChat(recipient)) throw dmUnsupported();
    return { channel: "whatsapp", accountId: origin.accountId, recipient };
  }

  throw dmUnsupported();
}

export function createChannelLinkMessenger(): LinkMessenger {
  return {
    async send(target, text, options = {}) {
      const channel = canonicalChannelId(target.channel);
      if (channel === "slack") {
        const delivered = await sendSlackText({
          accountId: target.accountId,
          chatId: target.chatId,
          text,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          ...(options.privateLink ? { unfurlLinks: false } : {}),
        });
        const landed = delivered.raw.channel;
        return { chatId: typeof landed === "string" && landed ? landed : target.chatId };
      }

      if (channel === "whatsapp") {
        const resolved = resolveOutboundAccount(target.accountId, { channel: "whatsapp" });
        const connection = resolveOmniConnection();
        if (resolved.kind !== "omni" || !connection) throw new Error("WhatsApp delivery is not configured");
        const sender = new OmniSender(connection.apiUrl, connection.apiKey);
        await sender.send(resolved.instanceId, toWhatsAppJid(target.chatId), text);
        return { chatId: target.chatId };
      }

      throw new Error(`Link messages are not supported on ${channel}`);
    },

    async lookupEmail(route) {
      if (route.channel !== "slack" || !route.slackUserId) return null;
      try {
        return await lookupSlackUserEmail({ accountId: route.accountId, userId: route.slackUserId });
      } catch {
        return null;
      }
    },
  };
}

function isWhatsAppGroupChat(chatId: string): boolean {
  return chatId.startsWith("group:") || chatId.endsWith("@g.us");
}

function toWhatsAppJid(chatId: string): string {
  return chatId.startsWith("group:") ? `${chatId.slice("group:".length)}@g.us` : chatId;
}

function dmUnsupported(): CloudAuthError {
  return new CloudAuthError(
    "LINK_DM_UNSUPPORTED",
    "Ravi cannot send a private message to this person on this channel.",
  );
}

// ---------------------------------------------------------------------------
// Copy (PT-BR, the language the chats run in)
// ---------------------------------------------------------------------------

export function linkRequestDmText(input: {
  approveUrl: string;
  channel: LinkDmRoute["channel"];
  displayName: string | null;
  expiresInMinutes: number;
}): string {
  const greeting = input.displayName ? `Oi, ${firstName(input.displayName)}!` : "Oi!";
  const link = input.channel === "slack" ? `[Abrir e aprovar o vínculo](${input.approveUrl})` : input.approveUrl;
  return [
    `${greeting} Você pediu para vincular este chat à sua conta do Ravi Console.`,
    link,
    `O link é só seu, vale por ${input.expiresInMinutes} minutos e funciona uma vez. Se não foi você que pediu, ignore esta mensagem.`,
  ].join("\n\n");
}

export function linkApprovedDmText(consoleUrl: string): string {
  return `Pronto: este chat está vinculado à sua conta do Ravi Console. Para desfazer, peça para eu rodar \`ravi unlink\` ou acesse ${consoleUrl}/link.`;
}

export function linkApprovedOriginText(displayName: string | null): string {
  return displayName ? `Vínculo confirmado para ${firstName(displayName)}. ✓` : "Vínculo confirmado. ✓";
}

export function linkDeniedDmText(): string {
  return "Tudo certo, não vinculei nada.";
}

export function linkExpiredDmText(): string {
  return "O link de vínculo expirou sem aprovação. Se ainda quiser vincular, é só pedir de novo.";
}

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}
