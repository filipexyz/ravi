/**
 * The owner answers a decision on its card, without typing its id or its scope.
 *
 * Channel-free: a channel adapter (Slack today) hands over what the click verified — the platform sender, the
 * decision and revision the card showed, the scope the person chose and the text they submitted — and gets back
 * whether it was recorded. Who the person is comes only from the platform's verified sender, through the same
 * channel lookup the grant gate uses; nothing typed is read as identity, id or scope. The answer itself goes through
 * the one answer path (`answerDecision`), which rechecks everything inside its transaction.
 *
 * Spec: decisions (owner answers on the card).
 */

import { resolveVerifiedSenderOwner } from "../approval/grantor.js";
import { DecisionError } from "./model.js";
import { answerDecision } from "./service.js";
import type { Decision } from "./types.js";

export type OwnerCardScope = "origin" | "org";

export interface OwnerCardAnswerInput {
  decisionId: string;
  /** The revision of the question the card showed; a later revision or an answered decision refuses. */
  revision: number;
  answer: string;
  scope: OwnerCardScope;
  actor: { channel: string; senderId: string; accountId?: string; instanceId?: string };
  /** The interaction's own id (e.g. the Slack view id), kept as the answer's provenance. */
  interactionRef: string;
}

export type OwnerCardRefusal =
  | "unknown_actor"
  | "not_owner"
  | "stale"
  | "not_found"
  | "scope_not_authorized"
  | "invalid_answer"
  | "failed";

export type OwnerCardAnswerOutcome =
  | { kind: "answered"; decision: Decision }
  | { kind: "refused"; reason: OwnerCardRefusal };

export interface OwnerCardDependencies {
  answer: typeof answerDecision;
  resolveSender: typeof resolveVerifiedSenderOwner;
}

const defaults: OwnerCardDependencies = { answer: answerDecision, resolveSender: resolveVerifiedSenderOwner };

const DECISION_ID = /^dec_[A-Za-z0-9_-]{1,64}$/;

export async function answerDecisionFromOwnerCard(
  input: OwnerCardAnswerInput,
  deps: OwnerCardDependencies = defaults,
): Promise<OwnerCardAnswerOutcome> {
  const decisionId = input.decisionId.trim();
  if (!DECISION_ID.test(decisionId) || !Number.isInteger(input.revision) || input.revision < 1)
    return { kind: "refused", reason: "not_found" };
  if (input.scope !== "origin" && input.scope !== "org") return { kind: "refused", reason: "scope_not_authorized" };
  const answer = input.answer.trim();
  if (!answer) return { kind: "refused", reason: "invalid_answer" };
  const interactionRef = input.interactionRef.trim();
  if (!interactionRef) return { kind: "refused", reason: "failed" };
  const owner = deps.resolveSender({
    channel: input.actor.channel,
    senderId: input.actor.senderId,
    ...(input.actor.accountId ? { accountId: input.actor.accountId } : {}),
    ...(input.actor.instanceId ? { instanceId: input.actor.instanceId } : {}),
  });
  if (!owner || owner.ownerType !== "contact" || !owner.ownerId) return { kind: "refused", reason: "unknown_actor" };
  try {
    const decision = await deps.answer(decisionId, answer, undefined, undefined, {
      scope: input.scope === "org" ? { type: "org", id: null } : { type: "origin", id: null },
      verifiedOwner: { contactId: owner.ownerId, revision: input.revision, ref: interactionRef },
    });
    return { kind: "answered", decision };
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    switch (error.code) {
      case "DECISION_SOURCE_NOT_OWNER":
        return { kind: "refused", reason: "not_owner" };
      case "DECISION_STALE_CARD":
      case "DECISION_NOT_OPEN":
        return { kind: "refused", reason: "stale" };
      case "DECISION_NOT_FOUND":
        return { kind: "refused", reason: "not_found" };
      case "DECISION_SCOPE_NOT_AUTHORIZED":
        return { kind: "refused", reason: "scope_not_authorized" };
      case "DECISION_INVALID_ANSWER":
        return { kind: "refused", reason: "invalid_answer" };
      default:
        return { kind: "refused", reason: "failed" };
    }
  }
}
