/**
 * Legacy-bridge (Omni) inbound media.
 *
 * Omni stores inbound media itself and exposes it over its HTTP API: either a relative
 * `/api/v2/media/...` path or an absolute URL. `createOmniMediaLoader` is the bridge
 * source's `InboundSourceHooks.loadMedia`: for http URLs it first asks Omni to cache the
 * message media (`POST /api/v2/messages/media/download`), then falls back to the URL.
 */

import type { InboundMediaLoader } from "../channels/inbound/types.js";
import { logger } from "../utils/logger.js";
import { MAX_MEDIA_BYTES } from "../utils/media.js";

const log = logger.child("omni:media");

export interface OmniMediaConnection {
  apiUrl: string;
  apiKey: string;
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

export interface OmniMediaDownloadRef {
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
 * `InboundSourceHooks.loadMedia` for the legacy bridge: exactly the old consumer's remote
 * fetch (cached download first for http URLs, then the URL itself). Never throws.
 */
export function createOmniMediaLoader(connection: OmniMediaConnection): InboundMediaLoader {
  const { apiUrl, apiKey } = connection;
  return async (event, request) => {
    const payload = event.payload;
    const mediaUrl = payload.content.mediaUrl;
    if (!mediaUrl) return null;
    const { maxBytes, mimeType } = request;

    return mediaUrl.startsWith("http")
      ? ((await fetchCachedOmniMedia(
          { instanceId: event.instanceId, chatExternalId: payload.chatId, externalId: payload.externalId },
          apiUrl,
          apiKey,
          maxBytes,
          mimeType,
        )) ?? (await fetchOmniMedia(mediaUrl, apiUrl, apiKey, maxBytes, mimeType)))
      : await fetchOmniMedia(mediaUrl, apiUrl, apiKey, maxBytes, mimeType);
  };
}
