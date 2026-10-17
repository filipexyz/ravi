// STUB (wave A, K-O1). Owner: K-O5. Contract §13.2: the local contact-memory
// item store. The signatures below are the contract; the bodies are replaced
// by the owner.

import type { KnowledgeTrustTier } from "../types.js";

export type KnowledgeItem = {
  id: string;
  scope: "contact" | "chat";
  subjectId: string;
  agentId: string | null;
  kind: "fact" | "preference" | "open_loop" | "commitment";
  key: string;
  body: string;
  status: "draft" | "active" | "archived" | "redacted";
  trust: KnowledgeTrustTier;
  speaker: "operator" | "contact" | "agent" | null;
  recordedAt: number;
  expiresAt: number | null;
  supersededBy: string | null;
  createdBy: "operator" | "curator" | "marker";
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeItemSourceInput = {
  kind: "message" | "operator" | "meeting";
  ref: string;
  textHash: string;
  span?: string;
};

export function insertKnowledgeItem(
  _input: Omit<KnowledgeItem, "id" | "createdAt" | "updatedAt"> & { sources: KnowledgeItemSourceInput[] },
): KnowledgeItem {
  throw new Error("not implemented: insertKnowledgeItem");
}

/** Active items for the subject where `agent_id = agentId OR agent_id IS NULL`. */
export function listActiveItemsForSubject(_input: {
  scope: "contact" | "chat";
  subjectId: string;
  agentId: string;
  limit: number;
}): KnowledgeItem[] {
  throw new Error("not implemented: listActiveItemsForSubject");
}

export function getKnowledgeItem(_id: string): KnowledgeItem | null {
  throw new Error("not implemented: getKnowledgeItem");
}

export function archiveItemsForSubject(_input: { scope: "contact" | "chat"; subjectId: string }): number {
  throw new Error("not implemented: archiveItemsForSubject");
}

/** body = "[redacted]", status redacted, sources span = null. */
export function redactItemsForSubject(_input: { scope: "contact" | "chat"; subjectId: string }): number {
  throw new Error("not implemented: redactItemsForSubject");
}
