import { createHash } from "node:crypto";
import type { SlackThreadLifecycleRecord } from "./thread-lifecycle-store.js";

/**
 * How long `create-thread` treats an identical request from the same asker as the one it already accepted.
 * A caller that lost the outcome of a call (a timeout, an interrupted turn) repeats it within seconds.
 */
export const SLACK_THREAD_REPLAY_WINDOW_MS = 120_000;

/** What makes two `create-thread` requests the same request. */
export interface SlackThreadRequestIdentity {
  initialPrompt: string;
  modelOverride?: string;
  providerOverride?: string;
  effortOverride?: string;
  thinkingLevel?: string;
}

/**
 * The request id a caller-chosen idempotency key stands for. The key is scoped to the parent session, so two
 * channels can use the same key, and hashed, so any text is a valid id for the lifecycle row and its outbound job.
 */
export function slackThreadRequestIdForKey(parentSessionKey: string, key: string): string {
  // The length prefix keeps two (parent, key) pairs from hashing the same text.
  const digest = createHash("sha256")
    .update(`${parentSessionKey.length}:${parentSessionKey}\0${key}`)
    .digest("hex")
    .slice(0, 32);
  return `slack-thread:key-${digest}`;
}

/** An option as the lifecycle row stores it: trimmed, and empty means not set. */
export function normalizeSlackThreadOption(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Whether a stored request is the one `identity` describes. A provider the caller did not pass is the parent's,
 * resolved when the thread was asked for; it is not part of what the caller asked, so `providerFromParent` leaves
 * it out: a retry of the same command still matches after the parent's provider override changed.
 */
export function slackThreadRequestMatches(
  record: Pick<
    SlackThreadLifecycleRecord,
    "initialPrompt" | "modelOverride" | "providerOverride" | "effortOverride" | "thinkingLevel"
  >,
  identity: SlackThreadRequestIdentity,
  options: { providerFromParent?: boolean } = {},
): boolean {
  return (
    record.initialPrompt === identity.initialPrompt.trim() &&
    (record.modelOverride ?? null) === normalizeSlackThreadOption(identity.modelOverride) &&
    (options.providerFromParent === true ||
      (record.providerOverride ?? null) === normalizeSlackThreadOption(identity.providerOverride)) &&
    (record.effortOverride ?? null) === normalizeSlackThreadOption(identity.effortOverride) &&
    (record.thinkingLevel ?? null) === normalizeSlackThreadOption(identity.thinkingLevel)
  );
}
