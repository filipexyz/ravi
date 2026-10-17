// STUB (wave A, K-O1). Owner: K-O5. Contract §13.1: Knowledge settings keys.
// The signature below is the contract; the body is replaced by the owner.

export interface KnowledgeSettings {
  contactMemoryAgents: string[];
  project: string | null;
  curatorAgent: string | null;
  digestTime: string;
  digestTimezone: string;
  ownerTarget: string | null;
  /** Hosts allowed in packet replies for this instance (`knowledge.egress.allow`), or null when unrestricted. */
  egressAllow(instanceName: string): string[] | null;
}

export function knowledgeSettings(): KnowledgeSettings {
  throw new Error("not implemented: knowledgeSettings");
}
