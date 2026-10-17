// STUB (wave A, K-O1). Owner: K-O3. Contract §11.2: the command gate every
// `ravi knowledge` command runs first. Throws ContractError (exit 3)
// KNOWLEDGE_EXPOSURE_UNSAFE first, then KNOWLEDGE_TURN_NOT_OPERATOR. The
// signature below is the contract; the body is replaced by the owner.

import type { KnowledgeTurn } from "../types.js";
import type { KnowledgeExposureReport } from "./exposure.js";
import type { KnowledgeTurnVerdict } from "./turn.js";

export function assertKnowledgeAllowed(
  _op: string,
  _asJson: boolean,
  _deps?: { exposure?: () => KnowledgeExposureReport; classify?: () => KnowledgeTurnVerdict },
): { turn: KnowledgeTurn } {
  throw new Error("not implemented: assertKnowledgeAllowed");
}
