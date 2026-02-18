/**
 * WhatsApp JID Normalization
 *
 * Handles various WhatsApp identifier formats:
 * - User JIDs: 5511999999999@s.whatsapp.net
 * - User JIDs with device: 5511999999999:0@s.whatsapp.net
 * - LID JIDs: 123456789@lid
 * - Group JIDs: 123456789@g.us
 * - Broadcast: status@broadcast
 */

import type { JidComponents } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

export const WHATSAPP_SERVER = "s.whatsapp.net";
export const LID_SERVER = "lid";
export const GROUP_SERVER = "g.us";
export const BROADCAST_JID = "status@broadcast";

// ============================================================================
// Regex Patterns
// ============================================================================

/** User JID with optional device suffix: 5511999999999:0@s.whatsapp.net */
const USER_JID_RE = /^(\d+)(?::(\d+))?@s\.whatsapp\.net$/i;

/** LID JID: 123456789@lid */
const LID_JID_RE = /^(\d+)@lid$/i;

/** Group JID: 123456789@g.us */
const GROUP_JID_RE = /^(\d+(?:-\d+)?)@g\.us$/i;

/** Phone number with optional + prefix and formatting */
const PHONE_RE = /^\+?[\d\s\-().]+$/;

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse a JID into its components
 */
export function parseJid(jid: string): JidComponents | null {
  const trimmed = jid.trim();

  // User JID
  const userMatch = trimmed.match(USER_JID_RE);
  if (userMatch) {
    return {
      user: userMatch[1],
      server: WHATSAPP_SERVER,
      device: userMatch[2] ? parseInt(userMatch[2], 10) : undefined,
      isLid: false,
      isGroup: false,
    };
  }

  // LID JID
  const lidMatch = trimmed.match(LID_JID_RE);
  if (lidMatch) {
    return {
      user: lidMatch[1],
      server: LID_SERVER,
      isLid: true,
      isGroup: false,
    };
  }

  // Group JID
  const groupMatch = trimmed.match(GROUP_JID_RE);
  if (groupMatch) {
    return {
      user: groupMatch[1],
      server: GROUP_SERVER,
      isLid: false,
      isGroup: true,
    };
  }

  return null;
}

/**
 * Build a JID from components
 */
export function buildJid(components: JidComponents): string {
  const { user, server, device } = components;
  if (device !== undefined) {
    return `${user}:${device}@${server}`;
  }
  return `${user}@${server}`;
}

// ============================================================================
// Normalization Functions
// ============================================================================

/**
 * Normalize phone number to E.164 format (digits only)
 *
 * @param input - Phone number in any format
 * @returns Normalized phone number (digits only)
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();

  // Already normalized LID - accept any case for prefix
  if (trimmed.toLowerCase().startsWith("lid:")) {
    return `lid:${trimmed.slice(4)}`;
  }

  // Check if it's a JID
  const parsed = parseJid(trimmed);
  if (parsed) {
    if (parsed.isLid) {
      return `lid:${parsed.user}`;
    }
    if (parsed.isGroup) {
      return `group:${parsed.user}`;
    }
    return parsed.user;
  }

  // Already normalized group - accept any case for prefix
  if (trimmed.toLowerCase().startsWith("group:")) {
    return `group:${trimmed.slice(6)}`;
  }

  // Extract just digits (remove +, spaces, dashes, etc.)
  return trimmed.replace(/\D/g, "");
}

/**
 * Convert a phone number to a user JID
 *
 * @param phone - Phone number (normalized or raw)
 * @returns User JID or null if cannot convert
 */
export function phoneToJid(phone: string): string | null {
  const normalized = normalizePhone(phone);

  // LID
  if (normalized.startsWith("lid:")) {
    return `${normalized.slice(4)}@${LID_SERVER}`;
  }

  // Group
  if (normalized.startsWith("group:")) {
    return `${normalized.slice(6)}@${GROUP_SERVER}`;
  }

  // Regular phone number
  if (/^\d+$/.test(normalized)) {
    return `${normalized}@${WHATSAPP_SERVER}`;
  }

  return null;
}

/**
 * Convert a JID to a session ID for NATS topics
 *
 * @param jid - WhatsApp JID
 * @returns Session ID (e.g., wa-5511999999999)
 */
export function jidToSessionId(jid: string): string {
  const phone = normalizePhone(jid);

  // Handle LID
  if (phone.startsWith("lid:")) {
    return `wa-lid-${phone.slice(4)}`;
  }

  // Handle group
  if (phone.startsWith("group:")) {
    return `wa-group-${phone.slice(6)}`;
  }

  return `wa-${phone}`;
}

/**
 * Extract phone from session ID
 *
 * @param sessionId - Session ID (e.g., wa-5511999999999)
 * @returns Phone number or null if not a WhatsApp session
 */
export function sessionIdToPhone(sessionId: string): string | null {
  if (!sessionId.startsWith("wa-")) {
    return null;
  }

  const rest = sessionId.slice(3);

  // LID session
  if (rest.startsWith("lid-")) {
    return `lid:${rest.slice(4)}`;
  }

  // Group session
  if (rest.startsWith("group-")) {
    return `group:${rest.slice(6)}`;
  }

  return rest;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a JID is a group
 */
export function isGroup(jid: string): boolean {
  return GROUP_JID_RE.test(jid) || jid.startsWith("group:");
}

/**
 * Check if a JID is a LID
 */
export function isLid(jid: string): boolean {
  return LID_JID_RE.test(jid) || jid.startsWith("lid:");
}

/**
 * Check if a JID is a user (not group, not broadcast)
 */
export function isUser(jid: string): boolean {
  return USER_JID_RE.test(jid) || LID_JID_RE.test(jid);
}

/**
 * Check if a JID is a broadcast
 */
export function isBroadcast(jid: string): boolean {
  return jid === BROADCAST_JID;
}

/**
 * Check if input looks like a phone number
 */
export function isPhoneNumber(input: string): boolean {
  return PHONE_RE.test(input.trim());
}

// ============================================================================
// Formatting Functions
// ============================================================================

/**
 * Format phone number for display (Brazilian format)
 */
export function formatPhone(phone: string): string {
  const normalized = normalizePhone(phone);

  // LID format
  if (normalized.startsWith("lid:")) {
    return `LID:${normalized.slice(4)}`;
  }

  // Group format
  if (normalized.startsWith("group:")) {
    return `Group:${normalized.slice(6)}`;
  }

  // Brazilian mobile (13 digits: 55 + 2 DDD + 9 + 8 digits)
  if (normalized.length === 13 && normalized.startsWith("55")) {
    return `+${normalized.slice(0, 2)} (${normalized.slice(2, 4)}) ${normalized.slice(4, 9)}-${normalized.slice(9)}`;
  }

  // Brazilian landline (12 digits: 55 + 2 DDD + 8 digits)
  if (normalized.length === 12 && normalized.startsWith("55")) {
    return `+${normalized.slice(0, 2)} (${normalized.slice(2, 4)}) ${normalized.slice(4, 8)}-${normalized.slice(8)}`;
  }

  // Other international
  if (normalized.length >= 10) {
    return `+${normalized}`;
  }

  return normalized;
}
