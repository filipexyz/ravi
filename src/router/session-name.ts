/**
 * Session Name Generator
 *
 * Generates human-readable, unique session names.
 * Names are slugified: lowercase, alphanumeric + hyphens, max 64 chars.
 * Names must NOT contain dots (used as topic separator in NATS).
 */

import { isNameTaken } from "./sessions.js";

/**
 * Slugify a string: lowercase, replace non-alnum with hyphens, trim edges.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export interface SessionNameOpts {
  /** Chat type: dm, group, channel */
  chatType?: "dm" | "group" | "channel";
  /** Group name (will be slugified) */
  groupName?: string;
  /** Peer kind */
  peerKind?: "dm" | "group" | "channel";
  /** Peer ID (phone, group ID, room ID) */
  peerId?: string;
  /** Custom suffix (e.g. cron job name, trigger name) */
  suffix?: string;
  /** Whether this is the "main" session for the agent */
  isMain?: boolean;
  /** Thread ID (e.g. Slack threadTs) — appended as suffix */
  threadId?: string;
}

/**
 * Generate a session name from agent ID and context.
 *
 * Examples:
 * - main (agent main, isMain=true)
 * - main-sampa-seeds (agent main, group "Sampa Seeds")
 * - sampa-manager-sampa-seeds (agent sampa-manager, group "Sampa Seeds")
 * - main-dm-5511999 (agent main, DM with 5511999...)
 * - main-cron-daily-report (agent main, cron suffix)
 * - main-trigger-lead-new (agent main, trigger suffix)
 */
export function generateSessionName(
  agentId: string,
  opts: SessionNameOpts = {},
): string {
  const agent = slugify(agentId);

  if (opts.isMain) {
    return agent;
  }

  // Determine context part
  let context: string;

  if (opts.suffix) {
    context = slugify(opts.suffix);
  } else if (opts.groupName) {
    context = slugify(opts.groupName);
  } else if (opts.peerKind === "channel" && opts.peerId) {
    // Slack channels etc. — take last 8 chars of ID
    const cleanId = opts.peerId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();
    context = `channel-${cleanId}`;
  } else if (opts.peerKind === "group" && opts.peerId) {
    // Strip "group:" prefix if present, take last 8 chars
    const cleanId = opts.peerId.replace(/^group:/, "");
    context = `group-${cleanId.slice(-8)}`;
  } else if (opts.peerKind === "dm" && opts.peerId) {
    // Take last 6 digits of phone
    const cleanPhone = opts.peerId.replace(/[^0-9]/g, "");
    context = `dm-${cleanPhone.slice(-6)}`;
  } else {
    context = `session-${Date.now().toString(36)}`;
  }

  // Append thread suffix if present
  if (opts.threadId) {
    context = `${context}-t-${opts.threadId.replace(/\./g, "")}`;
  }

  const name = `${agent}-${context}`.slice(0, 64);
  return name;
}

/**
 * Ensure a session name is unique by appending -2, -3, etc.
 * Uses cached prepared statement via isNameTaken().
 */
export function ensureUniqueName(baseName: string): string {
  if (!isNameTaken(baseName)) {
    return baseName;
  }

  for (let i = 2; i < 100; i++) {
    const candidate = `${baseName}-${i}`.slice(0, 64);
    if (!isNameTaken(candidate)) {
      return candidate;
    }
  }

  // Fallback: append timestamp
  return `${baseName.slice(0, 50)}-${Date.now().toString(36)}`;
}
