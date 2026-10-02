/**
 * Outbound helpers for `WhatsAppRuntime`, ported from the REST routes and channel SDK
 * of omni (not from its WhatsApp plugin): outbound text sanitization, media MIME
 * inference, target normalization, the plugin's vCard builder, and sticker conversion
 * (new in ravi: the ported code sent non-webp stickers as-is).
 */

import { extname } from "node:path";
import { computeWaid } from "./lib/senders/contact.js";
import { toJid } from "./lib/jid.js";

// ============================================================================
// Outbound text (ported channel-sdk sanitizeOutboundText, omni#300)
// ============================================================================

/** Routing header: [channel:whatsapp-baileys instance:abc chat:xyz@s.whatsapp.net ...] */
const ROUTING_HEADER_RE =
  /^\[(?:channel:\S+|instance:\S+|chat:\S+|thread:\S+|msg:\S+|from:\S+|type:\S+|replyTo:\S+)(?:\s+(?:channel:\S+|instance:\S+|chat:\S+|thread:\S+|msg:\S+|from:\S+|type:\S+|replyTo:\S+))*\]\s*/gm;

/** ⚡ REPLY NOW directive injected by agent providers */
const REPLY_NOW_RE = /⚡\s*REPLY\s+NOW\b[^\n]*/g;

/**
 * Strip internal routing headers and agent directives before text reaches WhatsApp.
 * Returns the cleaned text, which may be empty when the message was only metadata.
 */
export function sanitizeOutboundText(text: string): string {
  let cleaned = text.replace(ROUTING_HEADER_RE, "");
  cleaned = cleaned.replace(REPLY_NOW_RE, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

// ============================================================================
// Media MIME inference (ported from omni packages/api routes/v2/messages.ts)
// ============================================================================

export type OutboundMediaType = "image" | "video" | "audio" | "document";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
};

const DEFAULT_MIME_BY_MEDIA_TYPE: Record<OutboundMediaType, string> = {
  image: "image/jpeg",
  audio: "audio/ogg",
  video: "video/mp4",
  document: "application/octet-stream",
};

export function inferMediaMimeType(type: OutboundMediaType, filename?: string): string {
  if (filename) {
    const fromExtension = MIME_BY_EXTENSION[extname(filename).toLowerCase()];
    if (fromExtension) return fromExtension;
  }
  return DEFAULT_MIME_BY_MEDIA_TYPE[type];
}

/** Ported `normalizeSendMediaMimeType`: voice notes declared as plain ogg become ogg/opus. */
export function normalizeSendMediaMimeType(input: {
  type: OutboundMediaType;
  mimeType?: string;
  filename?: string;
  voiceNote?: boolean;
}): string {
  const inferred = input.mimeType ?? inferMediaMimeType(input.type, input.filename);
  if (input.type === "audio" && input.voiceNote === true && inferred === "audio/ogg") {
    return "audio/ogg; codecs=opus";
  }
  return inferred;
}

// ============================================================================
// Targets
// ============================================================================

/**
 * Normalize a ravi chat reference to a WhatsApp JID:
 * `group:<id>` → `<id>@g.us`, `lid:<id>` → `<id>@lid`, `<a>-<b>` (legacy group id) → `@g.us`,
 * full JIDs pass through, anything else is a phone number (`toJid`, BR 9th-digit rules).
 */
export function normalizeChatTarget(target: string): string {
  const value = target.trim();
  if (value.startsWith("group:")) return `${value.slice("group:".length)}@g.us`;
  if (value.startsWith("lid:")) return `${value.slice("lid:".length)}@lid`;
  if (value.includes("@")) return value;
  if (/^\d+-\d+$/.test(value)) return `${value}@g.us`;
  return toJid(value);
}

/** Group JID from a `group:` reference, a bare id or a full JID. */
export function normalizeGroupJid(target: string): string {
  const value = target.trim();
  if (value.startsWith("group:")) return `${value.slice("group:".length)}@g.us`;
  if (value.includes("@")) return value;
  return `${value}@g.us`;
}

/** Invite code from a bare code or a `https://chat.whatsapp.com/<code>` link. */
export function extractInviteCode(codeOrLink: string): string {
  const value = codeOrLink.trim();
  const match = value.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/);
  return match?.[1] ?? value;
}

export function inviteLink(code: string): string {
  return `https://chat.whatsapp.com/${code}`;
}

/** Ported plugin `buildVCard`. */
export function buildVCard(contact: { name: string; phone?: string; email?: string }): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${contact.name}`];
  if (contact.phone) {
    const digits = contact.phone.replace(/[^\d]/g, "");
    lines.push(`TEL;type=CELL;waid=${computeWaid(digits)}:${contact.phone}`);
  }
  if (contact.email) lines.push(`EMAIL:${contact.email}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}

// ============================================================================
// Stickers
// ============================================================================

export const STICKER_SIZE_PX = 512;

/** True when `buffer` is a RIFF/WEBP container. */
export function isWebp(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  );
}

/**
 * Convert any image sharp can read to a 512x512 webp sticker (aspect kept, transparent
 * padding; animated GIFs stay animated). sharp is loaded on demand so it is never a
 * startup dependency of the runner.
 */
export async function convertStickerToWebp(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input, { animated: true })
    .resize(STICKER_SIZE_PX, STICKER_SIZE_PX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp()
    .toBuffer();
}
