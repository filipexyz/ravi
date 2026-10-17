// STUB (wave A, K-O1). Owner: K-O3. Contract §11.1: the Knowledge turn
// classifier. The signatures below are the contract; the bodies are replaced
// by the owner.

import type { LibraryTurnDeps } from "../../library/turn.js";
import type { KnowledgeTurn } from "../types.js";

export type KnowledgeTurnVerdict =
  | { ok: true; turn: KnowledgeTurn }
  | {
      ok: false;
      code: "KNOWLEDGE_TURN_NOT_OPERATOR";
      reason: "group" | "contact" | "shared_session" | "routine" | "agent" | "unknown";
      actorPrincipal: string;
    };

export function classifyKnowledgeTurn(_deps?: LibraryTurnDeps): KnowledgeTurnVerdict {
  throw new Error("not implemented: classifyKnowledgeTurn");
}

export function isKnowledgeOperatorTurn(_deps?: LibraryTurnDeps): boolean {
  throw new Error("not implemented: isKnowledgeOperatorTurn");
}
