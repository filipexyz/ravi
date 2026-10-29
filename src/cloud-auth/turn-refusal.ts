/**
 * Why Ravi refused to act for a runtime turn (`ACTOR_UNKNOWN`), and the copy
 * that goes with it.
 *
 * The refusal is built here, on this side, before any Console call. It is a
 * {@link TurnRefusalError}, so the CLI envelope can trust its message and
 * suggested action; an `ACTOR_UNKNOWN` read from a Console response is a
 * plain CloudAuthError and keeps the catalog copy whatever its details say.
 */

import { CloudAuthError } from "./errors.js";

export type TurnRefusalReason =
  /** A cron job someone other than the operator owns: it never acts as the operator. */
  | { kind: "routine_not_operator_owned"; routine: "cron"; jobId: string; ownerPrincipal: string }
  /** Another agent's turn relaying a request. */
  | { kind: "agent_relay" }
  /** The turn already ended. */
  | { kind: "ended" }
  /** An unresolved speaker, or a turn the classification could not read. */
  | { kind: "unknown" };

export interface TurnRefusal {
  reason: TurnRefusalReason;
  actorPrincipal: string;
}

/** What the refused call would have done, for the copy. */
export type TurnRefusalSurface = "bases" | "access" | "cloud-runs";

const SURFACE_ACTION: Record<TurnRefusalSurface, string> = {
  bases: "read or write Bases",
  access: "share, invite or ask for access",
  "cloud-runs": "decide a cloud run",
};

export function turnRefusalCopy(
  reason: TurnRefusalReason,
  surface: TurnRefusalSurface,
): { message: string; suggestedAction: string } {
  const action = SURFACE_ACTION[surface];
  switch (reason.kind) {
    case "routine_not_operator_owned":
      return {
        message: `This turn is a run of cron job ${reason.jobId}, which ${reason.ownerPrincipal} owns, not the operator. A routine someone else owns never acts as the operator, so Ravi will not ${action} for this run.`,
        suggestedAction: `do not retry from this run and do not disable the job; report to the operator that cron job ${reason.jobId} runs as ${reason.ownerPrincipal}: they review its message or command (\`ravi cron show ${reason.jobId}\`) and, if it should act as the operator, recreate it from an operator turn (the terminal or their own chat)`,
      };
    case "agent_relay":
      return {
        message: `This turn relays another agent's request, so Ravi will not ${action} for anyone, not even as the operator.`,
        suggestedAction:
          "do not retry from this turn; tell the session that asked that you cannot do it for them, or the operator can run the command in the terminal",
      };
    case "ended":
      return {
        message: `The turn this command belongs to already ended, so Ravi will not ${action} for anyone, not even as the operator.`,
        suggestedAction: "do not retry from this turn; the person can ask again from their own chat",
      };
    case "unknown":
      return {
        message: `Ravi could not tell who is asking in this turn, so it will not ${action} for anyone, not even as the operator.`,
        suggestedAction:
          "do not retry from this turn; the person can ask from their own chat, or the operator can run the command in the terminal",
      };
  }
}

/**
 * The message with its next step, for surfaces whose text output prints only
 * the message (Pages access, cloud runs). Bases prints `Next:` itself.
 */
export function turnRefusalMessageWithNext(reason: TurnRefusalReason, surface: TurnRefusalSurface): string {
  const copy = turnRefusalCopy(reason, surface);
  return `${copy.message} Next: ${copy.suggestedAction}.`;
}

/**
 * Public fields of a reason for the envelope. The key is `refusalReason`:
 * public redaction treats a `reason` key as free text.
 */
export function turnRefusalDetails(reason: TurnRefusalReason): Record<string, string> {
  if (reason.kind === "routine_not_operator_owned") {
    return {
      refusalReason: reason.kind,
      routine: reason.routine,
      jobId: reason.jobId,
      ownerPrincipal: reason.ownerPrincipal,
    };
  }
  return { refusalReason: reason.kind };
}

/** `ACTOR_UNKNOWN` built locally from a turn refusal (exit 3). */
export class TurnRefusalError extends CloudAuthError {
  readonly reason: TurnRefusalReason;
  readonly suggestedAction: string;

  constructor(reason: TurnRefusalReason, surface: TurnRefusalSurface) {
    const copy = turnRefusalCopy(reason, surface);
    super("ACTOR_UNKNOWN", copy.message, { details: turnRefusalDetails(reason) });
    this.name = "TurnRefusalError";
    this.reason = reason;
    this.suggestedAction = copy.suggestedAction;
  }
}

/**
 * `unattributedTurn` hooks answer a boolean (tests, older callers) or the
 * refusal itself. `true` is a refusal with an unknown reason.
 */
export function normalizeTurnRefusal(value: boolean | TurnRefusal | null | undefined): TurnRefusal | null {
  if (value === true) return { reason: { kind: "unknown" }, actorPrincipal: "unknown" };
  if (!value) return null;
  return value;
}
