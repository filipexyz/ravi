import { createHash, randomUUID } from "node:crypto";
import {
  getCrmAccount,
  getCrmFact,
  getCrmOpportunity,
  getCrmTask,
  getContactDetails,
  getCrmFacadePlan,
  saveCrmFacadePlan,
  updateCrmFacadePlanState,
  recordCrmFacadeApproval,
  claimCrmFacadePlanApply,
  saveCrmFacadeEffect,
  updateCrmFacadeEffect,
  completeCrmTask,
  cancelCrmTask,
  snoozeCrmTask,
  moveCrmOpportunityStage,
  confirmCrmFact,
  rejectCrmFact,
  updateCrmContactProfile,
  linkCrmAccountContact,
  linkCrmOpportunityContact,
  type CrmFact,
  type CrmOpportunity,
  type CrmTask,
} from "../contacts.js";

export const CRM_FACADE_OPERATIONS = [
  "task.done",
  "task.cancel",
  "task.snooze",
  "opportunity.move",
  "fact.confirm",
  "fact.reject",
  "contact.set",
  "account.link-contact",
  "opportunity.link-contact",
] as const;

export type CrmFacadeOperation = (typeof CRM_FACADE_OPERATIONS)[number];
export type CrmFacadePlanState = "planned" | "approved" | "applying" | "applied" | "unknown" | "partial";

export interface CrmFacadePlanInput {
  operation: CrmFacadeOperation;
  target: string;
  stage?: string;
  contact?: string;
  field?: string;
  value?: string;
  until?: string;
  reason?: string;
  role?: string;
  account?: string;
  primary?: boolean;
}

export interface CrmFacadePlan {
  schemaVersion: "crm.agent-first/v1";
  planId: string;
  planHash: string;
  state: CrmFacadePlanState;
  operation: CrmFacadeOperation;
  target: {
    type: string;
    id: string;
    label: string;
  };
  arguments: Record<string, unknown>;
  effects: Array<{
    effectId: string;
    operation: CrmFacadeOperation;
    primary: true;
    retry: "never";
  }>;
  approval: CrmFacadeApproval | null;
  createdAt: string;
  expiresAt: string;
}

export interface CrmFacadeApproval {
  planHash: string;
  approvedAt: string;
  source: { channel: string; accountId: string; chatId: string };
}

export type CrmFacadeApplyResult = {
  planId: string;
  planHash: string;
  state: "applied" | "unknown";
  effectId: string;
  readback?: unknown;
  reason?: string;
};

export class CrmFacadeResolutionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CrmFacadeResolutionError";
    this.code = code;
    this.details = details;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashPlan(plan: Omit<CrmFacadePlan, "planHash">): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new CrmFacadeResolutionError("MISSING_INPUT", `${field} is required`, { field });
  return normalized;
}

