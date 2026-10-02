/**
 * Media file utilities — size limits and saving inbound media to agent attachments.
 * (The legacy bridge's HTTP media fetchers live in `src/omni/media.ts`.)
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
