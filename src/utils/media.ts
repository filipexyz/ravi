/**
 * Media file utilities for saving downloaded media to disk.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

const MEDIA_DIR = "/tmp/ravi-media";

/** Max media file size for download (20MB) */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "application/pdf": ".pdf",
};

function resolveExtension(mimetype: string, filename?: string): string {
  if (filename) {
    const ext = extname(filename);
    if (ext) return ext;
  }
  if (MIME_EXT[mimetype]) return MIME_EXT[mimetype];
  // Fallback: use mimetype subtype (e.g. "image/png" -> ".png")
  const sub = mimetype.split("/")[1]?.split(";")[0];
  return sub ? `.${sub}` : ".bin";
}

/**
 * Save a media buffer to /tmp/ravi-media/ and return the file path.
 */
export async function saveMediaToTmp(
  buffer: Buffer,
  messageId: string,
  mimetype: string,
  filename?: string,
): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = resolveExtension(mimetype, filename);
  const safeName = `${Date.now()}-${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}${ext}`;
  const filepath = join(MEDIA_DIR, safeName);
  await writeFile(filepath, buffer);
  return filepath;
}