function resolveTarget(input: CrmFacadePlanInput): { type: string; id: string; label: string; subject: unknown } {
  switch (input.operation) {
    case "task.done":
    case "task.cancel":
    case "task.snooze": {
      const task = getCrmTask(input.target) as CrmTask | null;
      if (!task) throw new CrmFacadeResolutionError("CRM_TASK_NOT_FOUND", `CRM task not found: ${input.target}`);
      return { type: "task", id: task.id, label: task.title, subject: task };
    }
    case "opportunity.move":
    case "opportunity.link-contact": {
      const opportunity = getCrmOpportunity(input.target) as CrmOpportunity | null;
      if (!opportunity) {
        throw new CrmFacadeResolutionError("OPPORTUNITY_NOT_FOUND", `CRM opportunity not found: ${input.target}`);
      }
      return { type: "opportunity", id: opportunity.id, label: opportunity.title, subject: opportunity };
    }
    case "fact.confirm":
    case "fact.reject": {
      const fact = getCrmFact(input.target) as CrmFact | null;
      if (!fact) throw new CrmFacadeResolutionError("CRM_FACT_NOT_FOUND", `CRM fact not found: ${input.target}`);
      return { type: "fact", id: fact.id, label: fact.key, subject: fact };
    }
    case "contact.set": {
      const details = getContactDetails(input.target);
      if (!details) throw new CrmFacadeResolutionError("CONTACT_NOT_FOUND", `Contact not found: ${input.target}`);
      return { type: "contact", id: details.contact.id, label: details.contact.displayName ?? details.contact.id, subject: details };
    }
    case "account.link-contact": {
      const account = getCrmAccount(input.target);
      if (!account) throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${input.target}`);
      return { type: "account", id: account.account.id, label: account.account.name, subject: account.account };
    }
  }
}

function normalizeArguments(input: CrmFacadePlanInput): Record<string, unknown> {
  const args: Record<string, unknown> = { target: input.target };
  if (input.stage !== undefined) args.stage = input.stage;
  if (input.contact !== undefined) args.contact = input.contact;
  if (input.field !== undefined) args.field = input.field;
  if (input.value !== undefined) args.value = input.value;
  if (input.until !== undefined) args.until = input.until;
  if (input.reason !== undefined) args.reason = input.reason;
  if (input.role !== undefined) args.role = input.role;
  if (input.account !== undefined) args.account = input.account;
  if (input.primary !== undefined) args.primary = input.primary;
  return args;
}

function validateOperationInputs(input: CrmFacadePlanInput): void {
  if (input.operation === "task.snooze") required(input.until, "until");
  if (input.operation === "opportunity.move") required(input.stage, "stage");
  if (input.operation === "contact.set") {
    required(input.field, "field");
    required(input.value, "value");
  }
  if (input.operation.endsWith("link-contact")) required(input.contact, "contact");
}

export function buildCrmFacadePlan(input: CrmFacadePlanInput, now = new Date()): CrmFacadePlan {
  validateOperationInputs(input);
  const target = resolveTarget(input);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const effectId = randomUUID();
  const unsigned = {
    schemaVersion: "crm.agent-first/v1" as const,
    planId: randomUUID(),
    state: "planned" as const,
    operation: input.operation,
    target: { type: target.type, id: target.id, label: target.label },
    arguments: normalizeArguments(input),
    effects: [{ effectId, operation: input.operation, primary: true as const, retry: "never" as const }],
    approval: null,
    createdAt,
    expiresAt,
  };
  return { ...unsigned, planHash: hashPlan(unsigned) };
}

export function persistCrmFacadePlan(plan: CrmFacadePlan): void {
  saveCrmFacadePlan({ planId: plan.planId, planHash: plan.planHash, planJson: JSON.stringify(plan), state: plan.state, createdAt: plan.createdAt, expiresAt: plan.expiresAt, updatedAt: new Date().toISOString(), approvalJson: null, appliedAt: null });
}

export function loadCrmFacadePlan(planId: string): CrmFacadePlan | null {
  const record = getCrmFacadePlan(planId);
  if (!record) return null;
  const plan = JSON.parse(record.planJson) as CrmFacadePlan;
  return {
    ...plan,
    state: record.state as CrmFacadePlanState,
    approval: record.approvalJson ? JSON.parse(record.approvalJson) as CrmFacadeApproval : null,
  };
}

export function markCrmFacadePlan(planId: string, state: CrmFacadePlanState): void {
  updateCrmFacadePlanState(planId, state, new Date().toISOString(), state === "applied" ? new Date().toISOString() : undefined);
}

export function approveCrmFacadePlan(planId: string, source: CrmFacadeApproval["source"]): CrmFacadePlan {
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  if (plan.state !== "planned") throw new CrmFacadeResolutionError("PLAN_NOT_APPROVABLE", `CRM facade plan is ${plan.state}`);
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new CrmFacadeResolutionError("PLAN_EXPIRED", "CRM facade plan has expired");
  const approval: CrmFacadeApproval = { planHash: plan.planHash, approvedAt: new Date().toISOString(), source };
  recordCrmFacadeApproval(planId, JSON.stringify(approval), approval.approvedAt);
  return loadCrmFacadePlan(planId) ?? plan;
}

function effectReadback(plan: CrmFacadePlan): unknown {
  switch (plan.target.type) {
    case "task": return getCrmTask(plan.target.id);
    case "opportunity": return getCrmOpportunity(plan.target.id);
    case "fact": return getCrmFact(plan.target.id);
    case "contact": return getContactDetails(plan.target.id)?.crm ?? null;
    case "account": return getCrmAccount(plan.target.id);
    default: return null;
  }
}

function applyContactField(plan: CrmFacadePlan, idempotencyKey: string): void {
  const field = String(plan.arguments.field ?? "");
  const value = String(plan.arguments.value ?? "");
  const base = { contactRef: plan.target.id, source: "crm.facade", actorType: "agent", idempotencyKey };
  const nullable = value === "-" || value === "null" ? null : value;
  switch (field) {
    case "lifecycle": updateCrmContactProfile({ ...base, lifecycle: nullable }); return;
    case "relationship-health": case "health": updateCrmContactProfile({ ...base, relationshipHealth: nullable }); return;
    case "priority": updateCrmContactProfile({ ...base, priority: nullable }); return;
    case "score": updateCrmContactProfile({ ...base, score: nullable === null ? null : Number(nullable) }); return;
    case "health-score": updateCrmContactProfile({ ...base, healthScore: nullable === null ? null : Number(nullable) }); return;
    case "primary-account": updateCrmContactProfile({ ...base, primaryAccountId: nullable }); return;
    case "primary-opportunity": updateCrmContactProfile({ ...base, primaryOpportunityId: nullable }); return;
    case "lead-source": updateCrmContactProfile({ ...base, leadSource: nullable }); return;
    case "persona": updateCrmContactProfile({ ...base, persona: nullable }); return;
    case "buying-role": updateCrmContactProfile({ ...base, buyingRole: nullable }); return;
    case "next-action-at": updateCrmContactProfile({ ...base, nextActionAt: nullable }); return;
    case "next-action": updateCrmContactProfile({ ...base, nextActionSummary: nullable }); return;
    default: throw new CrmFacadeResolutionError("UNSUPPORTED_CONTACT_FIELD", `Unsupported CRM contact field: ${field}`);
  }
}

function executeEffect(plan: CrmFacadePlan, idempotencyKey: string): void {
  const args = plan.arguments;
  const source = "crm.facade";
  const actorType = "agent";
  switch (plan.operation) {
    case "task.done": completeCrmTask({ taskId: plan.target.id, source, actorType, idempotencyKey }); return;
    case "task.cancel": cancelCrmTask({ taskId: plan.target.id, reason: args.reason as string | undefined, source, actorType, idempotencyKey }); return;
    case "task.snooze": snoozeCrmTask({ taskId: plan.target.id, snoozedUntil: String(args.until), source, actorType, idempotencyKey }); return;
    case "opportunity.move": moveCrmOpportunityStage({ opportunityId: plan.target.id, stageRef: String(args.stage), source, actorType, idempotencyKey }); return;
    case "fact.confirm": confirmCrmFact({ factId: plan.target.id, source, actorType, idempotencyKey }); return;
    case "fact.reject": rejectCrmFact({ factId: plan.target.id, source, actorType, idempotencyKey }); return;
    case "contact.set": applyContactField(plan, idempotencyKey); return;
    case "account.link-contact": linkCrmAccountContact({ accountId: plan.target.id, contactRef: String(args.contact), role: args.role as string | undefined, source, actorType, idempotencyKey }); return;
    case "opportunity.link-contact": linkCrmOpportunityContact({ opportunityId: plan.target.id, contactRef: String(args.contact), accountId: args.account as string | undefined, role: args.role as string | undefined, isPrimary: args.primary as boolean | undefined, source, actorType, idempotencyKey }); return;
  }
}

export function applyCrmFacadePlan(planId: string): CrmFacadeApplyResult {
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  if (plan.state !== "approved" || !plan.approval || plan.approval.planHash !== plan.planHash) throw new CrmFacadeResolutionError("APPROVAL_REQUIRED", "A matching external approval is required");
  const now = new Date().toISOString();
  if (!claimCrmFacadePlanApply(planId, now)) throw new CrmFacadeResolutionError("PLAN_NOT_APPLICABLE", "Plan was consumed, expired, or is not approved");
  const effect = plan.effects[0];
  saveCrmFacadeEffect({ effectId: effect.effectId, planId, operation: effect.operation, state: "dispatched", idempotencyKey: effect.effectId, dispatchedAt: now });
  try {
    executeEffect(plan, effect.effectId);
    const readback = effectReadback(plan);
    const observedAt = new Date().toISOString();
    updateCrmFacadeEffect(effect.effectId, { state: "observed", observedAt, readbackJson: JSON.stringify(readback) });
    markCrmFacadePlan(planId, "applied");
    return { planId, planHash: plan.planHash, state: "applied", effectId: effect.effectId, readback };
  } catch (error) {
    markCrmFacadePlan(planId, "unknown");
    return { planId, planHash: plan.planHash, state: "unknown", effectId: effect.effectId, reason: error instanceof Error ? error.message : String(error) };
  }
}
