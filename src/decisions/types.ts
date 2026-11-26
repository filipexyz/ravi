export type DecisionStatus = "open" | "answered" | "superseded";
export type DecisionOwnerType = "human" | "agent" | "unassigned";

/** The origin owns authorization. A thread's chat and waiting session are distinct identities. */
export interface DecisionOrigin {
  type: "task" | "thread";
  id: string;
  chatId: string | null;
  sessionKey: string | null;
}

/**
 * Where an answered decision applies. `origin` is the asking thread or task (the default). Wider scopes need the
 * owner's verified word or the local operator; they reach every turn they cover.
 */
export type DecisionScopeType = "origin" | "agent" | "project" | "org";

export interface DecisionScope {
  type: DecisionScopeType;
  id: string | null;
}

export interface Decision {
  id: string;
  origin: DecisionOrigin;
  key: string;
  /** Proposed while open; final once answered. */
  scope: DecisionScope;
  status: DecisionStatus;
  ownerType: DecisionOwnerType;
  ownerId: string | null;
  ask: string;
  askedBy: string | null;
  askedAt: number;
  /** When the current wording of the question was asked; a source must not predate it. */
  revisedAt: number;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
  blocks: boolean;
  /** The owner's message that holds the answer, and the excerpt of it that binds it to this decision. */
  sourceMessageId: string | null;
  sourceExcerpt: string | null;
  /** Set when a later decision replaced this one; it leaves every turn's context and keeps its history. */
  supersededBy: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface DecisionAsk {
  key: string;
  ask: string;
  ownerType?: DecisionOwnerType;
  ownerId?: string | null;
  blocks?: boolean;
  actor?: string;
  /** Proposed scope; the answer settles it. */
  scope?: DecisionScope;
}
