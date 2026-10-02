/**
 * Media download utilities for WhatsApp plugin
 *
 * Handles downloading media from Baileys messages and saving to local storage.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WAMessage, downloadMediaMessage } from "baileys";
import { baileys } from "../../baileys-loader.js";
import { DownloadTooLargeError } from "../foundation.js";
import { getDocumentMessage } from "./message.js";

/**
 * Baileys download context: lets `downloadMediaMessage` request a re-upload
 * when the media URL has expired (HTTP 404/410). Optional, as in Baileys.
 */
export type MediaDownloadContext = NonNullable<Parameters<typeof downloadMediaMessage>[3]>;

const DEFAULT_WHATSAPP_MEDIA_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GiB: WhatsApp document-scale media ceiling

/**
 * Inbound WhatsApp download ceiling is intentionally independent from provider
 * upload limits. We preserve what WhatsApp delivered; processors can
 * transcode/downsample before calling model providers.
 *
 * Override: `WHATSAPP_MEDIA_MAX_DOWNLOAD_MB` (MiB).
 */
export function getWhatsAppMediaDownloadMaxBytes(): number {
  const overrideMb = process.env.WHATSAPP_MEDIA_MAX_DOWNLOAD_MB;
  if (!overrideMb) return DEFAULT_WHATSAPP_MEDIA_MAX_DOWNLOAD_BYTES;

  const parsed = Number.parseInt(overrideMb, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WHATSAPP_MEDIA_MAX_DOWNLOAD_BYTES;
  return parsed * 1024 * 1024;
}

export interface DownloadToFileResult {
  /** MIME type of the media */
  mimeType: string;
  /** File size in bytes */
  size: number;
}

/**
 * Media type detection from message
 */
export interface DetectedMedia {
  /** Type of media content */
  type: "image" | "audio" | "video" | "document" | "sticker";
  /** MIME type */
  mimeType: string;
  /** Original filename if available */
  filename?: string;
  /** Duration in seconds (for audio/video) */
  duration?: number;
  /** Is this a voice note (ptt) */
  isVoiceNote?: boolean;
}

/**
 * Detect media type from a Baileys message
 */
export function detectMediaType(msg: WAMessage): DetectedMedia | null {
  const message = msg.message;
  if (!message) return null;

  if (message.imageMessage) {
    return {
      type: "image",
      mimeType: message.imageMessage.mimetype || "image/jpeg",
    };
  }

  if (message.audioMessage) {
    return {
      type: "audio",
      mimeType: message.audioMessage.mimetype || "audio/ogg; codecs=opus",
      duration: message.audioMessage.seconds || undefined,
      isVoiceNote: message.audioMessage.ptt || false,
    };
  }

  if (message.videoMessage) {
    return {
      type: "video",
      mimeType: message.videoMessage.mimetype || "video/mp4",
      duration: message.videoMessage.seconds || undefined,
    };
  }

  const documentMessage = getDocumentMessage(message);
  if (documentMessage) {
    return {
      type: "document",
      mimeType: documentMessage.mimetype || "application/octet-stream",
      filename: documentMessage.fileName || undefined,
    };
  }

  if (message.stickerMessage) {
    return {
      type: "sticker",
      mimeType: message.stickerMessage.mimetype || "image/webp",
    };
  }

  return null;
}

/**
 * Get file extension from MIME type
 */
export function getExtension(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg; codecs=opus": ".ogg",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/3gpp": ".3gp",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/octet-stream": ".bin",
    "text/plain": ".txt",
    "text/csv": ".csv",
  };

  // Check exact match
  if (mimeToExt[mimeType]) {
    return mimeToExt[mimeType];
  }

  // Check partial match (e.g., 'image/jpeg' for 'image/jpeg; charset=utf-8')
  for (const [mime, ext] of Object.entries(mimeToExt)) {
    if (mimeType.startsWith(mime)) {
      return ext;
    }
  }

  // Default extension based on type
  if (mimeType.startsWith("image/")) return ".bin";
  if (mimeType.startsWith("audio/")) return ".audio";
  if (mimeType.startsWith("video/")) return ".video";
  if (mimeType.startsWith("application/")) return ".bin";

  return ".bin";
}

/**
 * Download media to a buffer (without saving to disk)
 */
export async function downloadMediaToBuffer(msg: WAMessage): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mediaInfo = detectMediaType(msg);
  if (!mediaInfo) {
    return null;
  }

  try {
    const raw = await baileys().downloadMediaMessage(msg, "buffer", {});

    // Baileys may return Buffer, Uint8Array, or null
    let buffer: Buffer;
    if (raw instanceof Buffer) {
      buffer = raw;
    } else if (raw instanceof Uint8Array) {
      buffer = Buffer.from(raw);
    } else {
      return null;
    }

    // Empty buffer = decryption failed (common with iOS/macOS voice notes)
    if (buffer.length === 0) {
      return null;
    }

    return {
      buffer,
      mimeType: mediaInfo.mimeType,
    };
  } catch {
    return null;
  }
}

/**
 * Stream media from Baileys directly to disk while counting bytes. This avoids
 * allocating giant WhatsApp videos/documents in the Bun heap just to persist
 * them before provider-side normalization.
 */
export async function downloadMediaToFile(
  msg: WAMessage,
  outputPath: string,
  maxSizeBytes = getWhatsAppMediaDownloadMaxBytes(),
  context?: MediaDownloadContext,
): Promise<DownloadToFileResult | null> {
  const mediaInfo = detectMediaType(msg);
  if (!mediaInfo) return null;

  const stream = await baileys().downloadMediaMessage(msg, "stream", {}, context);
  const size = await writeMediaStreamToFile(stream, outputPath, maxSizeBytes);
  if (size === 0) return null;
  return { mimeType: mediaInfo.mimeType, size };
}

export async function writeMediaStreamToFile(
  stream: NodeJS.ReadableStream,
  outputPath: string,
  maxSizeBytes = getWhatsAppMediaDownloadMaxBytes(),
): Promise<number> {
  let size = 0;
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxSizeBytes) {
        callback(new DownloadTooLargeError(size, maxSizeBytes));
        return;
      }
      callback(null, chunk);
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await pipeline(stream, sizeGuard, createWriteStream(outputPath));
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }

  if (size === 0) {
    await rm(outputPath, { force: true });
  }
  return size;
}
