export const TAG_KINDS = ["system", "user"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const TAG_ASSET_TYPES = [
  "agent",
  "automation",
  "app",
  "session",
  "task",
  "project",
  "profile",
  "contact",
  "chat",
  "route",
  "instance",
  "artifact",
  "insight",
  "workflow_spec",
  "workflow_run",
  "workflow_node",
  "cron_job",
  "trigger",
  "hook",
  "task_automation",
  "observer_rule",
  "observer_binding",
  "observer_profile",
  "command",
  "skill",
  "skill_gate_rule",
  "context",
  "call_profile",
  "call_request",
  "call_voice_agent",
  "call_tool",
  "outbound_queue",
  "outbound_entry",
  "spec",
  "devin_session",
] as const;
export type TagAssetType = (typeof TAG_ASSET_TYPES)[number];

export const TAG_LIST_SORT_FIELDS = ["updated", "created"] as const;
export type TagListSort = (typeof TAG_LIST_SORT_FIELDS)[number];
export type TagListOrder = "asc" | "desc";

export interface TagListCursor {
  sort: TagListSort;
  order: TagListOrder;
  value: number;
  id: string;
  filters?: string;
}

export interface TagDefinition {
  id: string;
  slug: string;
  label: string;
  description?: string;
  kind: TagKind;
  source: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  updatedBy?: string;
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
  source: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export type TagEventType =
  | "tag.definition.created"
  | "tag.definition.updated"
  | "tag.binding.attached"
  | "tag.binding.updated"
  | "tag.binding.detached";

export interface TagEvent {
  id: number;
  type: TagEventType;
  tagId?: string;
  tagSlug: string;
  assetType?: TagAssetType;
  assetId?: string;
  actor?: string;
  source: string;
  previous?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface CreateTagDefinitionInput {
  slug: string;
  label: string;
  description?: string;
  kind?: TagKind;
  source?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export interface UpdateTagDefinitionInput {
  slug: string;
  label?: string;
  description?: string | null;
  kind?: TagKind;
  source?: string;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface UpsertTagBindingInput {
  slug: string;
  assetType: TagAssetType;
  assetId: string;
  metadata?: Record<string, unknown>;
  source?: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface TagBindingQuery {
  slug?: string;
  assetType?: TagAssetType;
  assetId?: string;
  kind?: TagKind;
  source?: string;
  limit?: number;
  sort?: TagListSort;
  order?: TagListOrder;
  cursor?: TagListCursor;
}

export interface TagDefinitionListQuery {
  kind?: TagKind;
  source?: string;
  query?: string;
  limit?: number;
  sort?: TagListSort;
  order?: TagListOrder;
  cursor?: TagListCursor;
}

export interface TagEventQuery {
  slug?: string;
  assetType?: TagAssetType;
  assetId?: string;
  limit?: number;
}
