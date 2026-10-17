// STUB (wave A, K-O1). Owner: K-O6. Contract §13.6: the gaps store.
// `instanceId` is the OSS instance name (`source.accountId`), never the Omni
// UUID. The signatures below are the contract; the bodies are replaced by the
// owner.

export type KnowledgeGap = {
  id: string;
  agentId: string;
  instanceId: string;
  channel: string;
  accountId: string;
  chatId: string;
  contactId: string;
  sessionName: string;
  question: string;
  questionHash: string;
  status: "pending" | "uploaded" | "answered" | "notified" | "dropped";
  proposalId: string | null;
  createdAt: number;
  uploadedAt: number | null;
  notifiedAt: number | null;
};

export function insertKnowledgeGap(_input: {
  agentId: string;
  instanceId: string;
  channel: string;
  accountId: string;
  chatId: string;
  contactId: string;
  sessionName: string;
  question: string;
}): { gap: KnowledgeGap; created: boolean; capped: boolean } {
  throw new Error("not implemented: insertKnowledgeGap");
}

export function listGapsByStatus(_status: KnowledgeGap["status"], _limit: number): KnowledgeGap[] {
  throw new Error("not implemented: listGapsByStatus");
}

export function updateGap(
  _id: string,
  _patch: Partial<Pick<KnowledgeGap, "status" | "proposalId" | "uploadedAt" | "notifiedAt">>,
): void {
  throw new Error("not implemented: updateGap");
}

export function listGapsForProposal(_proposalId: string): KnowledgeGap[] {
  throw new Error("not implemented: listGapsForProposal");
}

/** UPDATE … SET status='notified' WHERE status IN ('uploaded','answered') [AND instance_id IN instanceIds] RETURNING … */
export function claimGapsForNotification(_proposalId: string, _instanceIds?: readonly string[]): KnowledgeGap[] {
  throw new Error("not implemented: claimGapsForNotification");
}

/** Status 'answered', for mirror sync step 4. */
export function listAnsweredGaps(_limit: number): KnowledgeGap[] {
  throw new Error("not implemented: listAnsweredGaps");
}
