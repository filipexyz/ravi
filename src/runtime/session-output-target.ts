/**
 * Output target resolution for the session runtime.
 *
 * Implements the resolution order from `.ravi/specs/sessions/attach/SPEC.md`:
 *   1. The attached source chat for an inbound turn.
 *   2. The default output chat only for a source-less turn.
 *   3. Fail closed → caller drops the external response and keeps the
 *      provider transcript inside the session.
 *
 * The resolver does NOT decide whether to drop a response; it just produces
 * the best available target (or `null`). The caller — `host-event-loop`'s
 * `emitResponse` — decides what to do with `null`.
 */

import {
  dbFindChat,
  dbGetChat,
  dbGetSessionOutputAttachment,
  dbListSessionChatSubscriptions,
  type SessionChatSubscriptionRecord,
} from "../router/router-db.js";
import type { MessageTarget } from "./message-types.js";
import { sourceMatchesChat } from "./session-chat-identity.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-output-target");

export interface ResolveSessionOutputTargetInput {
  sessionKey: string;
  fallback: MessageTarget | undefined;
  /**
   * Source-less turns may use the session default output attachment.
   * CLI-only `_cliDestination` turns stay on the waiting CLI — pass false.
   * Other session-relay continues rebind the existing primary/default output.
   */
  allowDefaultOutput?: boolean;
}

export type ResolveSource = "source-chat" | "attached-output" | "unresolved";

export interface ResolvedSessionOutputTarget {
  target: MessageTarget | null;
  source: ResolveSource;
}

/**
 * Resolve the target chat for an outbound response from this session.
 */
export function resolveSessionOutputTarget(input: ResolveSessionOutputTargetInput): ResolvedSessionOutputTarget {
  if (input.fallback) {
    const sourceSubscription = matchSubscriptionForFallback(input.sessionKey, input.fallback);
    if (sourceSubscription) {
      const target = chatToMessageTarget(sourceSubscription.chatId, input.fallback);
      if (target) return { target, source: "source-chat" };
      log.warn("Session source subscription cannot be resolved to a MessageTarget", {
        sessionKey: input.sessionKey,
        chatId: sourceSubscription.chatId,
      });
    }
    return { target: null, source: "unresolved" };
  }

  if (input.allowDefaultOutput === false) {
    return { target: null, source: "unresolved" };
  }

  const attached = dbGetSessionOutputAttachment(input.sessionKey);
  if (attached) {
    const target = chatToMessageTarget(attached.chatId, input.fallback);
    if (target) return { target, source: "attached-output" };
    log.warn("Session output attachment cannot be resolved to a MessageTarget", {
      sessionKey: input.sessionKey,
      chatId: attached.chatId,
    });
  }
  return { target: null, source: "unresolved" };
}

function matchSubscriptionForFallback(
  sessionKey: string,
  fallback: MessageTarget,
): SessionChatSubscriptionRecord | undefined {
  const subscriptions = dbListSessionChatSubscriptions(sessionKey);
  if (fallback.canonicalChatId) {
    const exact = subscriptions.find((sub) => sub.chatId === fallback.canonicalChatId);
    if (exact) return exact;
  }
  const resolvedChat = lookupChatForFallback(fallback);
  if (resolvedChat) {
    const byResolved = subscriptions.find((sub) => sub.chatId === resolvedChat.id);
    if (byResolved) return byResolved;
  }
  return subscriptions.find((sub) => {
    const chat = dbGetChat(sub.chatId);
    return chat ? sourceMatchesChat(fallback, chat) : false;
  });
}

function lookupChatForFallback(fallback: MessageTarget) {
  if (fallback.canonicalChatId) {
    const byId = dbGetChat(fallback.canonicalChatId);
    if (byId) return byId;
  }
  const platformChatId = fallback.chatId?.trim();
  if (!platformChatId || !fallback.channel) return null;
  const isGroup = platformChatId.startsWith("group:") || platformChatId.endsWith("@g.us");
  return dbFindChat({
    channel: fallback.channel,
    instanceId: fallback.instanceId ?? fallback.accountId,
    platformChatId,
    ...(isGroup ? { chatType: "group" as const } : {}),
  });
}

function chatToMessageTarget(chatId: string, fallback: MessageTarget | undefined): MessageTarget | null {
  const chat = dbGetChat(chatId);
  if (!chat) return null;
  const target = splitCanonicalPlatformChat(chat.platformChatId);
  return {
    channel: chat.channel,
    accountId: chat.instanceId || fallback?.accountId || "",
    instanceId: chat.instanceId || undefined,
    canonicalChatId: chat.id,
    ...target,
  };
}

function splitCanonicalPlatformChat(platformChatId: string): { chatId: string; threadId?: string } {
  const separator = platformChatId.indexOf("#");
  if (separator === -1) return { chatId: platformChatId };
  const chatId = platformChatId.slice(0, separator);
  const threadId = platformChatId.slice(separator + 1);
  return threadId ? { chatId, threadId } : { chatId };
}
