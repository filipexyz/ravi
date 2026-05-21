/**
 * Output target resolution for the session runtime.
 *
 * Implements the resolution order from `.ravi/specs/sessions/attach/SPEC.md`:
 *   1. Attached output chat → the chat selected by `ravi sessions attach`.
 *   2. Fail closed → caller drops the external response and keeps the
 *      provider transcript inside the session.
 *
 * The resolver does NOT decide whether to drop a response; it just produces
 * the best available target (or `null`). The caller — `host-event-loop`'s
 * `emitResponse` — decides what to do with `null`.
 */

import { dbGetChat, dbGetSessionOutputAttachment } from "../router/router-db.js";
import type { MessageTarget } from "./message-types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-output-target");

export interface ResolveSessionOutputTargetInput {
  sessionKey: string;
  fallback: MessageTarget | undefined;
}

export type ResolveSource = "attached-output" | "unresolved";

export interface ResolvedSessionOutputTarget {
  target: MessageTarget | null;
  source: ResolveSource;
}

/**
 * Resolve the target chat for an outbound response from this session.
 */
export function resolveSessionOutputTarget(input: ResolveSessionOutputTargetInput): ResolvedSessionOutputTarget {
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
