import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalChannelId } from "../channels/capabilities.js";
import { getRaviStateDir } from "../utils/paths.js";

const STICKER_CATALOG_VERSION = 1;
const STICKER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export const StickerMediaReferenceSchema = z
  .object({
    kind: z.literal("file"),
    path: z.string().min(1),
    mimeType: z.string().min(1).optional(),
  })
  .strict();

export const StickerCatalogEntrySchema = z
  .object({
    id: z.string().regex(STICKER_ID_PATTERN, "Sticker id must use lowercase letters, numbers, dashes or underscores"),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    avoid: z.string().trim().min(1).max(500).optional(),
    channels: z.array(z.string().trim().min(1)).default(["whatsapp"]),
    agents: z.array(z.string().trim().min(1)).default([]),
    media: StickerMediaReferenceSchema,
    enabled: z.boolean().default(true),
    createdAt: z.number().int().positive().optional(),
    updatedAt: z.number().int().positive().optional(),
  })
  .strict();

export const StickerCatalogSchema = z
  .object({
    version: z.literal(STICKER_CATALOG_VERSION).default(STICKER_CATALOG_VERSION),
    stickers: z.array(StickerCatalogEntrySchema).default([]),
  })
  .strict();

export type StickerMediaReference = z.infer<typeof StickerMediaReferenceSchema>;
export type StickerCatalogEntry = z.infer<typeof StickerCatalogEntrySchema>;
export type StickerCatalog = z.infer<typeof StickerCatalogSchema>;
export type StickerCatalogEntryInput = z.input<typeof StickerCatalogEntrySchema>;

export function getStickerCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "stickers", "catalog.json");
}

export function inferStickerMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function normalizeAllowlist(values: string[], canonicalize = false): string[] {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (canonicalize ? canonicalChannelId(value) : value));
  return [...new Set(normalized)];
}

function normalizeMediaReference(media: StickerMediaReference): StickerMediaReference {
  if (media.path.trim().startsWith("data:")) {
    throw new Error("Sticker media must be a file reference, not inline base64/data content");
  }

  const path = resolve(media.path);
  return {
    kind: "file",
    path,
    mimeType: media.mimeType ?? inferStickerMimeType(path),
  };
}

export function validateStickerEntry(input: StickerCatalogEntryInput): StickerCatalogEntry {
  const parsed = StickerCatalogEntrySchema.parse(input);
  const channels = normalizeAllowlist(parsed.channels, true);
  if (channels.length === 0) {
    throw new Error("Sticker channel allowlist cannot be empty");
  }

  return {
    ...parsed,
    channels,
    agents: normalizeAllowlist(parsed.agents),
    media: normalizeMediaReference(parsed.media),
  };
}

export function readStickerCatalog(path = getStickerCatalogPath()): StickerCatalog {
  if (!existsSync(path)) {
    return { version: STICKER_CATALOG_VERSION, stickers: [] };
  }

  const parsed = StickerCatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return {
    version: STICKER_CATALOG_VERSION,
    stickers: parsed.stickers.map(validateStickerEntry).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function writeStickerCatalog(catalog: StickerCatalog, path = getStickerCatalogPath()): StickerCatalog {
  const normalized: StickerCatalog = {
    version: STICKER_CATALOG_VERSION,
    stickers: catalog.stickers.map(validateStickerEntry).sort((a, b) => a.id.localeCompare(b.id)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function listStickers(path = getStickerCatalogPath()): StickerCatalogEntry[] {
  return readStickerCatalog(path).stickers;
}

export function getSticker(id: string, path = getStickerCatalogPath()): StickerCatalogEntry | null {
  return listStickers(path).find((sticker) => sticker.id === id) ?? null;
}

export function addSticker(
  input: Omit<StickerCatalogEntryInput, "createdAt" | "updatedAt">,
  options: { overwrite?: boolean; path?: string; now?: number } = {},
): StickerCatalogEntry {
  const catalogPath = options.path ?? getStickerCatalogPath();
  const catalog = readStickerCatalog(catalogPath);
  const existing = catalog.stickers.find((sticker) => sticker.id === input.id);
  if (existing && !options.overwrite) {
    throw new Error(`Sticker already exists: ${input.id}`);
  }

  const media = normalizeMediaReference(StickerMediaReferenceSchema.parse(input.media));
  if (!existsSync(media.path)) {
    throw new Error(`Sticker media file not found: ${media.path}`);
  }

  const now = options.now ?? Date.now();
  const entry = validateStickerEntry({
    ...input,
    media,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  const stickers = catalog.stickers.filter((sticker) => sticker.id !== entry.id);
  stickers.push(entry);
  writeStickerCatalog({ version: STICKER_CATALOG_VERSION, stickers }, catalogPath);
  return entry;
}

export function removeSticker(id: string, path = getStickerCatalogPath()): boolean {
  const catalog = readStickerCatalog(path);
  const stickers = catalog.stickers.filter((sticker) => sticker.id !== id);
  if (stickers.length === catalog.stickers.length) {
    return false;
  }
  writeStickerCatalog({ version: STICKER_CATALOG_VERSION, stickers }, path);
  return true;
}

export function stickerAllowedOnChannel(sticker: StickerCatalogEntry, channelIdOrName: string): boolean {
  const channel = canonicalChannelId(channelIdOrName);
  return sticker.channels.map(canonicalChannelId).includes(channel);
}

export function stickerAllowedForAgent(sticker: StickerCatalogEntry, agentId: string): boolean {
  return sticker.agents.length === 0 || sticker.agents.includes(agentId);
}

export function stickerFilename(sticker: StickerCatalogEntry): string {
  return basename(sticker.media.path);
}
