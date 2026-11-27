/**
 * Which notices wait in the session inbox. Spec: `runtime/session-inbox`.
 *
 * The decision lives in the core and never reads a channel: an adapter (Slack thread lifecycle,
 * any other) asks for the mode and follows it. Only notices that inform (thread progress with
 * nothing awaited, thread results) may be deferred, and only for parent sessions the operator
 * listed in `inbox.threadNotices.sessions` (comma separated session names or keys; empty = off)
 * whose default chat is the owner's direct chat. A listed parent the owner cannot reach in a DM
 * (a channel session, a group) would never drain, so its notices stay immediate.
 * Anything that asks for action stays immediate: a handoff awaiting the parent, a thread that needs
 * attention, a turn that ended without returning.
 */

import { dbGetSetting } from "../router/router-db.js";
import { isInboxOwnerSession } from "./owner.js";

export const INBOX_THREAD_NOTICES_SETTING = "inbox.threadNotices.sessions";

export type ThreadNoticeKind = "progress" | "closed" | "attention" | "unreturned";

export interface ThreadNoticeDeliveryInput {
  kind: ThreadNoticeKind;
  /** The report ends with `--awaiting <kind>`: the parent must act. */
  awaiting: boolean;
  parentSessionName?: string | null;
  parentSessionKey?: string | null;
}

export interface ThreadNoticePolicyDeps {
  setting?: () => string | null;
  /** Whether the owner drains this session from a DM (owner.ts); without it nothing is deferred. */
  isOwnerSession?: (sessionKey: string) => boolean;
}

export function deferredThreadNoticeSessions(deps: ThreadNoticePolicyDeps = {}): Set<string> {
  const raw = (deps.setting ?? (() => dbGetSetting(INBOX_THREAD_NOTICES_SETTING)))() ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function threadNoticeDelivery(
  input: ThreadNoticeDeliveryInput,
  deps: ThreadNoticePolicyDeps = {},
): "now" | "deferred" {
  if (input.awaiting) return "now";
  if (input.kind !== "progress" && input.kind !== "closed") return "now";
  const sessions = deferredThreadNoticeSessions(deps);
  if (sessions.size === 0) return "now";
  const name = input.parentSessionName?.trim();
  const key = input.parentSessionKey?.trim();
  if (!key || !((name && sessions.has(name)) || sessions.has(key))) return "now";
  return (deps.isOwnerSession ?? ((sessionKey: string) => isInboxOwnerSession(sessionKey)))(key) ? "deferred" : "now";
}

/** One pending notice per thread: a newer progress or the result replaces the older pending one. */
export function threadNoticeSupersedeKey(requestId: string): string {
  return `thread:${requestId}`;
}
