/**
 * Local inbound media for the channel consumer.
 *
 * The native WhatsApp runtime downloads inbound media itself (it runs on the same
 * host) and references it as `content.mediaUrl = "file://<abs>"` plus
 * `content.localPath = <abs>`. Those files are read from disk; they are never sent
 * to the Omni media API.
 *
 * Reads are confined to the Ravi media root (`<RAVI_STATE_DIR>/media`, where the
 * runtime writes `media/whatsapp/<instanceId>/...`) so an inbound event cannot make
 * the daemon copy arbitrary host files into an agent's attachments.
 */

import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";
import { MAX_MEDIA_BYTES } from "../../utils/media.js";
import { getRaviStateDir } from "../../utils/paths.js";

const log = logger.child("channels:whatsapp:local-media");

/** Default roots local media may be read from. Resolved per call (tests switch RAVI_STATE_DIR). */
export function defaultLocalMediaRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [join(getRaviStateDir(env), "media")];
}

export interface LocalMediaContent {
  mediaUrl?: string;
  localPath?: string;
}

/**
 * Local file a media payload points at, or null when it must be fetched remotely.
 *
 * - `file://` media URLs always resolve locally (never fetched through Omni).
 * - An absolute `localPath` is used only when there is no media URL at all; any
 *   other media URL keeps the Omni fetch path (Omni's `localPath` is Omni-side).
 */
export function resolveLocalMediaPath(content: LocalMediaContent): string | null {
  const mediaUrl = content.mediaUrl?.trim();
  if (mediaUrl && /^file:/i.test(mediaUrl)) {
    try {
      return fileURLToPath(mediaUrl);
    } catch {
      log.warn("Ignoring malformed file:// media URL", { mediaUrl });
      return null;
    }
  }
  // Any other media URL (Omni http or `/api/...` paths) is fetched remotely, as before.
  if (mediaUrl) return null;
  const localPath = content.localPath?.trim();
  return localPath && isAbsolute(localPath) ? localPath : null;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // Root does not exist yet: nothing can be inside it.
    }
  }
  return resolved;
}

export interface ReadLocalMediaOptions {
  maxBytes?: number;
  /** Directories the file must live in (after symlink resolution). Defaults to `defaultLocalMediaRoots()`. */
  roots?: readonly string[];
}

/**
 * Read a local media file with the same size limit applied to downloaded media.
 * Returns null (and logs) when the file is missing, outside the allowed roots,
 * not a regular file, empty or too large.
 */
export async function readLocalMediaFile(
  filePath: string,
  options: ReadLocalMediaOptions = {},
): Promise<Buffer | null> {
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  let target: string;
  try {
    target = await realpath(filePath);
  } catch (error) {
    log.warn("Local media file not found", { filePath, error });
    return null;
  }

  const roots = await resolveRoots(options.roots ?? defaultLocalMediaRoots());
  if (!roots.some((root) => isInside(root, target))) {
    log.warn("Refusing to read local media outside the Ravi media root", { filePath, roots });
    return null;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) {
      log.warn("Local media path is not a file", { filePath });
      return null;
    }
    if (info.size > maxBytes) {
      log.warn("Media too large (local file)", { filePath, size: info.size, maxBytes });
      return null;
    }
    const buffer = await readFile(target);
    if (buffer.byteLength > maxBytes) {
      log.warn("Media too large (local file)", { filePath, size: buffer.byteLength, maxBytes });
      return null;
    }
    if (buffer.byteLength === 0) {
      log.warn("Local media file is empty", { filePath });
      return null;
    }
    return buffer;
  } catch (error) {
    log.warn("Failed to read local media file", { filePath, error });
    return null;
  }
}
