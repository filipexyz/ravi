/**
 * Session Key Builder
 *
 * Builds hierarchical session keys for routing conversations.
 */

import type { SessionKeyParams } from "./types.js";

/**
 * Build a session key from parameters
 *
 * Examples:
 * - "agent:main:main"                           (all DMs in one session)
 * - "agent:main:dm:5511999999999"               (per-peer)
 * - "agent:main:whatsapp:dm:5511999999999"      (per-channel-peer)
 * - "agent:main:whatsapp:default:dm:5511999999999" (per-account-channel-peer)
 * - "agent:main:whatsapp:group:123456789"       (group)
 * - "agent:main:slack:channel:C123:thread:1234" (thread)
 */
export function buildSessionKey(params: SessionKeyParams): string {
  const {
    agentId,
    channel,
    accountId,
    peerKind = "dm",
    peerId,
    dmScope = "per-peer",
    threadId,
  } = params;

  const parts: string[] = ["agent", agentId];

  // For DMs, apply dmScope logic
  if (peerKind === "dm") {
    switch (dmScope) {
      case "main":
        // All DMs share one session
        parts.push("main");
        break;

      case "per-peer":
        // Isolated by contact only
        parts.push("dm", peerId ?? "unknown");
        break;

      case "per-channel-peer":
        // Isolated by channel + contact
        if (channel) parts.push(channel);
        parts.push("dm", peerId ?? "unknown");
        break;

      case "per-account-channel-peer":
        // Full isolation: channel + account + contact
        if (channel) parts.push(channel);
        if (accountId) parts.push(accountId);
        parts.push("dm", peerId ?? "unknown");
        break;
    }
  } else {
    // Groups and channels are always isolated
    if (channel) parts.push(channel);
    if (accountId) parts.push(accountId);
    // Normalize peerId to avoid duplication like "group:group:123"
    // Input may be "group:123" (from normalizePhone) or just "123" (raw ID)
    // We strip the prefix if present since we add peerKind separately
    let cleanPeerId = peerId ?? "unknown";
    if (cleanPeerId.toLowerCase().startsWith(`${peerKind}:`)) {
      cleanPeerId = cleanPeerId.slice(peerKind.length + 1);
    }
    parts.push(peerKind, cleanPeerId);

    // Add thread if present
    if (threadId) {
      parts.push("thread", threadId);
    }
  }

  return parts.join(":");
}

/**
 * Parse a session key into components
 */
export function parseSessionKey(key: string): Partial<SessionKeyParams> | null {
  const parts = key.split(":");

  if (parts[0] !== "agent" || parts.length < 3) {
    return null;
  }

  const agentId = parts[1];

  // agent:X:main
  if (parts[2] === "main") {
    return { agentId, dmScope: "main" };
  }

  // agent:X:dm:PHONE (per-peer)
  if (parts[2] === "dm") {
    return {
      agentId,
      peerKind: "dm",
      peerId: parts[3],
      dmScope: "per-peer",
    };
  }

  // agent:X:channel:dm:PHONE or agent:X:channel:group:ID
  if (parts.length >= 4) {
    const channel = parts[2];
    const peerKind = parts[3] as "dm" | "group" | "channel";

    if (peerKind === "dm" || peerKind === "group" || peerKind === "channel") {
      // Join remaining parts to handle IDs with colons (e.g. Matrix !room:server)
      const peerIdParts = parts.slice(4);
      const threadIdx = peerIdParts.indexOf("thread");
      const peerId = (threadIdx !== -1 ? peerIdParts.slice(0, threadIdx) : peerIdParts).join(":") || undefined;
      const threadId = threadIdx !== -1 ? peerIdParts.slice(threadIdx + 1).join(":") : undefined;
      return {
        agentId,
        channel,
        peerKind,
        peerId,
        threadId,
        dmScope: "per-channel-peer",
      };
    }

    // agent:X:channel:account:dm:PHONE or agent:X:channel:account:group:ID
    if (parts.length >= 6) {
      const accountId = parts[3];
      const pk = parts[4] as "dm" | "group" | "channel";
      // Join remaining parts to handle IDs with colons
      const peerIdParts = parts.slice(5);
      const threadIdx = peerIdParts.indexOf("thread");
      const peerId = (threadIdx !== -1 ? peerIdParts.slice(0, threadIdx) : peerIdParts).join(":") || undefined;
      const threadId = threadIdx !== -1 ? peerIdParts.slice(threadIdx + 1).join(":") : undefined;
      return {
        agentId,
        channel,
        accountId,
        peerKind: pk,
        peerId,
        threadId,
        dmScope: "per-account-channel-peer",
      };
    }
  }

  return { agentId };
}

/**
 * Get the agent ID from a session key
 */
export function getAgentFromKey(key: string): string | null {
  const parsed = parseSessionKey(key);
  return parsed?.agentId ?? null;
}

/**
 * Check if a session key matches a pattern
 */
export function matchSessionKey(key: string, pattern: string): boolean {
  // Exact match
  if (key === pattern) return true;

  // Wildcard match (agent:X:* matches all sessions for agent X)
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1);
    return key.startsWith(prefix);
  }

  return false;
}

/**
 * Derive message source (channel routing info) from a session key.
 *
 * Used by cross_send to reconstruct routing when the target session
 * doesn't exist yet or has no channel info stored.
 *
 * Returns null for keys that don't contain channel info (e.g. "agent:X:main").
 */
export function deriveSourceFromSessionKey(
  key: string
): { channel: string; accountId: string; chatId: string } | null {
  const parsed = parseSessionKey(key);
  if (!parsed?.channel || !parsed.peerKind || !parsed.peerId) return null;

  const chatId = reconstructChatId(parsed.channel, parsed.peerKind, parsed.peerId);

  return {
    channel: parsed.channel,
    accountId: parsed.accountId ?? "default",
    chatId,
  };
}

/**
 * Reconstruct the chatId (normalized phone / room ID) from session key components.
 *
 * WhatsApp uses normalizePhone format: "group:123" for groups, "5511999" for DMs.
 * Matrix uses room IDs directly: "!roomid:server".
 */
function reconstructChatId(channel: string, peerKind: string, peerId: string): string {
  // WhatsApp groups: buildSessionKey strips "group:" prefix, add it back
  if (peerKind === "group" && channel !== "matrix") {
    return `group:${peerId}`;
  }

  // Everything else: peerId is the chatId as-is
  return peerId;
}
