import type { Decision, DecisionOwnerType, DecisionScope, DecisionStatus } from "./types.js";

/** A verified rejection before queueing or execution; safe to retry with the same delivery id. */
export class DecisionDispatchRejectedError extends Error {
  readonly reason = "DECISION_AGENT_MISSING";
  constructor() {
    super("The waiting session's agent is unavailable; the decision was not admitted.");
    this.name = "DecisionDispatchRejectedError";
  }
}
export type DecisionErrorCode =
  | "DECISION_ORIGIN_MISMATCH"
  | "DECISION_DELIVERY_UNCERTAIN"
  | "DECISION_NOT_FOUND"
  | "DECISION_NOT_OPEN"
  | "DECISION_SELF_ANSWER"
  | "DECISION_INVALID_KEY"
  | "DECISION_INVALID_OWNER"
  | "DECISION_INVALID_ASK"
  | "DECISION_INVALID_ANSWER"
  | "DECISION_SOURCE_NOT_OWNER"
  | "DECISION_SOURCE_BEFORE_QUESTION"
  | "DECISION_SOURCE_AMBIGUOUS"
  | "DECISION_SOURCE_NO_MATCH"
  | "DECISION_INVALID_SCOPE"
  | "DECISION_SCOPE_NOT_AUTHORIZED"
  | "DECISION_NOT_ANSWERED"
  | "DECISION_STALE_CARD";

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly exitCode: number;
  readonly suggestedAction?: string;

  constructor(code: DecisionErrorCode, message: string, options: { exitCode?: number; suggestedAction?: string } = {}) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.suggestedAction = options.suggestedAction;
  }
}

export const DECISION_STATUSES = ["open", "answered", "superseded"] as const satisfies readonly DecisionStatus[];

export const DECISION_OWNER_TYPES = ["human", "agent", "unassigned"] as const satisfies readonly DecisionOwnerType[];

const DECISION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Normalize and validate a decision key. Keys are stable per origin. */
export function normalizeDecisionKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (!DECISION_KEY_PATTERN.test(key)) {
    throw new DecisionError(
      "DECISION_INVALID_KEY",
      `Invalid decision key ${JSON.stringify(raw ?? "")}: use a lowercase slug (a-z, 0-9, dot, dash, underscore; max 64 chars).`,
      { exitCode: 2, suggestedAction: "Pick a stable key such as 'deploy-window' or 'owner-approval'." },
    );
  }
  return key;
}

/**
 * Parse `human:<contact>`, `agent:<id>` or `unassigned`. Anything else is a
 * usage error; the owner is never inferred from free text.
 */
export function parseDecisionOwner(raw: string | null | undefined): {
  ownerType: DecisionOwnerType;
  ownerId: string | null;
} {
  const value = (raw ?? "").trim();
  if (!value) {
    return { ownerType: "unassigned", ownerId: null };
  }
  if (value === "unassigned") {
    return { ownerType: "unassigned", ownerId: null };
  }

  const separator = value.indexOf(":");
  const ownerType = (separator === -1 ? "" : value.slice(0, separator)) as DecisionOwnerType;
  const ownerId = separator === -1 ? "" : value.slice(separator + 1).trim();
  if (!DECISION_OWNER_TYPES.includes(ownerType) || ownerType === "unassigned" || !ownerId) {
    throw new DecisionError(
      "DECISION_INVALID_OWNER",
      `Invalid decision owner ${JSON.stringify(value)}: use human:<contact>, agent:<agent-id> or unassigned.`,
      { exitCode: 2, suggestedAction: "Pass --owner human:<contact-id>, --owner agent:<agent-id> or omit it." },
    );
  }
  return { ownerType, ownerId };
}

export function formatDecisionOwner(decision: Pick<Decision, "ownerType" | "ownerId">): string {
  return decision.ownerType === "unassigned" || !decision.ownerId
    ? "unassigned"
    : `${decision.ownerType}:${decision.ownerId}`;
}

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Parse `thread`, `task`, `agent:<id>`, `project:<id>` or `org`. `thread` and `task` both mean the asking origin;
 * an empty value is the origin too. Anything else is a usage error.
 */
export function parseDecisionScope(raw: string | null | undefined): DecisionScope {
  const value = (raw ?? "").trim();
  if (!value || value === "thread" || value === "task" || value === "origin") return { type: "origin", id: null };
  if (value === "org") return { type: "org", id: null };
  const separator = value.indexOf(":");
  const type = separator === -1 ? "" : value.slice(0, separator);
  const id = separator === -1 ? "" : value.slice(separator + 1).trim();
  if ((type === "agent" || type === "project") && SCOPE_ID_PATTERN.test(id)) return { type, id };
  throw new DecisionError(
    "DECISION_INVALID_SCOPE",
    `Invalid decision scope ${JSON.stringify(value)}: use thread, agent:<id>, project:<id> or org.`,
    { exitCode: 2, suggestedAction: "Omit --scope to keep the decision in its thread or task." },
  );
}

export function formatDecisionScope(decision: Pick<Decision, "scope" | "origin">): string {
  const { scope } = decision;
  if (scope.type === "origin") return decision.origin.type;
  return scope.type === "org" ? "org" : `${scope.type}:${scope.id}`;
}

export function sameDecisionScope(a: DecisionScope, b: DecisionScope): boolean {
  return a.type === b.type && (a.id ?? null) === (b.id ?? null);
}
