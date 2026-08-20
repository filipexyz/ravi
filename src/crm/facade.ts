import { createHash, randomUUID } from "node:crypto";
import {
  getCrmAccountContact,
  getCrmAccountSummary,
  getCrmFact,
  getCrmOpportunity,
  getCrmPipelineStage,
  getCrmTask,
  getContactDetails,
  getCrmContactProfile,
  getCrmFacadePlan,
  saveCrmFacadePlan,
  pruneExpiredUnapprovedCrmFacadePlans,
  updateCrmFacadePlanState,
  recordCrmFacadeApprovalRequest as persistCrmFacadeApprovalRequest,
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
  getCrmOpportunityContact,
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
  state: "requested" | "approved";
  requestedAt: string;
  approvedAt: string | null;
  source: { channel: string; accountId: string; chatId: string; threadId?: string };
  externalMessageId: string;
  authorizedApproverId: string;
  approverId: string | null;
}

export type CrmFacadeApplyResult = {
  planId: string;
  planHash: string;
  state: "applied" | "partial" | "unknown";
  effectId: string;
  readback?: unknown;
  reason?: string;
};

export type CrmFacadeVerification = {
  planId: string;
  planHash: string;
  state: CrmFacadePlanState;
  outcome: "applied" | "not_applied" | "partial" | "not_determined";
  expired: boolean;
  observedAt: string;
  readback: unknown;
};

export interface CrmFacadeExecutionContext {
  actorId: string;
}

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

const CONTACT_LIFECYCLE_VALUES = [
  "unknown",
  "lead",
  "qualified",
  "active",
  "onboarding",
  "waiting",
  "at_risk",
  "dormant",
  "churned",
  "partner",
  "vendor",
  "internal",
] as const;
const CONTACT_HEALTH_VALUES = ["unknown", "good", "neutral", "needs_attention", "at_risk"] as const;
const CONTACT_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
const CONTACT_FIELDS = [
  "lifecycle",
  "relationship-health",
  "health",
  "priority",
  "score",
  "health-score",
  "primary-account",
  "primary-opportunity",
  "lead-source",
  "persona",
  "buying-role",
  "next-action-at",
  "next-action",
] as const;

type ResolvedTarget = { type: string; id: string; label: string; subject: unknown };

function normalizedEnum(value: string, field: string, acceptedValues: readonly string[]): string {
  const normalized = value.trim().toLowerCase();
  if (!acceptedValues.includes(normalized)) {
    throw new CrmFacadeResolutionError("INVALID_CONTACT_FIELD_VALUE", `Invalid ${field}: ${value}`, {
      field,
      acceptedValues,
    });
  }
  return normalized;
}

function isContactClearValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "-" || normalized === "null";
}

function normalizeContactFieldValue(field: string, rawValue: string): unknown {
  if (isContactClearValue(rawValue)) return null;
  switch (field) {
    case "lifecycle":
      return normalizedEnum(rawValue, field, CONTACT_LIFECYCLE_VALUES);
    case "relationship-health":
      return normalizedEnum(rawValue, field, CONTACT_HEALTH_VALUES);
    case "priority":
      return normalizedEnum(rawValue, field, CONTACT_PRIORITY_VALUES);
    case "score":
    case "health-score": {
      const value = Number(rawValue);
      if (!Number.isFinite(value))
        throw new CrmFacadeResolutionError("INVALID_NUMBER", `${field} must be a finite number`, { field });
      return value;
    }
    case "primary-account": {
      const account = getCrmAccountSummary(rawValue);
      if (!account) throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${rawValue}`);
      return account.id;
    }
    case "primary-opportunity": {
      const opportunity = getCrmOpportunity(rawValue);
      if (!opportunity)
        throw new CrmFacadeResolutionError("OPPORTUNITY_NOT_FOUND", `CRM opportunity not found: ${rawValue}`);
      return opportunity.id;
    }
    case "next-action-at": {
      const timestamp = Date.parse(rawValue);
      if (!Number.isFinite(timestamp))
        throw new CrmFacadeResolutionError("INVALID_TIMESTAMP", "next-action-at must be an ISO timestamp");
      return new Date(timestamp).toISOString();
    }
    default:
      return rawValue.trim();
  }
}

function validateOperationTransition(input: CrmFacadePlanInput, target: ResolvedTarget): void {
  if (input.operation.startsWith("task.")) {
    const status = (target.subject as CrmTask).status;
    const allowed = ["open", "scheduled", "waiting", "snoozed"];
    if (!allowed.includes(status)) {
      throw new CrmFacadeResolutionError(
        "ILLEGAL_CRM_TRANSITION",
        `CRM task cannot transition from '${status}' through ${input.operation}`,
        { currentState: status, operation: input.operation, acceptedStates: allowed },
      );
    }
  }
  if (input.operation === "fact.confirm" || input.operation === "fact.reject") {
    const status = (target.subject as CrmFact).status;
    if (status !== "proposed") {
      throw new CrmFacadeResolutionError(
        "ILLEGAL_CRM_TRANSITION",
        `CRM fact cannot transition from '${status}' through ${input.operation}`,
        { currentState: status, operation: input.operation, acceptedStates: ["proposed"] },
      );
    }
  }
}

function resolveTarget(input: CrmFacadePlanInput): ResolvedTarget {
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
      return {
        type: "contact",
        id: details.contact.id,
        label: details.contact.displayName ?? details.contact.id,
        subject: details,
      };
    }
    case "account.link-contact": {
      const account = getCrmAccountSummary(input.target);
      if (!account)
        throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${input.target}`);
      return { type: "account", id: account.id, label: account.name, subject: account };
    }
  }
}

