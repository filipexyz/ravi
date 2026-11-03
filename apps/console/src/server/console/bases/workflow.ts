// Approval and agent columns (SPEC "Approval Property", "Agent Property").
// Pure rules shared by the row write engine: who may decide an approval,
// what a write stores for an approval intent, `resetOn`, and the agent
// inputs hash that decides when an agent value is requested again.

import { createHash } from "node:crypto";

import type {
  BaseAgentValue,
  BaseApprovalPrincipal,
  BaseApprovalState,
  BaseApprovalValue,
  BaseProperty,
} from "@/shared/bases/types";
import { baseApprovalState, type BaseApprovalIntent } from "@/shared/bases/values";

import { projectRoleAtLeast, type BasesCallerAccess } from "./access";
import type { BasesCaller } from "./context";
import { basesError } from "./errors";

export const APPROVAL_FORBIDDEN_REASON = "Only an approver of this column may approve or reject.";

/** Humans only: a Console or Pages user, or a CLI session (delegated or not). Never system or anonymous callers. */
function isHumanCaller(caller: Pick<BasesCaller, "user" | "actorType">) {
  return caller.user !== null && (caller.actorType === "user" || caller.actorType === "cli");
}

/**
 * Whether the caller matches an approver of the property: a `user` principal
 * by id (active members only), a `project_role` principal by the caller's
 * effective project role (Pages callers use their real project role).
 */
export function canDecideApproval(
  property: Pick<BaseProperty, "type" | "config">,
  caller: Pick<BasesCaller, "user" | "actorType">,
  access: Pick<BasesCallerAccess, "projectRole" | "activeOrgMember" | "userId">,
): boolean {
  if (property.type !== "approval" || !isHumanCaller(caller) || !access.activeOrgMember) return false;
  const userId = caller.user?.id.toLowerCase() ?? null;
  return (property.config.approvers ?? []).some((principal: BaseApprovalPrincipal) =>
    principal.kind === "user"
      ? userId !== null && principal.userId.toLowerCase() === userId
      : projectRoleAtLeast(access.projectRole, principal.minRole),
  );
}

export function approvalForbidden(): never {
  throw basesError(403, { error: "approval_forbidden", reason: APPROVAL_FORBIDDEN_REASON });
}

function storedApproval(stored: unknown): Partial<BaseApprovalValue> {
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Partial<BaseApprovalValue>) : {};
}

/**
 * The stored value an approval intent produces. `pending` sets who asked and
 * when and clears the decision; `approved`/`rejected` need an approver and
 * set who decided and when. The same state and note again keep the stored
 * value (no change). Throws `403 approval_forbidden` for a non-approver's decision.
 */
export function resolveApprovalWrite(input: {
  property: BaseProperty;
  intent: BaseApprovalIntent;
  stored: unknown;
  caller: Pick<BasesCaller, "user" | "actorType">;
  access: Pick<BasesCallerAccess, "projectRole" | "activeOrgMember" | "userId">;
  now: Date;
}): BaseApprovalValue {
  const { intent, now } = input;
  const prior = storedApproval(input.stored);
  const priorState = baseApprovalState(input.stored);
  if (intent.state !== "pending" && !canDecideApproval(input.property, input.caller, input.access)) approvalForbidden();
  if (priorState === intent.state && (prior.note ?? null) === intent.note) return input.stored as BaseApprovalValue;
  const userId = input.caller.user?.id ?? null;
  if (intent.state === "pending") {
    return { state: "pending", requestedBy: userId, requestedAt: now.toISOString(), decidedBy: null, decidedAt: null, note: intent.note };
  }
  return {
    state: intent.state,
    requestedBy: prior.requestedBy ?? null,
    requestedAt: prior.requestedAt ?? null,
    decidedBy: userId,
    decidedAt: now.toISOString(),
    note: intent.note,
  };
}

/** `resetOn`: a decided approval goes back to `pending` (requested by the caller, no note). */
export function approvalReset(caller: Pick<BasesCaller, "user">, now: Date): BaseApprovalValue {
  return { state: "pending", requestedBy: caller.user?.id ?? null, requestedAt: now.toISOString(), decidedBy: null, decidedAt: null, note: null };
}

