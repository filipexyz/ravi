/**
 * Output target resolution for the session runtime.
 *
 * Implements the resolution order from `.ravi/specs/sessions/attach/SPEC.md`:
 *   1. Explicit per-turn target → use it.
 *   2. Focus → if `session_focus.chat_id` is set and the subscription is
 *      still active, use that chat.
 *   3. Inbound source → fall back to the chat of the inbound message that
 *      produced this turn (legacy behaviour).
 *   4. Fail closed → caller drops the response and emits a trace.
 *
 * The resolver does NOT decide whether to drop a response; it just produces
 * the best available target (or `null`). The caller — `host-event-loop`'s
 * `emitResponse` — decides what to do with `null`.
 */

import { dbGetChat, dbGetSessionFocus, dbListSessionChatSubscriptions } from "../router/router-db.js";
import type { MessageTarget } from "./message-types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-output-target");

export interface ResolveSessionOutputTargetInput {
  sessionKey: string;
  fallback: MessageTarget | undefined;
}

export type ResolveSource = "explicit" | "focus" | "inbound-source" | "unresolved";

export interface ResolvedSessionOutputTarget {
  target: MessageTarget | null;
  source: ResolveSource;
}

/**
 * Resolve the target chat for an outbound response from this session.
 *
 * The "explicit per-turn target" branch is treated as: if the runtime
 * (or a tool) passed an explicit target into `emitResponse`, that wins.
 * Today only `streaming.currentSource` is consulted, so this branch
 * collapses into "use fallback if focus is unset".
 */
export function resolveSessionOutputTarget(input: ResolveSessionOutputTargetInput): ResolvedSessionOutputTarget {
  const focus = dbGetSessionFocus(input.sessionKey);
  if (focus) {
    const subscriptions = dbListSessionChatSubscriptions(input.sessionKey);
    const stillSubscribed = subscriptions.some((s) => s.chatId === focus.chatId);
    if (!stillSubscribed) {
      log.warn("Session focus references a chat that is no longer subscribed; falling back to inbound source", {
        sessionKey: input.sessionKey,
        focusChatId: focus.chatId,
      });
    } else {
      const target = chatToMessageTarget(focus.chatId, input.fallback);
      if (target) return { target, source: "focus" };
      log.warn("Session focus chat cannot be resolved to a MessageTarget; falling back to inbound source", {
        sessionKey: input.sessionKey,
        focusChatId: focus.chatId,
      });
    }
  }

  if (input.fallback) {
    return { target: input.fallback, source: "inbound-source" };
  }
  return { target: null, source: "unresolved" };
}

function chatToMessageTarget(focusChatId: string, fallback: MessageTarget | undefined): MessageTarget | null {
  const chat = dbGetChat(focusChatId);
  if (!chat) return null;
  return {
    channel: chat.channel,
    accountId: chat.instanceId || fallback?.accountId || "",
    instanceId: chat.instanceId || undefined,
    chatId: chat.platformChatId,
    canonicalChatId: chat.id,
    // The focus target chat may have nothing to do with the inbound that
    // produced this turn. We deliberately drop the inbound's per-actor
    // fields — actorType/contactId/platformIdentityId — because they
    // describe a person on a different surface. Operator traces should
    // pick the right actor for the focus target separately.
  };
}
