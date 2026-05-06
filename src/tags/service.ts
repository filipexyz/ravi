import { dbDeleteTagBinding, dbFindTagBindings, dbUpsertTagBinding, normalizeTagSlug } from "./tag-db.js";
import type { TagBinding, TagBindingQuery } from "./types.js";
import {
  resolveTagTargetSelector,
  type ResolvedTagTarget,
  type TagTargetOperation,
  type TagTargetSelectorInput,
} from "./targets.js";

export interface ResolveTagTargetInput {
  selector: TagTargetSelectorInput;
  operation: TagTargetOperation;
}

export interface AttachTagToSelectorInput {
  slug: string;
  selector: TagTargetSelectorInput;
  source?: string;
  metadata?: Record<string, unknown>;
  actor?: string;
}

export interface DetachTagFromSelectorInput {
  slug: string;
  selector: TagTargetSelectorInput;
  source?: string;
  actor?: string;
}

export interface SearchTagBindingsForSelectorInput {
  selector?: TagTargetSelectorInput;
  query?: Omit<TagBindingQuery, "assetType" | "assetId" | "slug"> & {
    slug?: string;
  };
}

export function resolveTagTarget(input: ResolveTagTargetInput): ResolvedTagTarget {
  return resolveTagTargetSelector(input.selector, { operation: input.operation });
}

export function attachTagToSelector(input: AttachTagToSelectorInput): {
  target: ResolvedTagTarget;
  binding: TagBinding;
} {
  const target = resolveTagTargetSelector(input.selector, { operation: "attach" });
  const binding = dbUpsertTagBinding({
    slug: normalizeTagSlug(input.slug),
    assetType: target.assetType,
    assetId: target.assetId,
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.actor ? { createdBy: input.actor } : {}),
  });
  return { target, binding };
}

export function detachTagFromSelector(input: DetachTagFromSelectorInput): {
  target: ResolvedTagTarget;
  removed: boolean;
} {
  const target = resolveTagTargetSelector(input.selector, { operation: "detach" });
  const deleteInput = {
    slug: normalizeTagSlug(input.slug),
    assetType: target.assetType,
    assetId: target.assetId,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
  };
  return {
    target,
    removed: dbDeleteTagBinding(deleteInput),
  };
}

export function searchTagBindingsForSelector(input: SearchTagBindingsForSelectorInput = {}): {
  target?: ResolvedTagTarget;
  bindings: TagBinding[];
} {
  const target = input.selector ? resolveTagTargetSelector(input.selector, { operation: "search" }) : undefined;
  const bindings = dbFindTagBindings({
    ...(input.query?.slug ? { slug: normalizeTagSlug(input.query.slug) } : {}),
    ...(target ? { assetType: target.assetType, assetId: target.assetId } : {}),
    ...(input.query?.kind ? { kind: input.query.kind } : {}),
    ...(input.query?.source ? { source: input.query.source } : {}),
    ...(input.query?.limit ? { limit: input.query.limit } : {}),
    ...(input.query?.sort ? { sort: input.query.sort } : {}),
    ...(input.query?.order ? { order: input.query.order } : {}),
    ...(input.query?.cursor ? { cursor: input.query.cursor } : {}),
  });
  return { target, bindings };
}