/**
 * Approval properties a write reset: decided (`approved`/`rejected`) before,
 * not set by the write itself, and one of their `resetOn` properties changed.
 */
export function approvalsToReset(
  properties: readonly BaseProperty[],
  before: Record<string, unknown>,
  changedIds: ReadonlySet<string>,
  explicitIds: ReadonlySet<string>,
): BaseProperty[] {
  return properties.filter((property) => {
    if (property.deletedAt || property.type !== "approval" || explicitIds.has(property.id)) return false;
    const state = baseApprovalState(before[property.id]);
    if (state !== "approved" && state !== "rejected") return false;
    return (property.config.resetOn ?? []).some((id) => changedIds.has(id));
  });
}

/** Approval states a write entered (state changed into it, or set from empty). */
export function approvalTransitions(
  properties: readonly BaseProperty[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ propertyId: string; state: BaseApprovalState }> {
  const transitions: Array<{ propertyId: string; state: BaseApprovalState }> = [];
  for (const property of properties) {
    if (property.type !== "approval") continue;
    const next = baseApprovalState(after[property.id]);
    if (next && next !== baseApprovalState(before[property.id])) transitions.push({ propertyId: property.id, state: next });
  }
  return transitions;
}

// ---------------------------------------------------------------------------
// Agent columns

function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * First 16 hex of sha256 over the canonical JSON array of the stored input
 * values, in `config.inputs` order (empty inputs are `null`).
 */
export function agentInputsHash(property: Pick<BaseProperty, "config">, values: Record<string, unknown>): string {
  const inputs = (property.config.inputs ?? []).map((id) => values[id] ?? null);
  return createHash("sha256").update(stableJson(inputs)).digest("hex").slice(0, 16);
}

function storedAgent(stored: unknown): Partial<BaseAgentValue> {
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Partial<BaseAgentValue>) : {};
}

/** The stored inputs hash of an agent value; null when empty. */
export function storedAgentInputsHash(stored: unknown): string | null {
  const hash = storedAgent(stored).inputsHash;
  return typeof hash === "string" ? hash : null;
}

/** An agent value waiting for the agent: keeps the previous value, clears the error. */
export function agentPendingValue(stored: unknown, inputsHash: string, now: Date): BaseAgentValue {
  const prior = storedAgent(stored);
  return { state: "pending", value: prior.value ?? null, error: null, inputsHash, updatedAt: now.toISOString() };
}

/**
 * Requests agent values a write needs: every active agent column on create,
 * or whose inputs hash changed on update. Mutates `next` and returns the
 * requests (property id and hash).
 */
export function applyAgentRequests(input: {
  properties: readonly BaseProperty[];
  before: Record<string, unknown> | null;
  next: Record<string, unknown>;
  now: Date;
}): Array<{ propertyId: string; inputsHash: string }> {
  const requests: Array<{ propertyId: string; inputsHash: string }> = [];
  for (const property of input.properties) {
    if (property.deletedAt || property.type !== "agent") continue;
    const inputsHash = agentInputsHash(property, input.next);
    const stored = input.next[property.id];
    if (input.before !== null && storedAgentInputsHash(stored) === inputsHash) continue;
    input.next[property.id] = agentPendingValue(stored, inputsHash, input.now);
    requests.push({ propertyId: property.id, inputsHash });
  }
  return requests;
}

/** Stored value of a fill: `done` with the value, or `error` keeping the previous value. */
export function agentFilledValue(
  stored: unknown,
  inputsHash: string,
  outcome: { value: BaseAgentValue["value"] } | { error: string },
  now: Date,
): BaseAgentValue {
  if ("error" in outcome) {
    return { state: "error", value: storedAgent(stored).value ?? null, error: outcome.error, inputsHash, updatedAt: now.toISOString() };
  }
  return { state: "done", value: outcome.value, error: null, inputsHash, updatedAt: now.toISOString() };
}

