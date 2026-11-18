/**
 * Owner of a follow trigger armed from inside a Slack thread.
 *
 * A follow (`gh-follow:*`, `page-comment:*`) is a durable subscription the
 * product creates on its own when a session publishes something. The session
 * that publishes from a thread is a child that closes; the subscription has to
 * outlive it. So a follow armed from a thread belongs to the thread's durable
 * parent, the same way a PR follow always has. Without that the child cannot
 * close: `sessions close-thread` refuses while an active trigger still addresses
 * it (`THREAD_TRIGGERS_PENDING`).
 */

import type { Database } from "bun:sqlite";
import { findSlackThreadLifecycleByChildRef } from "../channels/slack/thread-lifecycle-store.js";
import { getSession, resolveSession } from "../router/sessions.js";
import type { TriggerReplySource } from "./types.js";

export interface FollowOwnerContext {
  agentId?: string;
  accountId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
}

/**
 * Resolves who must receive a follow that `context` is about to arm.
 *
 * - A session that is not a Slack thread child owns its own follow: the context
 *   comes back unchanged.
 * - A thread child hands the follow to its durable parent, with the parent's
 *   agent, the thread's account and the parent's chat as the reply source. The
 *   child's frozen source is never kept as a fallback.
 * - A session that looks like a thread but has no lifecycle, or whose parent is
 *   gone or is itself a thread, fails closed: the caller must not arm a follow
 *   that a later close would orphan. `subject` names the follow in the error.
 */
export function resolveDurableFollowOwner<T extends FollowOwnerContext>(
  context: T,
  subject: string,
  database?: Database,
): T {
  const ref = context.sessionKey ?? context.sessionName;
  if (!ref) return context;
  const thread = findSlackThreadLifecycleByChildRef(ref, database);
  if (!thread) {
    const session = database
      ? (database
          .query("SELECT session_key AS sessionKey FROM sessions WHERE session_key=? OR name=?")
          .get(ref, ref) as { sessionKey: string } | null)
      : resolveSession(ref);
    if (
      ref.includes(":thread:") ||
      session?.sessionKey.includes(":thread:") ||
      (!session && context.source?.channel === "slack" && context.source.threadId)
    ) {
      throw new Error(`Cannot register ${subject}: thread lifecycle is missing or ambiguous.`);
    }
    return context;
  }
  const parent = database
    ? (database
        .query("SELECT session_key AS sessionKey, name, agent_id AS agentId FROM sessions WHERE session_key=?")
        .get(thread.parentSessionKey) as { sessionKey: string; name: string | null; agentId: string } | null)
    : getSession(thread.parentSessionKey);
  if (!parent || parent.sessionKey.includes(":thread:")) {
    throw new Error(`Cannot register ${subject}: durable parent session is missing.`);
  }
  return {
    ...context,
    agentId: parent.agentId,
    accountId: thread.accountId,
    sessionName: parent.name ?? parent.sessionKey,
    sessionKey: parent.sessionKey,
    // Never keep the child's frozen replySource as fallback after handoff.
    source: { channel: "slack", accountId: thread.accountId, chatId: thread.platformChatId },
  };
}
