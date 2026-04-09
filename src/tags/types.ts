export type TagKind = "system" | "user";

export type TagAssetType = "agent" | "session";

export interface TagDefinition {
  id: string;
  slug: string;
  label: string;
  description?: string;
  kind: TagKind;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TagDefinitionSummary extends TagDefinition {
  bindingCount: number;
}

export interface TagBinding {
  id: string;
  tagId: string;
  tagSlug: string;
  assetType: TagAssetType;
  assetId: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTagDefinitionInput {
  slug: string;
  label: string;
  description?: string;
  kind?: TagKind;
  metadata?: Record<string, unknown>;
}

export interface UpsertTagBindingInput {
  slug: string;
  assetType: TagAssetType;
  assetId: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface TagBindingQuery {
  slug?: string;
  assetType?: TagAssetType;
  assetId?: string;
}
