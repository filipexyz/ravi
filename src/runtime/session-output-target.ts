/**
 * Output target resolution for the session runtime.
 *
 * Implements the resolution order from `.ravi/specs/sessions/attach/SPEC.md`:
 *   1. Source chat, when that subscription has speech enabled.
 *   2. Attached default output chat, when that subscription has speech enabled.
 *   3. Fail closed → caller drops the external response and keeps the
 *      provider transcript inside the session.
 *
 * The resolver does NOT decide whether to drop a response; it just produces
 * the best available target (or `null`). The caller — `host-event-loop`'s
 * `emitResponse` — decides what to do with `null`.
 */

import { dbGetChat, dbGetSessionOutputAttachment, dbListSessionChatSubscriptions } from "../router/router-db.js";
import type { MessageTarget } from "./message-types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-output-target");

export interface ResolveSessionOutputTargetInput {
  sessionKey: string;
  fallback: MessageTarget | undefined;
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
  const fallbackChatId = input.fallback?.canonicalChatId;
  if (fallbackChatId) {
    const sourceSubscription = dbListSessionChatSubscriptions(input.sessionKey).find(
      (sub) => sub.chatId === fallbackChatId,
    );
    if (sourceSubscription?.speechMode === "speak") {
      const target = chatToMessageTarget(sourceSubscription.chatId, input.fallback);
      if (target) return { target, source: "source-chat" };
      log.warn("Session source subscription cannot be resolved to a MessageTarget", {
        sessionKey: input.sessionKey,
        chatId: sourceSubscription.chatId,
      });
    }
  }

  const attached = dbGetSessionOutputAttachment(input.sessionKey);
  if (attached?.speechMode === "speak") {
    const target = chatToMessageTarget(attached.chatId, input.fallback);
    if (target) return { target, source: "attached-output" };
    log.warn("Session output attachment cannot be resolved to a MessageTarget", {
      sessionKey: input.sessionKey,
      chatId: attached.chatId,
    });
  } else if (attached) {
    log.warn("Session output attachment is muted — dropping emit", {
      sessionKey: input.sessionKey,
      chatId: attached.chatId,
    });
  }
  return { target: null, source: "unresolved" };
}

function chatToMessageTarget(chatId: string, fallback: MessageTarget | undefined): MessageTarget | null {
  const chat = dbGetChat(chatId);
  if (!chat) return null;
  return {
    channel: chat.channel,
    accountId: chat.instanceId || fallback?.accountId || "",
    instanceId: chat.instanceId || undefined,
    chatId: chat.platformChatId,
    canonicalChatId: chat.id,
  };
}
