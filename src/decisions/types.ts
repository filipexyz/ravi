export type DecisionStatus = "open" | "answered" | "superseded";
export type DecisionOwnerType = "human" | "agent" | "unassigned";

/** The origin owns authorization. A thread's chat and waiting session are distinct identities. */
export interface DecisionOrigin {
  type: "task" | "thread";
  id: string;
  chatId: string | null;
  sessionKey: string | null;
}

export interface Decision {
  id: string;
  origin: DecisionOrigin;
  key: string;
  status: DecisionStatus;
  ownerType: DecisionOwnerType;
  ownerId: string | null;
  ask: string;
  askedBy: string | null;
  askedAt: number;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
  blocks: boolean;
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
}
