import type { Decision, DecisionOwnerType, DecisionStatus } from "./types.js";
export type DecisionErrorCode =
  | "DECISION_ORIGIN_MISMATCH"
  | "DECISION_DELIVERY_UNCERTAIN"
  | "DECISION_NOT_FOUND"
  | "DECISION_NOT_OPEN"
  | "DECISION_SELF_ANSWER"
  | "DECISION_INVALID_KEY"
  | "DECISION_INVALID_OWNER"
  | "DECISION_INVALID_ASK"
  | "DECISION_INVALID_ANSWER";

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
