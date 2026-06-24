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

function normalizeMimeType(value: string | null | undefined): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function isHtmlMime(value: string | null | undefined): boolean {
  const mimeType = normalizeMimeType(value);
  return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}

function looksLikeHtml(buffer: Buffer): boolean {
  const preview = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return preview.startsWith("<!doctype html") || preview.startsWith("<html") || preview.includes("<html");
}

function shouldRejectHtmlMedia(
  expectedMimeType: string | undefined,
  responseMimeType: string | undefined,
  buffer: Buffer,
): boolean {
  const expected = normalizeMimeType(expectedMimeType);
  if (!expected || isHtmlMime(expected)) return false;
  return isHtmlMime(responseMimeType) || looksLikeHtml(buffer);
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
  expectedMimeType?: string,
): Promise<Buffer | null> {
  const url = mediaUrl.startsWith("http") ? mediaUrl : `${omniApiUrl}${mediaUrl}`;
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
    const buffer = Buffer.from(ab);
    const responseMimeType = res.headers.get("content-type") ?? undefined;
    if (shouldRejectHtmlMedia(expectedMimeType, responseMimeType, buffer)) {
      log.warn("Media response was HTML, refusing to save as media", { url, expectedMimeType, responseMimeType });
      return null;
    }
    return buffer;
  } catch (err) {
    log.warn("Failed to fetch media from omni", { url, error: err });
    return null;
  }
}

interface OmniMediaDownloadRef {
  instanceId: string;
  chatExternalId: string;
  externalId: string;
}

export async function fetchCachedOmniMedia(
  ref: OmniMediaDownloadRef,
  omniApiUrl: string,
  omniApiKey: string,
  maxBytes = MAX_MEDIA_BYTES,
  expectedMimeType?: string,
): Promise<Buffer | null> {
  const url = `${omniApiUrl}/api/v2/messages/media/download`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": omniApiKey,
      },
      body: JSON.stringify(ref),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn("Omni media cache request failed", { status: res.status });
      return null;
    }
    const payload = (await res.json()) as { data?: { downloadUrl?: unknown } };
    const downloadUrl = payload.data?.downloadUrl;
    if (typeof downloadUrl !== "string" || !downloadUrl) {
      log.warn("Omni media cache response missing downloadUrl");
      return null;
    }
    return fetchOmniMedia(downloadUrl, omniApiUrl, omniApiKey, maxBytes, expectedMimeType);
  } catch (err) {
    log.warn("Failed to cache media through omni", { error: err });
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
