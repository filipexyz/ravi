// STUB (wave A, K-O1). Owner: K-O5. Contract §13.2: remember, confirm and
// forget. The signatures below are the contract; the bodies are replaced by
// the owner.

import type { KnowledgeTurn } from "../types.js";
import type { KnowledgeItem } from "./store.js";

export function rememberKnowledgeItem(_input: {
  text: string;
  about: { kind: "contact" | "chat"; id: string };
  kind?: KnowledgeItem["kind"];
  key?: string;
  agentId?: string | null;
  turn: KnowledgeTurn;
}): { item: KnowledgeItem; activated: boolean; reason: string | null } {
  throw new Error("not implemented: rememberKnowledgeItem");
}

/** Terminal only: `turn.turnKey === null`, else KNOWLEDGE_TURN_NOT_OPERATOR. */
export function confirmKnowledgeDraft(_input: { id: string; turn: KnowledgeTurn }): KnowledgeItem {
  throw new Error("not implemented: confirmKnowledgeDraft");
}

export function forgetKnowledge(_input: {
  id?: string;
  about?: { kind: "contact" | "chat"; id: string };
  redact: boolean;
}): { archived: number; redacted: number; ftsRowsDeleted: number } {
  throw new Error("not implemented: forgetKnowledge");
}
