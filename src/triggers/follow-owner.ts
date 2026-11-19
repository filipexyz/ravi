/**
 * Owner of a follow trigger armed from inside a Slack thread.
 *
 * A follow (`gh-follow:*`, `page-comment:*`) is a durable subscription the
 * product creates on its own when a session publishes something. The session
 * that publishes from a thread is a child that closes; the subscription has to
 * outlive it. So a follow armed from a thread belongs to the thread's durable
 * parent. Without that the child cannot close: `sessions close-thread` refuses
 * while an active trigger still addresses it (`THREAD_TRIGGERS_PENDING`).
 *
 * One exception, for the PR follow only (`openThreadOwns`): while its thread is
 * open, the child that published is the one who must react to the CI result, so
 * the follow addresses the child and its thread. Closing the thread hands the
 * follow to the durable parent (`handOffClosingThreadFollows`), so the child can
 * still close and the subscription still outlives it.
 */

import type { Database } from "bun:sqlite";
import { findSlackThreadLifecycleByChildRef } from "../channels/slack/thread-lifecycle-store.js";
import { getSession, resolveSession } from "../router/sessions.js";
import { dbListTriggers, dbUpdateTrigger } from "./triggers-db.js";
import type { TriggerReplySource } from "./types.js";

export interface FollowOwnerContext {
  agentId?: string;
  accountId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
}

/** Separates a thread child's session key from its parent's. Threads of any channel use it. */
const THREAD_KEY_MARKER = ":thread:";

/** A Slack thread's id is the timestamp of its root message, `1795035613.049969`. */
const SLACK_THREAD_ID = /^\d+\.\d+$/;

/** What follows the last `:thread:` of a session key; `undefined` when the key is not a thread's. */
function threadIdOfKey(key: string | undefined): string | undefined {
  const at = key?.lastIndexOf(THREAD_KEY_MARKER) ?? -1;
  return key !== undefined && at >= 0 ? key.slice(at + THREAD_KEY_MARKER.length) : undefined;
}

/**
 * What a missing lifecycle refuses.
 *
 * - `any-thread` (default): every session that looks like a thread, whatever its
 *   channel. The rule of the PR follow and of `ravi pr publish`, which also
 *   validate the publisher's lineage before anything is created.
 * - `slack-thread`: only a session the Slack thread registry should hold a row
 *   for. A `:thread:` key alone does not say so: a thread of another channel and a
 *   task's own thread (`agent:<agent>:thread:thr_…`) carry the same marker, and
 *   `sessions close-thread` never touches them. Only a thread whose id is a Slack
 *   timestamp is a Slack thread child, so another kind of thread owns its follow.
 */
export type DurableFollowRefusal = "any-thread" | "slack-thread";

export interface DurableFollowOwnerOptions {
  refuse?: DurableFollowRefusal;
  /**
   * The follow stays with the Slack thread child while its thread is open: the
   * child and the thread itself receive it. A closed thread still hands it to
   * the durable parent. Only a follow whose close hands it off may ask for this.
   */
  openThreadOwns?: boolean;
}

/**
 * Whether a session with no lifecycle row is one the follow must not be armed on.
 * `keys` are the ref and the key of its session row, if there is a row. A ref that
 * is not a key (a session name with no row to read the key from) is a Slack thread
 * when its source says so, under either rule.
 */
function missingLifecycleIsRefused(
  refuse: DurableFollowRefusal,
  keys: Array<string | undefined>,
  hasSessionRow: boolean,
  source: TriggerReplySource | undefined,
): boolean {
  const isThreadKey =
    refuse === "slack-thread"
      ? (key: string | undefined) => SLACK_THREAD_ID.test(threadIdOfKey(key) ?? "")
      : (key: string | undefined) => key?.includes(THREAD_KEY_MARKER) === true;
  if (keys.some(isThreadKey)) return true;
  return !hasSessionRow && source?.channel === "slack" && Boolean(source.threadId);
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
 *   that a later close would orphan. What "looks like a thread" covers is
 *   `options.refuse`. `subject` names the follow in the error.
 */
export function resolveDurableFollowOwner<T extends FollowOwnerContext>(
  context: T,
  subject: string,
  database?: Database,
  options: DurableFollowOwnerOptions = {},
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
    const keys = [ref, session?.sessionKey];
    if (missingLifecycleIsRefused(options.refuse ?? "any-thread", keys, Boolean(session), context.source)) {
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
  if (options.openThreadOwns && thread.status === "open" && thread.childSessionKey && thread.providerThreadId) {
    const child = database
      ? (database
          .query("SELECT session_key AS sessionKey, name, agent_id AS agentId FROM sessions WHERE session_key=?")
          .get(thread.childSessionKey) as { sessionKey: string; name: string | null; agentId: string } | null)
      : getSession(thread.childSessionKey);
    // The parent was checked above: the follow may only be armed where a later close can still hand it off.
    // A child whose session row is gone cannot receive anything: the parent owns it.
    if (child) {
      return {
        ...context,
        agentId: child.agentId,
        accountId: thread.accountId,
        sessionName: child.name ?? child.sessionKey,
        sessionKey: child.sessionKey,
        source: {
          channel: "slack",
          accountId: thread.accountId,
          chatId: thread.platformChatId,
          threadId: thread.providerThreadId,
        },
      };
    }
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

/** The name `gh-watch` gives a PR follow trigger (`gh-follow:<repo>#<number>`). */
const GH_FOLLOW_TRIGGER_PREFIX = "gh-follow:";

/**
 * A thread that is closing hands the PR follows addressed to its child to its
 * durable parent first, so the close is not refused (`THREAD_TRIGGERS_PENDING`)
 * and the subscription outlives the child. Returns the ids it moved; a follow
 * already owned by the parent, and any other kind of trigger, are left alone.
 */
export function handOffClosingThreadFollows(
  child: { childSessionKey: string; childSessionName?: string },
  database?: Database,
): string[] {
  const moved: string[] = [];
  for (const trigger of dbListTriggers()) {
    if (!trigger.name.startsWith(GH_FOLLOW_TRIGGER_PREFIX) || !trigger.replySession) continue;
    if (trigger.replySession !== child.childSessionKey && trigger.replySession !== child.childSessionName) continue;
    const owner = resolveDurableFollowOwner(
      { sessionKey: child.childSessionKey, sessionName: child.childSessionName, source: trigger.replySource },
      "PR follow",
      database,
    );
    const target = owner.sessionName ?? owner.sessionKey;
    if (!target || target === trigger.replySession) continue;
    dbUpdateTrigger(trigger.id, {
      agentId: owner.agentId,
      accountId: owner.accountId,
      replySession: target,
      replySource: owner.source,
    });
    moved.push(trigger.id);
  }
  return moved;
}
