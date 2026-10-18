// The command gate every `ravi knowledge` command runs first (contract §11.2):
// the exposure gate (§11.3), then the turn classifier (§11.1). Both refusals
// are exit 3 with one English line in `issues[]` the agent acts on.

import { CONTRACT_EXIT_POLICY, ContractError, renderContractError } from "../../cli/agent-contract.js";
import { KNOWLEDGE_ISSUE_TEXT } from "../errors.js";
import type { KnowledgeTurn } from "../types.js";
import { inspectKnowledgeExposure, type KnowledgeExposureReport } from "./exposure.js";
import { classifyKnowledgeTurn, type KnowledgeTurnVerdict } from "./turn.js";

/** Offenders listed in the envelope; the rest are counted. */
const MAX_LISTED_OFFENDERS = 5;

export function assertKnowledgeAllowed(
  op: string,
  asJson: boolean,
  deps?: { exposure?: () => KnowledgeExposureReport; classify?: () => KnowledgeTurnVerdict },
): { turn: KnowledgeTurn } {
  const exposure = readExposure(deps?.exposure);
  if (!exposure.ok) fail(exposureError(op, exposure), asJson);

  const verdict = (deps?.classify ?? (() => classifyKnowledgeTurn()))();
  if (!verdict.ok) {
    fail(
      new ContractError(
        op,
        "KNOWLEDGE_TURN_NOT_OPERATOR",
        "Knowledge answers only the operator's own turns: the terminal, the operator's direct chat and the operator's routines.",
        CONTRACT_EXIT_POLICY,
        {
          retryable: false,
          refusal: verdict.reason,
          issues: [KNOWLEDGE_ISSUE_TEXT.KNOWLEDGE_TURN_NOT_OPERATOR as string],
        },
      ),
      asJson,
    );
  }
  return { turn: verdict.turn };
}

function readExposure(exposure: (() => KnowledgeExposureReport) | undefined): KnowledgeExposureReport {
  try {
    return (exposure ?? (() => inspectKnowledgeExposure()))();
  } catch {
    // Exposure that cannot be read is not known to be safe.
    return {
      ok: false,
      offenders: [{ agentId: "*", profile: "unknown", reasons: ["agents, instances and routes could not be read"] }],
      checkedAgents: 0,
    };
  }
}

function exposureError(op: string, report: KnowledgeExposureReport): ContractError {
  const listed = report.offenders.slice(0, MAX_LISTED_OFFENDERS);
  const more = report.offenders.length - listed.length;
  return new ContractError(
    op,
    "KNOWLEDGE_EXPOSURE_UNSAFE",
    "Knowledge is off while an agent people outside the org can reach is able to read files or run code.",
    CONTRACT_EXIT_POLICY,
    {
      retryable: false,
      offenders: report.offenders.length,
      issues: [
        "Tell the operator to run `ravi doctor` and make these agents chat-only (`ravi agents permissions <id> chat-only`) or close their outside routes; do not retry until then.",
        ...listed.map((offender) => `${offender.agentId} (${offender.profile}): ${offender.reasons.join("; ")}`),
        ...(more > 0 ? [`and ${more} more agent(s)`] : []),
      ],
    },
  );
}

function fail(error: ContractError, asJson: boolean): never {
  renderContractError(error, asJson);
  throw error;
}