function normalizeArguments(input: CrmFacadePlanInput, target: ResolvedTarget): Record<string, unknown> {
  const args: Record<string, unknown> = { target: input.target };
  if (input.stage !== undefined) {
    const opportunity = getCrmOpportunity(input.target);
    const stage = opportunity?.pipelineId ? getCrmPipelineStage(opportunity.pipelineId, input.stage) : null;
    if (!stage)
      throw new CrmFacadeResolutionError(
        "CRM_PIPELINE_STAGE_NOT_FOUND",
        `CRM pipeline stage not found: ${input.stage}`,
      );
    args.stage = stage.stage.id;
  }
  if (input.contact !== undefined) {
    const contact = getContactDetails(input.contact);
    if (!contact) throw new CrmFacadeResolutionError("CONTACT_NOT_FOUND", `Contact not found: ${input.contact}`);
    args.contact = contact.contact.id;
  }
  if (input.operation === "contact.set") {
    const field = required(input.field, "field").toLowerCase();
    const canonicalField = field === "health" ? "relationship-health" : field;
    args.field = canonicalField;
    args.value = normalizeContactFieldValue(canonicalField, required(input.value, "value"));
  }
  if (input.until !== undefined) args.until = new Date(Date.parse(input.until)).toISOString();
  if (input.reason !== undefined) args.reason = input.reason;
  if (input.role !== undefined) args.role = required(input.role, "role");
  if (input.account !== undefined) {
    const account = getCrmAccountSummary(input.account);
    if (!account)
      throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${input.account}`);
    args.account = account.id;
  }
  if (input.operation === "account.link-contact") {
    args.role = input.role?.trim() || "member";
    if (input.primary !== undefined) args.primary = input.primary;
  }
  if (input.operation === "opportunity.link-contact") {
    const opportunity = target.subject as CrmOpportunity;
    args.account = args.account ?? opportunity.accountId ?? null;
    args.role = input.role?.trim() || "stakeholder";
    if (input.primary !== undefined) args.primary = input.primary;
  }
  return args;
}

function validateOperationInputs(input: CrmFacadePlanInput): void {
  if (input.operation === "task.snooze") {
    const until = required(input.until, "until");
    if (!Number.isFinite(Date.parse(until)))
      throw new CrmFacadeResolutionError("INVALID_TIMESTAMP", "until must be an ISO timestamp");
  }
  if (input.operation === "opportunity.move") required(input.stage, "stage");
  if (input.operation === "contact.set") {
    const field = required(input.field, "field").toLowerCase();
    required(input.value, "value");
    if (!(CONTACT_FIELDS as readonly string[]).includes(field))
      throw new CrmFacadeResolutionError("UNSUPPORTED_CONTACT_FIELD", `Unsupported CRM contact field: ${field}`, {
        acceptedValues: CONTACT_FIELDS,
      });
  }
  if (input.operation.endsWith("link-contact")) required(input.contact, "contact");
}

export function buildCrmFacadePlan(input: CrmFacadePlanInput, now = new Date()): CrmFacadePlan {
  validateOperationInputs(input);
  const target = resolveTarget(input);
  validateOperationTransition(input, target);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const effectId = randomUUID();
  const unsigned = {
    schemaVersion: "crm.agent-first/v1" as const,
    planId: randomUUID(),
    state: "planned" as const,
    operation: input.operation,
    target: { type: target.type, id: target.id, label: target.label },
    arguments: normalizeArguments(input, target),
    effects: [{ effectId, operation: input.operation, primary: true as const, retry: "never" as const }],
    approval: null,
    createdAt,
    expiresAt,
  };
  return { ...unsigned, planHash: hashPlan(unsigned) };
}

export function persistCrmFacadePlan(plan: CrmFacadePlan): void {
  pruneExpiredUnapprovedCrmFacadePlans(new Date().toISOString());
  saveCrmFacadePlan({
    planId: plan.planId,
    planHash: plan.planHash,
    planJson: JSON.stringify(plan),
    state: plan.state,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    updatedAt: new Date().toISOString(),
    approvalJson: null,
    appliedAt: null,
  });
}

export function loadCrmFacadePlan(planId: string): CrmFacadePlan | null {
  const record = getCrmFacadePlan(planId);
  if (!record) return null;
  const plan = JSON.parse(record.planJson) as CrmFacadePlan;
  const { planHash, ...unsigned } = plan;
  if (planHash !== record.planHash || hashPlan(unsigned) !== record.planHash) {
    throw new CrmFacadeResolutionError("PLAN_INTEGRITY_ERROR", `CRM facade plan integrity check failed: ${planId}`);
  }
  return {
    ...plan,
    state: record.state as CrmFacadePlanState,
    approval: record.approvalJson ? (JSON.parse(record.approvalJson) as CrmFacadeApproval) : null,
  };
}

export function markCrmFacadePlan(planId: string, state: CrmFacadePlanState): void {
  updateCrmFacadePlanState(
    planId,
    state,
    new Date().toISOString(),
    state === "applied" ? new Date().toISOString() : undefined,
  );
}

export function recordCrmFacadeApprovalRequest(
  planId: string,
  input: Pick<CrmFacadeApproval, "source" | "externalMessageId" | "authorizedApproverId">,
  now = new Date(),
): CrmFacadePlan {
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  if (plan.state !== "planned")
    throw new CrmFacadeResolutionError("PLAN_NOT_APPROVABLE", `CRM facade plan is ${plan.state}`);
  const requestedAt = now.toISOString();
  if (Date.parse(plan.expiresAt) <= now.getTime())
    throw new CrmFacadeResolutionError("PLAN_EXPIRED", "CRM facade plan has expired");
  if (plan.approval)
    throw new CrmFacadeResolutionError("APPROVAL_ALREADY_REQUESTED", "CRM facade approval is already bound");
  const externalMessageId = required(input.externalMessageId, "externalMessageId");
  const authorizedApproverId = required(input.authorizedApproverId, "authorizedApproverId");
  const approval: CrmFacadeApproval = {
    planHash: plan.planHash,
    state: "requested",
    requestedAt,
    approvedAt: null,
    source: input.source,
    externalMessageId,
    authorizedApproverId,
    approverId: null,
  };
  if (!persistCrmFacadeApprovalRequest(planId, JSON.stringify(approval), requestedAt)) {
    throw new CrmFacadeResolutionError(
      "APPROVAL_BINDING_FAILED",
      "CRM facade approval request could not be durably bound",
    );
  }
  return loadCrmFacadePlan(planId) ?? { ...plan, approval };
}

export function approveCrmFacadePlan(
  planId: string,
  confirmation: { externalMessageId: string; approverId: string },
  now = new Date(),
): CrmFacadePlan {
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  if (plan.state !== "planned")
    throw new CrmFacadeResolutionError("PLAN_NOT_APPROVABLE", `CRM facade plan is ${plan.state}`);
  const approvedAt = now.toISOString();
  if (Date.parse(plan.expiresAt) <= now.getTime())
    throw new CrmFacadeResolutionError("PLAN_EXPIRED", "CRM facade plan has expired");
  const pending = plan.approval;
  if (!pending || pending.state !== "requested" || pending.planHash !== plan.planHash) {
    throw new CrmFacadeResolutionError("APPROVAL_REQUIRED", "A durable matching approval request is required");
  }
  const externalMessageId = required(confirmation.externalMessageId, "externalMessageId");
  const approverId = required(confirmation.approverId, "approverId");
  if (externalMessageId !== pending.externalMessageId) {
    throw new CrmFacadeResolutionError("APPROVAL_BINDING_MISMATCH", "Approval message does not match this plan");
  }
  if (approverId !== pending.authorizedApproverId) {
    throw new CrmFacadeResolutionError("APPROVER_NOT_AUTHORIZED", "Approval came from an unauthorized identity");
  }
  const approval: CrmFacadeApproval = {
    ...pending,
    state: "approved",
    approvedAt,
    approverId,
  };
  if (!recordCrmFacadeApproval(planId, JSON.stringify(pending), JSON.stringify(approval), approvedAt)) {
    throw new CrmFacadeResolutionError("APPROVAL_BINDING_FAILED", "CRM facade approval could not be finalized");
  }
  return loadCrmFacadePlan(planId) ?? { ...plan, state: "approved", approval };
}

function contactProfileKey(field: string): string {
  const keys: Record<string, string> = {
    "relationship-health": "relationshipHealth",
    health: "relationshipHealth",
    "health-score": "healthScore",
    "primary-account": "primaryAccountId",
    "primary-opportunity": "primaryOpportunityId",
    "lead-source": "leadSource",
    "buying-role": "buyingRole",
    "next-action-at": "nextActionAt",
    "next-action": "nextActionSummary",
  };
  return keys[field] ?? field;
}

function projectLink(link: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!link) return [];
  return [
    {
      ...(typeof link.accountId === "string" ? { accountId: link.accountId } : {}),
      ...(typeof link.opportunityId === "string" ? { opportunityId: link.opportunityId } : {}),
      contactId: link.contactId,
      role: link.role,
      isPrimary: link.isPrimary,
    },
  ];
}

function effectReadback(plan: CrmFacadePlan): unknown {
  switch (plan.operation) {
    case "task.done":
    case "task.cancel":
    case "task.snooze": {
      const task = getCrmTask(plan.target.id);
      return task ? { id: task.id, status: task.status, dueAt: task.dueAt, snoozedUntil: task.snoozedUntil } : null;
    }
    case "opportunity.move": {
      const opportunity = getCrmOpportunity(plan.target.id);
      return opportunity ? { id: opportunity.id, status: opportunity.status, stageId: opportunity.stageId } : null;
    }
    case "fact.confirm":
    case "fact.reject": {
      const fact = getCrmFact(plan.target.id);
      return fact ? { id: fact.id, status: fact.status } : null;
    }
    case "contact.set": {
      const profile = getCrmContactProfile(plan.target.id)?.profile;
      const key = contactProfileKey(String(plan.arguments.field));
      return profile ? { contactId: plan.target.id, profile: { [key]: profile[key as keyof typeof profile] } } : null;
    }
    case "account.link-contact": {
      const link = getCrmAccountContact(
        plan.target.id,
        String(plan.arguments.contact),
        String(plan.arguments.role ?? "member"),
      );
      return { account: { id: plan.target.id }, contacts: projectLink(link as Record<string, unknown> | null) };
    }
    case "opportunity.link-contact": {
      const link = getCrmOpportunityContact(
        plan.target.id,
        String(plan.arguments.contact),
        String(plan.arguments.role ?? "stakeholder"),
      );
      return { opportunity: { id: plan.target.id }, contacts: projectLink(link as Record<string, unknown> | null) };
    }
  }
}

function contactProfileValue(readback: unknown, field: string): unknown {
  const profile = (readback as { profile?: Record<string, unknown> } | null)?.profile;
  if (!profile) return undefined;
  return profile[contactProfileKey(field)];
}

function expectedContactProfileValue(plan: CrmFacadePlan): unknown {
  const field = String(plan.arguments.field);
  const value = plan.arguments.value;
  if (value !== null) return value;
  if (field === "lifecycle" || field === "relationship-health") return "unknown";
  if (field === "priority") return "normal";
  return null;
}

function matchesLink(
  item: Record<string, unknown>,
  expected: { targetKey: "accountId" | "opportunityId"; targetId: string; arguments: Record<string, unknown> },
): boolean {
  const checksPrimary = Object.hasOwn(expected.arguments, "primary");
  return (
    item[expected.targetKey] === expected.targetId &&
    item.contactId === expected.arguments.contact &&
    item.role === expected.arguments.role &&
    (!checksPrimary || Boolean(item.isPrimary) === expected.arguments.primary) &&
    (expected.targetKey !== "opportunityId" || (item.accountId ?? null) === (expected.arguments.account ?? null))
  );
}

function effectMatches(plan: CrmFacadePlan, readback: unknown): boolean {
  const record = readback as Record<string, unknown> | null;
  switch (plan.operation) {
    case "task.done":
      return record?.status === "done";
    case "task.cancel":
      return record?.status === "canceled";
    case "task.snooze":
      return (
        record?.status === "snoozed" &&
        (record.snoozedUntil === plan.arguments.until || record.dueAt === plan.arguments.until)
      );
    case "opportunity.move":
      return record?.stageId === plan.arguments.stage;
    case "fact.confirm":
      return record?.status === "confirmed";
    case "fact.reject":
      return record?.status === "rejected";
    case "contact.set": {
      const observed = contactProfileValue(readback, String(plan.arguments.field));
      return observed !== undefined && Object.is(observed, expectedContactProfileValue(plan));
    }
    case "account.link-contact": {
      const contacts = (record?.contacts ?? []) as Array<Record<string, unknown>>;
      return contacts.some((item) =>
        matchesLink(item, { targetKey: "accountId", targetId: plan.target.id, arguments: plan.arguments }),
      );
    }
    case "opportunity.link-contact": {
      const contacts = (record?.contacts ?? []) as Array<Record<string, unknown>>;
      return contacts.some((item) =>
        matchesLink(item, { targetKey: "opportunityId", targetId: plan.target.id, arguments: plan.arguments }),
      );
    }
  }
}

export function verifyCrmFacadePlan(planId: string): CrmFacadeVerification {
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  const readback = effectReadback(plan);
  const matches = effectMatches(plan, readback);
  const outcome = matches
    ? "applied"
    : plan.state === "planned" || plan.state === "approved"
      ? "not_applied"
      : plan.state === "applied" || plan.state === "partial"
        ? "partial"
        : "not_determined";
  return {
    planId,
    planHash: plan.planHash,
    state: plan.state,
    outcome,
    expired: Date.parse(plan.expiresAt) <= Date.now(),
    observedAt: new Date().toISOString(),
    readback,
  };
}

function applyContactField(plan: CrmFacadePlan, idempotencyKey: string, actorId: string): void {
  const field = String(plan.arguments.field ?? "");
  const value = plan.arguments.value;
  const base = { contactRef: plan.target.id, source: "crm.facade", actorType: "agent", actorId, idempotencyKey };
  switch (field) {
    case "lifecycle":
      updateCrmContactProfile({ ...base, lifecycle: value as string | null });
      return;
    case "relationship-health":
      updateCrmContactProfile({ ...base, relationshipHealth: value as string | null });
      return;
    case "priority":
      updateCrmContactProfile({ ...base, priority: value as string | null });
      return;
    case "score":
      updateCrmContactProfile({ ...base, score: value as number | null });
      return;
    case "health-score":
      updateCrmContactProfile({ ...base, healthScore: value as number | null });
      return;
    case "primary-account":
      updateCrmContactProfile({ ...base, primaryAccountId: value as string | null });
      return;
    case "primary-opportunity":
      updateCrmContactProfile({ ...base, primaryOpportunityId: value as string | null });
      return;
    case "lead-source":
      updateCrmContactProfile({ ...base, leadSource: value as string | null });
      return;
    case "persona":
      updateCrmContactProfile({ ...base, persona: value as string | null });
      return;
    case "buying-role":
      updateCrmContactProfile({ ...base, buyingRole: value as string | null });
      return;
    case "next-action-at":
      updateCrmContactProfile({ ...base, nextActionAt: value as string | null });
      return;
    case "next-action":
      updateCrmContactProfile({ ...base, nextActionSummary: value as string | null });
      return;
    default:
      throw new CrmFacadeResolutionError("UNSUPPORTED_CONTACT_FIELD", `Unsupported CRM contact field: ${field}`);
  }
}

function executeEffect(plan: CrmFacadePlan, idempotencyKey: string, actorId: string): void {
  const args = plan.arguments;
  const source = "crm.facade";
  const actorType = "agent";
  switch (plan.operation) {
    case "task.done":
      completeCrmTask({ taskId: plan.target.id, source, actorType, actorId, idempotencyKey });
      return;
    case "task.cancel":
      cancelCrmTask({
        taskId: plan.target.id,
        reason: args.reason as string | undefined,
        source,
        actorType,
        actorId,
        idempotencyKey,
      });
      return;
    case "task.snooze":
      snoozeCrmTask({
        taskId: plan.target.id,
        snoozedUntil: String(args.until),
        source,
        actorType,
        actorId,
        idempotencyKey,
      });
      return;
    case "opportunity.move":
      moveCrmOpportunityStage({
        opportunityId: plan.target.id,
        stageRef: String(args.stage),
        source,
        actorType,
        actorId,
        idempotencyKey,
      });
      return;
    case "fact.confirm":
      confirmCrmFact({ factId: plan.target.id, source, actorType, actorId, idempotencyKey });
      return;
    case "fact.reject":
      rejectCrmFact({ factId: plan.target.id, source, actorType, actorId, idempotencyKey });
      return;
    case "contact.set":
      applyContactField(plan, idempotencyKey, actorId);
      return;
    case "account.link-contact":
      linkCrmAccountContact({
        accountId: plan.target.id,
        contactRef: String(args.contact),
        role: args.role as string | undefined,
        isPrimary: args.primary as boolean | undefined,
        source,
        actorType,
        actorId,
        idempotencyKey,
      });
      return;
    case "opportunity.link-contact":
      linkCrmOpportunityContact({
        opportunityId: plan.target.id,
        contactRef: String(args.contact),
        accountId: args.account as string | undefined,
        role: args.role as string | undefined,
        isPrimary: args.primary as boolean | undefined,
        source,
        actorType,
        actorId,
        idempotencyKey,
      });
      return;
  }
}

function assertCurrentPlanPreconditions(plan: CrmFacadePlan): void {
  let currentTarget: ResolvedTarget;
  switch (plan.target.type) {
    case "task": {
      const task = getCrmTask(plan.target.id);
      if (!task) throw new CrmFacadeResolutionError("CRM_TASK_NOT_FOUND", `CRM task not found: ${plan.target.id}`);
      currentTarget = { ...plan.target, subject: task };
      break;
    }
    case "fact": {
      const fact = getCrmFact(plan.target.id);
      if (!fact) throw new CrmFacadeResolutionError("CRM_FACT_NOT_FOUND", `CRM fact not found: ${plan.target.id}`);
      currentTarget = { ...plan.target, subject: fact };
      break;
    }
    case "opportunity": {
      const opportunity = getCrmOpportunity(plan.target.id);
      if (!opportunity)
        throw new CrmFacadeResolutionError("OPPORTUNITY_NOT_FOUND", `CRM opportunity not found: ${plan.target.id}`);
      currentTarget = { ...plan.target, subject: opportunity };
      if (plan.operation === "opportunity.move") {
        const stage = opportunity.pipelineId
          ? getCrmPipelineStage(opportunity.pipelineId, String(plan.arguments.stage))
          : null;
        if (!stage || stage.stage.status !== "active") {
          throw new CrmFacadeResolutionError(
            "PLAN_PRECONDITION_CHANGED",
            "The planned CRM pipeline stage is no longer active for this opportunity",
          );
        }
      }
      break;
    }
    case "contact": {
      const details = getContactDetails(plan.target.id);
      if (!details) throw new CrmFacadeResolutionError("CONTACT_NOT_FOUND", `Contact not found: ${plan.target.id}`);
      currentTarget = { ...plan.target, subject: details };
      break;
    }
    case "account": {
      const account = getCrmAccountSummary(plan.target.id);
      if (!account)
        throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${plan.target.id}`);
      currentTarget = { ...plan.target, subject: account };
      break;
    }
    default:
      throw new CrmFacadeResolutionError("PLAN_PRECONDITION_CHANGED", "The planned CRM target type is unsupported");
  }

  validateOperationTransition({ operation: plan.operation, target: plan.target.id }, currentTarget);

  if (typeof plan.arguments.contact === "string" && !getContactDetails(plan.arguments.contact)) {
    throw new CrmFacadeResolutionError("CONTACT_NOT_FOUND", `Contact not found: ${plan.arguments.contact}`);
  }
  if (typeof plan.arguments.account === "string" && !getCrmAccountSummary(plan.arguments.account)) {
    throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${plan.arguments.account}`);
  }
  if (plan.operation === "contact.set" && plan.arguments.value !== null) {
    if (plan.arguments.field === "primary-account" && !getCrmAccountSummary(String(plan.arguments.value))) {
      throw new CrmFacadeResolutionError("CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${plan.arguments.value}`);
    }
    if (plan.arguments.field === "primary-opportunity" && !getCrmOpportunity(String(plan.arguments.value))) {
      throw new CrmFacadeResolutionError("OPPORTUNITY_NOT_FOUND", `CRM opportunity not found: ${plan.arguments.value}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidenceJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    return JSON.stringify({ serializationError: errorMessage(error) }) ?? "null";
  }
}

function finishCrmFacadeApply(
  planId: string,
  effectId: string,
  state: "applied" | "partial" | "unknown",
  readback: unknown,
): void {
  const effectState = state === "applied" ? "observed" : state === "partial" ? "mismatched" : "unknown";
  try {
    updateCrmFacadeEffect(effectId, {
      state: effectState,
      observedAt: new Date().toISOString(),
      readbackJson: evidenceJson(readback),
    });
  } finally {
    markCrmFacadePlan(planId, state);
  }
}

export function applyCrmFacadePlan(planId: string, context: CrmFacadeExecutionContext): CrmFacadeApplyResult {
  const actorId = context.actorId?.trim();
  if (!actorId) throw new CrmFacadeResolutionError("ACTOR_CONTEXT_REQUIRED", "CRM facade apply requires an actor id");
  const plan = loadCrmFacadePlan(planId);
  if (!plan) throw new CrmFacadeResolutionError("PLAN_NOT_FOUND", `CRM facade plan not found: ${planId}`);
  if (plan.state === "planned")
    throw new CrmFacadeResolutionError("APPROVAL_REQUIRED", "A matching external approval is required");
  if (plan.state !== "approved")
    throw new CrmFacadeResolutionError("PLAN_NOT_APPLICABLE", `CRM facade plan is ${plan.state} and cannot be applied`);
  if (
    !plan.approval ||
    plan.approval.state !== "approved" ||
    plan.approval.planHash !== plan.planHash ||
    !plan.approval.approverId ||
    plan.approval.approverId !== plan.approval.authorizedApproverId ||
    !plan.approval.externalMessageId
  )
    throw new CrmFacadeResolutionError("APPROVAL_REQUIRED", "A matching external approval is required");
  assertCurrentPlanPreconditions(plan);
  const now = new Date().toISOString();
  if (!claimCrmFacadePlanApply(planId, now))
    throw new CrmFacadeResolutionError("PLAN_NOT_APPLICABLE", "Plan was consumed, expired, or is not approved");
  const effect = plan.effects[0];
  try {
    saveCrmFacadeEffect({
      effectId: effect.effectId,
      planId,
      operation: effect.operation,
      state: "dispatched",
      idempotencyKey: effect.effectId,
      dispatchedAt: now,
    });
  } catch (error) {
    markCrmFacadePlan(planId, "unknown");
    return {
      planId,
      planHash: plan.planHash,
      state: "unknown",
      effectId: effect.effectId,
      reason: `Effect journal failed after claim: ${errorMessage(error)}`,
    };
  }

  let executionError: unknown;
  try {
    executeEffect(plan, effect.effectId, actorId);
  } catch (error) {
    executionError = error;
  }

  let readback: unknown;
  try {
    readback = effectReadback(plan);
    if (effectMatches(plan, readback)) {
      finishCrmFacadeApply(planId, effect.effectId, "applied", readback);
      return { planId, planHash: plan.planHash, state: "applied", effectId: effect.effectId, readback };
    }
  } catch (error) {
    const reason = `Independent readback failed: ${errorMessage(error)}`;
    finishCrmFacadeApply(planId, effect.effectId, "unknown", { error: reason });
    return {
      planId,
      planHash: plan.planHash,
      state: "unknown",
      effectId: effect.effectId,
      reason: executionError ? `${errorMessage(executionError)}; ${reason}` : reason,
    };
  }

  if (executionError) {
    const reason = `Effect result is ambiguous after execution error: ${errorMessage(executionError)}`;
    finishCrmFacadeApply(planId, effect.effectId, "unknown", readback);
    return { planId, planHash: plan.planHash, state: "unknown", effectId: effect.effectId, readback, reason };
  }

  const reason = "Independent readback does not satisfy the planned effect";
  finishCrmFacadeApply(planId, effect.effectId, "partial", readback);
  return { planId, planHash: plan.planHash, state: "partial", effectId: effect.effectId, readback, reason };
}
