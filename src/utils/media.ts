/**
 * Media file utilities — fetch from omni HTTP API, save to agent attachments.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { logger } from "./logger.js";

const log = logger.child("media");

/** Max media file size (20MB) */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** Max audio file size for transcription (20MB) */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
};

function resolveExtension(mimetype: string, filename?: string): string {
  if (filename) {
    const ext = extname(filename);
    if (ext) return ext;
  }
  if (MIME_EXT[mimetype]) return MIME_EXT[mimetype];
  const sub = mimetype.split("/")[1]?.split(";")[0];
  return sub ? `.${sub}` : ".bin";
}

/**
 * Download media from omni HTTP API.
 *
 * mediaUrl is a relative path like `/api/v2/media/{instanceId}/{...}/{file}.ext`
 * Fetches from `{omniApiUrl}{mediaUrl}` with API key auth.
 *
 * Returns the buffer or null if download fails / too large.
 */
export async function fetchOmniMedia(
  mediaUrl: string,
  omniApiUrl: string,
  omniApiKey: string,
  maxBytes = MAX_MEDIA_BYTES,
): Promise<Buffer | null> {
  const url = `${omniApiUrl}${mediaUrl}`;
  try {
    const res = await fetch(url, {
      headers: { "x-api-key": omniApiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn("Omni media download failed", { url, status: res.status });
      return null;
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      log.warn("Media too large (content-length)", { url, size: contentLength });
      return null;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      log.warn("Media too large", { url, size: ab.byteLength });
      return null;
    }
    return Buffer.from(ab);
  } catch (err) {
    log.warn("Failed to fetch media from omni", { url, error: err });
    return null;
  }
}

/**
 * Save a buffer to the agent's attachments directory.
 * Returns the destination path.
 *
 * Naming: `{timestamp}-{externalId}.{ext}` (matches existing convention).
 */
export async function saveToAgentAttachments(
  buffer: Buffer,
  agentCwd: string,
  messageId: string,
  mimeType: string,
): Promise<string> {
  const attachDir = join(agentCwd, "attachments");
  await mkdir(attachDir, { recursive: true });

  const ext = resolveExtension(mimeType);
  const safeName = `${Date.now()}-${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}${ext}`;
  const destPath = join(attachDir, safeName);

  await writeFile(destPath, buffer);
  log.debug("Saved media to agent attachments", { destPath, size: buffer.length });
  return destPath;
}
