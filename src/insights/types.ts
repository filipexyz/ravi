export const INSIGHT_KINDS = ["observation", "pattern", "win", "problem", "improvement"] as const;
export const INSIGHT_CONFIDENCE = ["low", "medium", "high"] as const;
export const INSIGHT_IMPORTANCE = ["low", "normal", "high"] as const;
export const INSIGHT_ACTOR_KINDS = ["agent", "human", "system"] as const;
export const INSIGHT_ORIGIN_KINDS = ["runtime-context", "task", "session", "manual", "system"] as const;
export const INSIGHT_LINK_TARGET_TYPES = ["task", "session", "agent", "artifact", "profile"] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];
export type InsightConfidence = (typeof INSIGHT_CONFIDENCE)[number];
export type InsightImportance = (typeof INSIGHT_IMPORTANCE)[number];
export type InsightActorKind = (typeof INSIGHT_ACTOR_KINDS)[number];
export type InsightLinkTargetType = (typeof INSIGHT_LINK_TARGET_TYPES)[number];

export interface InsightActor {
  kind: InsightActorKind;
  name: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  contextId?: string;
}

export interface InsightOrigin {
  kind: (typeof INSIGHT_ORIGIN_KINDS)[number];
  contextId?: string;
  taskId?: string;
  agentId?: string;
  sessionName?: string;
}

export interface InsightRecord {
  id: string;
  kind: InsightKind;
  summary: string;
  detail?: string;
  confidence: InsightConfidence;
  importance: InsightImportance;
  author: InsightActor;
  origin: InsightOrigin;
  createdAt: number;
  updatedAt: number;
}

export interface InsightSummary extends InsightRecord {
  linkCount: number;
  commentCount: number;
}

export interface InsightLink {
  id: string;
  insightId: string;
  targetType: InsightLinkTargetType;
  targetId: string;
  label?: string;
  metadata?: Record<string, unknown>;
  createdBy?: InsightActor;
  createdAt: number;
  updatedAt: number;
}

export interface InsightComment {
  id: string;
  insightId: string;
  body: string;
  author: InsightActor;
  createdAt: number;
}

export interface InsightDetail extends InsightRecord {
  links: InsightLink[];
  comments: InsightComment[];
}

export interface CreateInsightInput {
  summary: string;
  detail?: string;
  kind?: InsightKind;
  confidence?: InsightConfidence;
  importance?: InsightImportance;
  author: InsightActor;
  origin: InsightOrigin;
  links?: Array<{
    targetType: InsightLinkTargetType;
    targetId: string;
    label?: string;
    metadata?: Record<string, unknown>;
    createdBy?: InsightActor;
  }>;
}

export interface InsightListQuery {
  kind?: InsightKind;
  confidence?: InsightConfidence;
  importance?: InsightImportance;
  authorKind?: InsightActorKind;
  authorAgentId?: string;
  authorSessionName?: string;
  linkType?: InsightLinkTargetType;
  linkId?: string;
  text?: string;
  limit?: number;
}

export interface UpsertInsightLinkInput {
  insightId: string;
  targetType: InsightLinkTargetType;
  targetId: string;
  label?: string;
  metadata?: Record<string, unknown>;
  createdBy?: InsightActor;
}

export interface AddInsightCommentInput {
  insightId: string;
  body: string;
  author: InsightActor;
}
