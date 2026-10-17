// STUB (wave A, K-O1). Owner: K-O3. Contract §11.3: the Knowledge exposure
// (doctor) gate. The signatures below are the contract; the bodies are
// replaced by the owner.

import type { InstanceConfig } from "../../router/router-db.js";
import type { AgentConfig, RouteConfig } from "../../router/types.js";

export type KnowledgeExposureOffender = { agentId: string; profile: string; reasons: string[] };
export type KnowledgeExposureReport = { ok: boolean; offenders: KnowledgeExposureOffender[]; checkedAgents: number };

export interface KnowledgeExposureDeps {
  listAgents?: () => AgentConfig[];
  listInstances?: () => InstanceConfig[];
  listRoutes?: () => RouteConfig[];
  isLinkedContact?: (contactId: string) => boolean;
}

export function inspectKnowledgeExposure(_deps?: KnowledgeExposureDeps): KnowledgeExposureReport {
  throw new Error("not implemented: inspectKnowledgeExposure");
}

/** `chat-only`, or `explicit-only` with no exec capability at all (contract §11.3). */
export function agentHasNoExec(_agentId: string): boolean {
  throw new Error("not implemented: agentHasNoExec");
}
