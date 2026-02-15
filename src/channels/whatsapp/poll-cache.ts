/**
 * Cache for sent poll messages, used for vote decryption.
 *
 * Poll votes in WhatsApp are encrypted — to decrypt them we need
 * the original poll creation message (which contains the encryption key).
 * This cache stores sent polls so we can decrypt incoming votes.
 */

import type { WAMessage } from "@whiskeysockets/baileys";

const POLL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const sentPollMessages = new Map<string, { message: WAMessage; expires: number }>();

/** Store a sent poll message for later vote decryption */
export function cacheSentPoll(messageId: string, message: WAMessage): void {
  sentPollMessages.set(messageId, { message, expires: Date.now() + POLL_CACHE_TTL });
  // Cleanup expired entries
  for (const [id, entry] of sentPollMessages) {
    if (entry.expires < Date.now()) sentPollMessages.delete(id);
  }
}

/** Retrieve a cached poll message by its ID */
export function getCachedPoll(messageId: string): WAMessage | undefined {
  const cached = sentPollMessages.get(messageId);
  if (!cached || cached.expires < Date.now()) {
    if (cached) sentPollMessages.delete(messageId);
    return undefined;
  }
  return cached.message;
}
