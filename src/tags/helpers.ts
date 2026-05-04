import {
  dbDeleteTagBinding,
  dbEnsureTagBinding,
  dbFindTagBindings,
  normalizeTagSource,
  tryNormalizeTagSlug,
} from "./tag-db.js";
import type { TagAssetType, TagBinding, TagKind } from "./types.js";

export interface AttachTagSlugsToAssetInput {
  assetType: TagAssetType;
  assetId: string;
  tags: readonly string[];
  source: string;
  createdBy?: string;
  kind?: TagKind;
  metadata?: Record<string, unknown>;
  definitionMetadata?: Record<string, unknown>;
}

export function attachTagSlugsToAsset(input: AttachTagSlugsToAssetInput): TagBinding[] {
  const attached: TagBinding[] = [];
  const seen = new Set<string>();

  for (const rawTag of input.tags) {
    const originalTag = rawTag.trim();
    const slug = tryNormalizeTagSlug(originalTag);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    attached.push(
      dbEnsureTagBinding({
        slug,
        label: originalTag || slug,
        kind: input.kind ?? "user",
        definitionSource: input.source,
        definitionMetadata: input.definitionMetadata,
        assetType: input.assetType,
        assetId: input.assetId,
        source: input.source,
        createdBy: input.createdBy,
        metadata: {
          source: input.source,
          ...(originalTag && originalTag !== slug ? { originalTag } : {}),
          ...(input.metadata ?? {}),
        },
      }),
    );
  }

  return attached;
}

export function replaceMirroredTagSlugsForAsset(input: AttachTagSlugsToAssetInput): TagBinding[] {
  const attached = attachTagSlugsToAsset(input);
  const desired = new Set(attached.map((binding) => binding.tagSlug));
  const source = normalizeTagSource(input.source);
  const existing = dbFindTagBindings({
    assetType: input.assetType,
    assetId: input.assetId,
  });

  for (const binding of existing) {
    if ((binding.source === source || binding.metadata?.source === input.source) && !desired.has(binding.tagSlug)) {
      dbDeleteTagBinding({
        slug: binding.tagSlug,
        assetType: input.assetType,
        assetId: input.assetId,
        source,
      });
    }
  }

  return attached;
}

export function canonicalAssetIdsForTag(assetType: TagAssetType, tag?: string): string[] | undefined {
  if (!tag?.trim()) return undefined;
  const slug = tryNormalizeTagSlug(tag);
  if (!slug) return [];
  return [...new Set(dbFindTagBindings({ slug, assetType }).map((binding) => binding.assetId))];
}

export function canonicalTagSlugsForAsset(assetType: TagAssetType, assetId: string): string[] {
  return dbFindTagBindings({ assetType, assetId }).map((binding) => binding.tagSlug);
}

export function filterItemsByCanonicalTag<T>(
  items: T[],
  assetType: TagAssetType,
  tag: string | undefined,
  getAssetId: (item: T) => string,
): T[] {
  const assetIds = canonicalAssetIdsForTag(assetType, tag);
  if (!assetIds) return items;
  if (assetIds.length === 0) return [];
  const allowed = new Set(assetIds);
  return items.filter((item) => allowed.has(getAssetId(item)));
}
