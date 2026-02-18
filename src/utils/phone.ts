/**
 * Phone number and WhatsApp JID normalization utilities.
 */

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

/** User JID with optional device suffix */
const USER_JID_RE = /^(\d+)(?::(\d+))?@s\.whatsapp\.net$/i;
/** LID JID */
const LID_JID_RE = /^(\d+)@lid$/i;
/** Group JID */
const GROUP_JID_RE = /^(\d+(?:-\d+)?)@g\.us$/i;
/** Phone number with optional + prefix and formatting */
const PHONE_RE = /^\+?[\d\s\-().]+$/;

interface JidComponents {
  user: string;
  server: string;
  device?: number;
  isLid: boolean;
  isGroup: boolean;
}

export function parseJid(jid: string): JidComponents | null {
  const trimmed = jid.trim();

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

  const lidMatch = trimmed.match(LID_JID_RE);
  if (lidMatch) {
    return { user: lidMatch[1], server: LID_SERVER, isLid: true, isGroup: false };
  }

  const groupMatch = trimmed.match(GROUP_JID_RE);
  if (groupMatch) {
    return { user: groupMatch[1], server: GROUP_SERVER, isLid: false, isGroup: true };
  }

  return null;
}

/**
 * Normalize phone number to E.164 format (digits only).
 * Handles JIDs, LIDs, groups, and raw phone numbers.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("lid:")) {
    return `lid:${trimmed.slice(4)}`;
  }

  const parsed = parseJid(trimmed);
  if (parsed) {
    if (parsed.isLid) return `lid:${parsed.user}`;
    if (parsed.isGroup) return `group:${parsed.user}`;
    return parsed.user;
  }

  if (trimmed.toLowerCase().startsWith("group:")) {
    return `group:${trimmed.slice(6)}`;
  }

  return trimmed.replace(/\D/g, "");
}

/**
 * Convert a phone number to a WhatsApp JID.
 */
export function phoneToJid(phone: string): string | null {
  const normalized = normalizePhone(phone);

  if (normalized.startsWith("lid:")) return `${normalized.slice(4)}@${LID_SERVER}`;
  if (normalized.startsWith("group:")) return `${normalized.slice(6)}@${GROUP_SERVER}`;
  if (/^\d+$/.test(normalized)) return `${normalized}@${WHATSAPP_SERVER}`;

  return null;
}

/**
 * Convert a JID to a session ID for NATS topics.
 */
export function jidToSessionId(jid: string): string {
  const phone = normalizePhone(jid);

  if (phone.startsWith("lid:")) return `wa-lid-${phone.slice(4)}`;
  if (phone.startsWith("group:")) return `wa-group-${phone.slice(6)}`;

  return `wa-${phone}`;
}

/**
 * Extract phone from session ID.
 */
export function sessionIdToPhone(sessionId: string): string | null {
  if (!sessionId.startsWith("wa-")) return null;

  const rest = sessionId.slice(3);
  if (rest.startsWith("lid-")) return `lid:${rest.slice(4)}`;
  if (rest.startsWith("group-")) return `group:${rest.slice(6)}`;

  return rest;
}

export function isGroup(jid: string): boolean {
  return GROUP_JID_RE.test(jid) || jid.startsWith("group:");
}

export function isLid(jid: string): boolean {
  return LID_JID_RE.test(jid) || jid.startsWith("lid:");
}

export function isPhoneNumber(input: string): boolean {
  return PHONE_RE.test(input.trim());
}

/**
 * Format phone number for display (Brazilian format).
 */
export function formatPhone(phone: string): string {
  const normalized = normalizePhone(phone);

  if (normalized.startsWith("lid:")) return `LID:${normalized.slice(4)}`;
  if (normalized.startsWith("group:")) return `Group:${normalized.slice(6)}`;

  if (normalized.length === 13 && normalized.startsWith("55")) {
    return `+${normalized.slice(0, 2)} (${normalized.slice(2, 4)}) ${normalized.slice(4, 9)}-${normalized.slice(9)}`;
  }
  if (normalized.length === 12 && normalized.startsWith("55")) {
    return `+${normalized.slice(0, 2)} (${normalized.slice(2, 4)}) ${normalized.slice(4, 8)}-${normalized.slice(8)}`;
  }
  if (normalized.length >= 10) return `+${normalized}`;

  return normalized;
}
