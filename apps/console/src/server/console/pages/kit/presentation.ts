// Presentation metadata of a shipped page: the runtime, theme and widget
// versions the page kit inlined. `/api/cli/pages/kit` answers it, the OSS
// passes it back unchanged as `publish.presentation`, and publish stores it at
// `artifact_versions.metadata_json.presentation` so `pages/outdated` can tell
// which routes ship older versions. See `.ravi/specs/console/pages/publish`.

import { z } from "zod";

import type { PagePresentation } from "@/shared/widgets/types";

export const PAGE_PRESENTATION_MAX_BYTES = 16 * 1024;
export const PAGE_PRESENTATION_MAX_WIDGETS = 100;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LIBRARY_REF = /^[^\s/]{1,200}\/[^\s/]{1,200}$/;

const itemRefSchema = z
  .object({
    itemId: z.string().uuid(),
    ref: z.string().max(401).regex(LIBRARY_REF),
    version: z.number().int().positive(),
  })
  .strict();

export const pagePresentationSchema = z
  .object({
    v: z.literal(1),
    runtime: z
      .object({
        version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict()
      .nullable(),
    theme: itemRefSchema.extend({ hash: z.string().regex(SHA256_HEX) }).strict().nullable(),
    // Optional so presentations stored before it still parse.
    themeSource: z.enum(["effective", "explicit", "none"]).optional(),
    widgets: z.array(itemRefSchema).max(PAGE_PRESENTATION_MAX_WIDGETS),
  })
  .strict();

/**
 * `publish.presentation` as sent: absent (undefined or null) is null; a
 * value is valid presentation JSON of at most 16 KiB, or the result says why
 * not.
 */
export function parsePagePresentation(value: unknown): { ok: true; presentation: PagePresentation | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, presentation: null };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PAGE_PRESENTATION_MAX_BYTES) {
    return { ok: false, reason: "presentation is larger than 16 KiB" };
  }
  const parsed = pagePresentationSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${["presentation", ...issue.path.map(String)].join(".")}: ${issue.message}` : "presentation is invalid" };
  }
  return { ok: true, presentation: parsed.data };
}

/** The presentation stored on an artifact version's metadata, or null when absent or unreadable. */
export function storedPagePresentation(metadataJson: unknown): PagePresentation | null {
  if (!metadataJson || typeof metadataJson !== "object" || Array.isArray(metadataJson)) return null;
  const parsed = pagePresentationSchema.safeParse((metadataJson as Record<string, unknown>).presentation);
  return parsed.success ? parsed.data : null;
}
