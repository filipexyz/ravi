// STUB (wave A, K-O1). Owner: K-O5. Contract §13.4: proposals to the Console.
// The signatures below are the contract; the bodies are replaced by the owner.

import type { KnowledgeClient } from "../client.js";
import type { ConsoleProposalCreate, ConsoleProposalView, KnowledgeTurn } from "../types.js";

export function planKnowledgeProposal(_input: {
  kind: "note" | "gap" | "correction" | "transcript";
  text?: string;
  transcriptKey?: string;
  from?: string[];
  supersedes?: string;
  project?: string | null;
  audience?: string | null;
}): {
  plan: ConsoleProposalCreate;
  summary: { kind: string; bytes: number; project: string | null; audience: string };
} {
  throw new Error("not implemented: planKnowledgeProposal");
}

export function submitKnowledgeProposal(
  _input: { plan: ConsoleProposalCreate; turn: KnowledgeTurn },
  _deps?: { client?: KnowledgeClient },
): Promise<{ proposal: ConsoleProposalView; deduped: boolean }> {
  throw new Error("not implemented: submitKnowledgeProposal");
}
