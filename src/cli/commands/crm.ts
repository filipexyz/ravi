import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";
import { fail } from "../context.js";
import { contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  changedEntityReturnSchema,
  crmBoardReturnSchema,
  crmOpportunityContactsReturnSchema,
  crmOpportunityReturnSchema,
  crmPipelineDetailsReturnSchema,
  crmPipelineHitlCheckReturnSchema,
  crmPipelineReviewReturnSchema,
  crmPipelineSendWindowCheckReturnSchema,
  crmPipelineStageDetailsReturnSchema,
  crmPipelineValidationReturnSchema,
  crmProfileReturnSchema,
  crmFacadePlanReturnSchema,
  crmFacadeApplyReturnSchema,
  crmFacadeRecoveryReturnSchema,
  crmFacadeVerificationReturnSchema,
  crmLifecycleReturnSchema,
  crmHelpReturnSchema,
  crmTaskReturnSchema,
  pagedItemsReturnSchema,
} from "./operational-return-schemas.js";
import {
  getPipelineMetadataJsonSchema,
  type PipelineMetadata,
  type PipelineReviewFieldStatus,
  type PipelineValidationIssue,
  reviewPipelineMetadata,
  validatePipelineMetadata,
} from "../../crm/pipeline-metadata.js";
import { evaluateHitlRequiredWhen, evaluateSendWindow } from "../../crm/pipeline-engines.js";
import {
  archiveCrmPipelineStage,
  archiveCrmPipelineStageTopic,
  cancelCrmTask,
  completeCrmTask,
  confirmCrmFact,
  createCrmAccount,
  createCrmOpportunity,
  createCrmPipeline,
  createCrmPipelineStage,
  createCrmPipelineStageTopic,
  createCrmTask,
  getCrmAccount,
  getAllContactAccessRecords,
  getContactDetails,
  getCrmFact,
  getCrmContactProfile,
  getCrmOpportunity,
  getCrmPipeline,
  getCrmPipelineStage,
  getCrmTask,
  linkCrmAccountContact,
  linkCrmOpportunityContact,
  listCrmContactCards,
  listCrmFacts,
  listCrmNextActions,
  listCrmOpportunityBoard,
  listCrmOpportunityBoardStages,
  listCrmOpportunityContacts,
  listCrmPipelineStageTopics,
  listCrmPipelineStages,
  listCrmPipelines,
  listCrmTasks,
  moveCrmOpportunityStage,
  proposeCrmFact,
  rejectCrmFact,
  snoozeCrmTask,
  updateCrmPipeline,
  updateCrmPipelineStage,
  updateCrmPipelineStageTopic,
  updateCrmContactProfile,
  type CrmTask,
  type CrmOwnerType,
} from "../../contacts.js";
import { dbListRoutes } from "../../router/router-db.js";
import { canAccessContact, getScopeContext, isScopeEnforced } from "../../permissions/scope.js";
import {
  buildCrmFacadePlan,
  persistCrmFacadePlan,
  loadCrmFacadePlan,
  approveCrmFacadePlan,
  applyCrmFacadePlan,
  CRM_FACADE_OPERATIONS,
  CrmFacadeResolutionError,
  type CrmFacadeOperation,
} from "../../crm/facade.js";
import { requestCascadingApproval } from "../../approval/service.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
// ============================================================

function failPipelineNotFound(op: string, pipelineRef: string, asJson?: boolean): never {
  const candidates = listCrmPipelines({ includeArchived: true }).flatMap((pipeline) => [pipeline.id, pipeline.name]);
  contractFail(op, "PIPELINE_NOT_FOUND", `CRM pipeline not found: ${pipelineRef}`, {
    asJson,
    details: {
      suggestedAction: "Check the pipeline id/name (see suggestions for similar pipelines)",
      suggestions: suggestSimilar(pipelineRef, candidates),
    },
  });
}

function failOpportunityNotFound(op: string, opportunityId: string, asJson?: boolean): never {
  const candidates = listCrmOpportunityBoard({}).flatMap((opportunity) => [
    String(opportunity.opportunityId ?? ""),
    String(opportunity.title ?? ""),
  ]);
  contractFail(op, "OPPORTUNITY_NOT_FOUND", `CRM opportunity not found: ${opportunityId}`, {
    asJson,
    details: {
      suggestedAction: "Check the opportunity id (crm_opp_*) or title (see suggestions)",
      suggestions: suggestSimilar(opportunityId, candidates),
    },
  });
}

function failCrmContactNotFound(op: string, contactRef: string, asJson?: boolean): never {
  contractFail(op, "CONTACT_NOT_FOUND", `Contact not found: ${contactRef}`, {
    asJson,
    details: {
      suggestedAction: "Check the contact id or identity with: ravi crm contacts --json",
    },
  });
}

function failCrmTaskNotFound(op: string, taskId: string, asJson?: boolean): never {
  contractFail(op, "CRM_TASK_NOT_FOUND", `CRM task not found: ${taskId}`, {
    asJson,
    details: {
      suggestedAction: "Check the CRM task id with: ravi crm task list --json",
    },
  });
}

// ============================================================
// Structured-flag helpers for `crm pipeline create / set` (V2+ hybrid).
// Maps user-facing flags onto pipeline.metadata canonical schema fields.
// See: src/crm/pipeline-metadata.ts and .ravi/specs/crm/pipeline/SPEC.md
// ============================================================

interface StructuredPipelineMetadataFlags {
  objetivo?: string;
  priorityGlobal?: string;
  producers?: string;
  consumers?: string;
  readingListId?: string;
  versao?: string;
  vipGuardTags?: string;
  vipGuardLtv?: string;
  vipGuardAction?: string;
  sendWindow?: string;
  hitlRequiredWhen?: string;
  messagePrefix?: string;
  messageSuffix?: string;
  analystTone?: string;
  analystMentions?: string;
  analystAvoid?: string;
  reguaTags?: string[];
  relatedCrons?: string;
  relatedTriggers?: string;
}

function splitCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cloneObjectField(base: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = base[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function parseSendWindowFlag(flag: string): { hours: string; days?: string; timezone: string } {
  // Format: "9-21,mon-sat,America/Sao_Paulo" or "9-21,America/Sao_Paulo" (no days).
  const parts = flag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) fail("--send-window must be 'hours[,days],timezone' (e.g. 9-21,mon-sat,America/Sao_Paulo)");
  if (parts.length === 2) return { hours: parts[0], timezone: parts[1] };
  return { hours: parts[0], days: parts[1], timezone: parts[2] };
}

function buildMetadataFromStructuredFlags(
  base: Record<string, unknown>,
  flags: StructuredPipelineMetadataFlags,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...base };

  if (flags.objetivo !== undefined) meta.objetivo = flags.objetivo;
  if (flags.priorityGlobal !== undefined) {
    const n = Number(flags.priorityGlobal);
    if (!Number.isInteger(n) || n < 1 || n > 5) fail("--priority-global must be 1..5");
    meta.priority_global = n;
  }
  const producers = splitCommaList(flags.producers);
  if (producers) meta.producers = producers;
  const consumers = splitCommaList(flags.consumers);
  if (consumers) meta.consumers = consumers;
  if (flags.readingListId !== undefined) meta.reading_list_id = flags.readingListId;
  if (flags.versao !== undefined) meta.versao = flags.versao;

  if (flags.vipGuardTags !== undefined || flags.vipGuardLtv !== undefined || flags.vipGuardAction !== undefined) {
    const vip = cloneObjectField(meta, "vip_guard");
    const tagTriggers = splitCommaList(flags.vipGuardTags);
    if (tagTriggers) vip.tag_triggers = tagTriggers;
    if (flags.vipGuardLtv !== undefined) {
      const n = Number(flags.vipGuardLtv);
      if (!Number.isFinite(n) || n < 0) fail("--vip-guard-ltv must be a non-negative number");
      vip.ltv_threshold = n;
    }
    if (flags.vipGuardAction !== undefined) {
      const allowed = new Set(["hitl", "block", "tag_only"]);
      if (!allowed.has(flags.vipGuardAction)) fail("--vip-guard-action must be hitl|block|tag_only");
      vip.action = flags.vipGuardAction;
    }
    meta.vip_guard = vip;
  }

  if (flags.sendWindow !== undefined) {
    meta.send_window = parseSendWindowFlag(flags.sendWindow);
  }
  if (flags.hitlRequiredWhen !== undefined) {
    const parsed = parseJsonObjectArg(flags.hitlRequiredWhen);
    meta.hitl_required_when = parsed ?? {};
  }

  if (flags.messagePrefix !== undefined || flags.messageSuffix !== undefined) {
    const mr = cloneObjectField(meta, "message_rule");
    if (flags.messagePrefix !== undefined) mr.prefix = flags.messagePrefix;
    if (flags.messageSuffix !== undefined) mr.suffix = flags.messageSuffix;
    meta.message_rule = mr;
  }

  if (flags.analystTone !== undefined || flags.analystMentions !== undefined || flags.analystAvoid !== undefined) {
    const ag = cloneObjectField(meta, "analyst_guidance");
    if (flags.analystTone !== undefined) ag.tone = flags.analystTone;
    const mentions = splitCommaList(flags.analystMentions);
    if (mentions) ag.mandatory_mentions = mentions;
    const avoid = splitCommaList(flags.analystAvoid);
    if (avoid) ag.avoid = avoid;
    meta.analyst_guidance = ag;
  }

  if (flags.reguaTags && flags.reguaTags.length > 0) {
    const existing = Array.isArray(meta.regua_tags) ? meta.regua_tags : [];
    const additions = flags.reguaTags.map((raw, i) => {
      const parsed = parseJsonObjectArg(raw);
      if (!parsed) fail(`--regua-tag #${i + 1} must be a non-null JSON object`);
      return parsed;
    });
    meta.regua_tags = [...existing, ...additions];
  }

  const crons = splitCommaList(flags.relatedCrons);
  if (crons) meta.related_crons = crons;
  const triggers = splitCommaList(flags.relatedTriggers);
  if (triggers) meta.related_triggers = triggers;

  return meta;
}

function assertValidPipelineMetadata(metadata: Record<string, unknown>, context: string): void {
  const validation = validatePipelineMetadata(metadata);
  if (validation.ok) return;
  const details = validation.errors.map((error) => `${error.path || "<root>"}: ${error.message}`).join("; ");
  fail(`${context} produced invalid pipeline.metadata: ${details}`);
}

const PIPELINE_CREATE_HELP_AFTER = `
The structured flags below map onto pipeline.metadata canonical schema fields.
All groups optional — pipelines without these fields keep working identically
to legacy. Validate via: ravi crm pipeline validate <id>

IDENTIDADE
  --objetivo <text>           One-paragraph statement of the pipeline purpose
  --priority-global <1-5>     Cross-pipeline arbitration priority (1=highest)
  --producer <ids>            Comma list of agents that CREATE opportunities here
  --consumer <ids>            Comma list of agents that READ/act on opportunities
  --reading-list-id <slug>    Reading list slug bound to this pipeline
  --versao <semver>           Metadata document version (for change tracking)

POLITICAS
  --send-window 'H,D,TZ'      Allowed send window. Examples:
                                '9-21,mon-sat,America/Sao_Paulo'
                                '9-21,UTC' (omitting days = every day)
  --vip-guard-tag <tags>      Comma list of tags marking contact as VIP
  --vip-guard-ltv <n>         Lifetime value threshold above which contact is VIP
  --vip-guard-action <act>    hitl | block | tag_only (default: hitl)
  --hitl-required-when <json> JSON object {conditions:[...]} — declarative HITL rules

COMUNICACAO
  --message-prefix <text>     String prepended to every outbound message
  --message-suffix <text>     String appended to every outbound message
  --analyst-tone <text>       Tone description for analyst agents drafting messages
  --analyst-mentions <list>   Comma list of strings ALWAYS to include
  --analyst-avoid <list>      Comma list of strings NEVER to include

TAGS
  --regua-tag '<json>'        Repeatable. JSON object: {tag,apply_when,linked_stage,apply_by}

INTEGRACOES
  --related-cron <ids>        Comma list of CRON ids that drive this pipeline
  --related-trigger <ids>     Comma list of trigger ids that drive this pipeline

ESCAPE HATCH
  --metadata <json>           Raw metadata JSON object. Structured flags merge
                              on top (structured flags WIN per field).

INSPECT
  ravi crm pipeline review <id>            12-field structured report (✓/⚠/✗)
  ravi crm pipeline validate <id>          PASS/FAIL against canonical schema
  ravi crm pipeline show <id> --explain    Metadata field-by-field with impact

EXAMPLES

  # 1) Simple pipeline ('leads-prospect') — minimum useful metadata
  ravi crm pipeline create leads-prospect \\
    --objetivo 'Qualify anonymous lead until first qualified conversation' \\
    --priority-global 5 \\
    --producer lead-capture \\
    --consumer salesrep \\
    --versao 1.0.0

  # 2) Rich pipeline ('subscription-renewal') — lifecycle + policies + regua tags
  ravi crm pipeline create subscription-renewal \\
    --objetivo 'Secure recurring subscription renewal before expiry' \\
    --priority-global 2 \\
    --producer billing \\
    --consumer salesrep,dispatcher \\
    --send-window '9-19,mon-fri,America/New_York' \\
    --vip-guard-tag perfil:vip,plan:enterprise \\
    --vip-guard-ltv 50000 \\
    --vip-guard-action hitl \\
    --message-prefix '[Subscription Renewal]' \\
    --analyst-tone 'cordial, concise, no emojis' \\
    --analyst-mentions 'renewal date,plan benefits' \\
    --analyst-avoid 'discount,urgency' \\
    --regua-tag '{"tag":"renewal:30d-out","apply_when":{"days_until_renewal":30},"linked_stage":"1-aviso-cedo","apply_by":"cron-renewal-sync"}' \\
    --regua-tag '{"tag":"renewal:7d-out","apply_when":{"days_until_renewal":7},"linked_stage":"2-aviso-urgente","apply_by":"cron-renewal-sync"}' \\
    --related-cron cron-renewal-sync,cron-renewal-followup \\
    --versao 1.0.0
`;

const PIPELINE_SET_HELP_AFTER = `
Two modes:

  1) Single-field mode (legacy, unchanged)
       ravi crm pipeline set <pipeline> <field> <value>
       Where <field> = name | entity-type | default | status | metadata
       (metadata replaces the whole JSON blob)

  2) Structured-flags mode (new — incremental metadata patching)
       ravi crm pipeline set <pipeline> metadata - --objetivo '...' --priority-global 2 ...
       Pass '-' as <value> to indicate "ignore positional, use flags".
       Each flag set updates ONLY that field in pipeline.metadata; other
       fields are preserved. Unknown keys in existing metadata are kept
       (passthrough). See \`ravi crm pipeline create --help\` for the full
       flag list.

EXAMPLES

  # Patch only the send window
  ravi crm pipeline set leads-prospect metadata - --send-window '9-19,mon-fri,America/New_York'

  # Bump priority + add new regua tag (keeps existing ones)
  ravi crm pipeline set subscription-renewal metadata - \\
    --priority-global 1 \\
    --regua-tag '{"tag":"renewal:1d-out","apply_when":{"days_until_renewal":1},"linked_stage":"3-vencendo","apply_by":"cron-renewal-sync"}'
`;

function formatCrmTaskForJson<T extends Partial<CrmTask>>(task: T): T & Record<string, unknown> {
  return {
    ...task,
    contact_id: task.contactId,
    account_id: task.accountId,
    opportunity_id: task.opportunityId,
    chat_id: task.chatId,
    session_key: task.sessionKey,
    task_type: task.taskType,
    due_at: task.dueAt,
    due_date: task.dueAt,
    snoozed_until: task.snoozedUntil,
    completed_at: task.completedAt,
    canceled_at: task.canceledAt,
    owner_type: task.ownerType,
    owner_id: task.ownerId,
    created_by_type: task.createdByType,
    created_by_id: task.createdById,
    idempotency_key: task.idempotencyKey,
    ravi_task_id: task.raviTaskId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function parseOwner(owner?: string): { ownerType?: CrmOwnerType; ownerId?: string } {
  const raw = owner?.trim();
  if (!raw) return {};
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("--owner must use <type:id>, e.g. agent:main or team:sales");
  }
  const ownerType = raw.slice(0, separator) as CrmOwnerType;
  const ownerId = raw.slice(separator + 1);
  return { ownerType, ownerId };
}

function parseOptionalNumber(value: string | undefined, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "-" || value === "null") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a number`);
  return parsed;
}

function parseRequiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a number`);
  return parsed;
}

const CRM_CONTACT_LIFECYCLE_VALUES = [
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
const CRM_TASK_STATUS_VALUES = ["open", "scheduled", "waiting", "done", "canceled", "snoozed"] as const;
const CRM_FACT_STATUS_VALUES = ["proposed", "confirmed", "rejected", "superseded"] as const;
const CRM_ENTITY_TYPE_VALUES = [
  "contact",
  "account",
  "opportunity",
  "task",
  "activity",
  "segment",
  "playbook",
  "pipeline",
  "pipeline_stage",
  "pipeline_stage_topic",
] as const;

function validateEnumOption(
  op: string,
  flag: string,
  value: string | undefined,
  accepted: readonly string[],
  asJson?: boolean,
): string | undefined {
  if (value === undefined || accepted.includes(value)) return value;
  contractFail(op, "USAGE_ERROR", `${flag} has an invalid value: ${value}`, {
    asJson,
    exitCode: 2,
    details: {
      parameter: flag,
      received: value,
      acceptedValues: [...accepted],
      suggestedAction: `Use one of the accepted values for ${flag}`,
    },
  });
}

function assertCrmTaskMutationTarget(op: string, taskId: string, asJson?: boolean): void {
  const task = getCrmTask(taskId);
  if (!task || (task.contactId && !canReadCrmContact(task.contactId))) {
    failCrmTaskNotFound(op, taskId, asJson);
  }
}

function assertCrmOpportunityMutationTarget(op: string, opportunityId: string, asJson?: boolean): void {
  const opportunity = getCrmOpportunity(opportunityId);
  if (!opportunity) failOpportunityNotFound(op, opportunityId, asJson);
  if (opportunity.primaryContactId && !canReadCrmContact(opportunity.primaryContactId)) {
    failOpportunityNotFound(op, opportunityId, asJson);
  }
}

function assertCrmFactMutationTarget(op: string, factId: string, asJson?: boolean): void {
  const fact = getCrmFact(factId);
  if (!fact) {
    contractFail(op, "CRM_FACT_NOT_FOUND", `CRM fact not found: ${factId}`, {
      asJson,
      details: {
        suggestedAction: "Check the CRM fact id with: ravi crm fact list --json",
      },
    });
  }
  if (fact.contactId && !canReadCrmContact(fact.contactId)) {
    contractFail(op, "CRM_FACT_NOT_FOUND", `CRM fact not found: ${factId}`, {
      asJson,
      details: {
        suggestedAction: "Check the CRM fact id with: ravi crm fact list --json",
      },
    });
  }
}

function validateNonNegativeInteger(
  op: string,
  flag: string,
  value: string | undefined,
  asJson?: boolean,
): string | undefined {
  if (value === undefined || /^\d+$/.test(value)) return value;
  contractFail(op, "USAGE_ERROR", `${flag} must be a non-negative integer`, {
    asJson,
    exitCode: 2,
    details: {
      parameter: flag,
      received: value,
      suggestedAction: `Use a non-negative integer for ${flag}`,
    },
  });
}

function redactPipelineValidationIssues(issues: PipelineValidationIssue[]): PipelineValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    // Preserve the actionable schema path while removing quoted user data.
    message: issue.message.replace(/"[^\"]*"|'[^']*'/g, '"[redacted]"'),
  }));
}

function validateTimestamp(
  op: string,
  flag: string,
  value: string | undefined,
  asJson?: boolean,
): string | undefined {
  if (value === undefined || !Number.isNaN(Date.parse(value))) return value;
  contractFail(op, "USAGE_ERROR", `${flag} must be a valid date/time`, {
    asJson,
    exitCode: 2,
    details: {
      parameter: flag,
      received: value,
      suggestedAction: `Use an ISO date/time for ${flag}`,
    },
  });
}

function parseBooleanValue(value: string, label: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não", "off"].includes(normalized)) return false;
  fail(`${label} must be true/false`);
}

function parseJsonObjectArg(value: string): Record<string, unknown> | null {
  if (value === "-" || value === "null") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) fail("metadata must be a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonValueArg(value: string): unknown {
  if (value === "-" || value === "null") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseNullable(value: string): string | null {
  return value === "-" || value === "null" ? null : value;
}

function renderNextAction(action: {
  taskId: string;
  priority: string;
  dueAt: string | null;
  title: string;
  contactId?: string | null;
  contactName: string | null;
  accountName: string | null;
}) {
  const target = action.contactName ?? action.accountName ?? "-";
  console.log(`- ${action.priority.padEnd(7)} ${action.dueAt ?? "-"} ${action.taskId} ${target}: ${action.title}`);
}

let cachedRoutes: ReturnType<typeof dbListRoutes> | null = null;

function routeAgentForIdentityValues(identityValues: string[]): string | null {
  if (!cachedRoutes) cachedRoutes = dbListRoutes();
  for (const identityValue of identityValues) {
    const value = identityValue.toLowerCase();
    const match = cachedRoutes.find((route) => route.pattern === value);
    if (match) return match.agent;
  }
  return null;
}

function routeAgentForCrmContact(contactRef: string): string | null {
  const details = getContactDetails(contactRef);
  if (!details) return null;
  return routeAgentForIdentityValues(details.platformIdentities.map((identity) => identity.normalizedPlatformUserId));
}

function canReadCrmContact(contactRef: string): boolean {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return true;
  const details = getContactDetails(contactRef);
  if (!details) return false;
  const contactAgent = routeAgentForCrmContact(details.contact.id);
  const contactSessions = contactAgent ? [{ agentId: contactAgent }] : [];
  return canAccessContact(
    scopeCtx,
    { id: details.contact.id, tags: details.policy?.tags ?? [] },
    null,
    contactSessions,
  );
}

function assertCanReadCrmContact(op: string, contactRef: string, asJson?: boolean): void {
  if (canReadCrmContact(contactRef)) return;
  failCrmContactNotFound(op, contactRef, asJson);
}

function canReadCrmContactRecord(
  scopeCtx: ReturnType<typeof getScopeContext>,
  contact: { id: string; tags: string[]; identityValues: string[] },
): boolean {
  const contactAgent = routeAgentForIdentityValues(contact.identityValues);
  const contactSessions = contactAgent ? [{ agentId: contactAgent }] : [];
  return canAccessContact(scopeCtx, contact, null, contactSessions);
}

function listReadableCrmContactIds(): string[] | undefined {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return undefined;
  return getAllContactAccessRecords()
    .filter((contact) => canReadCrmContactRecord(scopeCtx, contact))
    .map((contact) => contact.id);
}

function contactIdsFromCrmRecord(record: object): string[] {
  const data = record as Record<string, unknown>;
  const ids = new Set<string>();
  const direct = data.contactId ?? data.contact_id;
  if (typeof direct === "string" && direct.length > 0) ids.add(direct);
  if (data.entityType === "contact" && typeof data.entityId === "string" && data.entityId.length > 0) {
    ids.add(data.entityId);
  }
  if (data.entity_type === "contact" && typeof data.entity_id === "string" && data.entity_id.length > 0) {
    ids.add(data.entity_id);
  }
  const nestedContact = data.contact;
  if (
    nestedContact &&
    typeof nestedContact === "object" &&
    "id" in nestedContact &&
    typeof nestedContact.id === "string" &&
    nestedContact.id.length > 0
  ) {
    ids.add(nestedContact.id);
  }
  return [...ids];
}

function filterCrmRecordsByContact<T extends object>(records: T[]): T[] {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return records;
  return records.filter((record) => {
    const contactIds = contactIdsFromCrmRecord(record);
    if (contactIds.length === 0) return true;
    return contactIds.some((contactId) => canReadCrmContact(contactId));
  });
}

function showCrmContactProfile(contactRef: string, asJson?: boolean) {
  const op = "crm contact show";
  assertCanReadCrmContact(op, contactRef, asJson);
  const profile = getCrmContactProfile(contactRef);
  if (!profile) failCrmContactNotFound(op, contactRef, asJson);
  const payload = { target: contactRef, crm: profile };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  renderCrmContactCard(profile);
  return payload;
}

// ============================================================================
// Rich contact card renderer (text mode)
// ============================================================================

const CARD_WIDTH = 80;
const FACT_VALUE_PREVIEW = 200;

function renderCrmContactCard(profile: NonNullable<ReturnType<typeof getCrmContactProfile>>): void {
  const { contact, policy, profile: prof, accountMemberships, opportunities, tasks, nextActions, facts } = profile;
  const name = contact.displayName?.trim() || contact.id;

  console.log("");
  console.log(name);
  console.log(divider("─"));
  printPair("id", contact.id, "kind", contact.kind);
  printPair("phone", contact.primaryPhone ?? "-", "email", contact.primaryEmail ?? "-");
  printPair("added", formatDate(contact.createdAt), "updated", formatDate(contact.updatedAt));

  console.log("");
  console.log("Status");
  printPair(
    "lifecycle",
    prof?.lifecycle ?? "unknown",
    "health",
    prof?.relationshipHealth ?? "unknown",
    "priority",
    prof?.priority ?? "normal",
  );
  printPair(
    "policy",
    policy?.status ?? "unknown",
    "reply",
    policy?.replyMode ?? "auto",
    "opt-out",
    formatBool(policy?.optOut),
  );
  const owner = formatOwner(prof?.ownerType, prof?.ownerId);
  printPair("owner", owner, "source", policy?.source ?? "-");
  const allowed = policy?.allowedAgents?.length ? policy.allowedAgents.join(", ") : "(all)";
  printPair("allowed agents", allowed);
  if (prof?.nextActionSummary || prof?.nextActionAt) {
    const due = prof.nextActionAt ? formatDate(prof.nextActionAt) : "-";
    printPair("next at", due);
    printBlockValue("next", prof.nextActionSummary ?? "-");
  }

  console.log("");
  console.log("Interactions");
  printPair(
    "count",
    String(policy?.interactionCount ?? 0),
    "last in",
    formatRelative(policy?.lastInboundAt),
    "last out",
    formatRelative(policy?.lastOutboundAt),
  );
  if (prof?.lastMeaningfulInteractionAt) {
    printPair("last meaningful", formatRelative(prof.lastMeaningfulInteractionAt));
  }

  const tags = policy?.tags ?? [];
  console.log("");
  console.log(`Tags (${tags.length})`);
  console.log(`  ${tags.length === 0 ? "(none)" : tags.join(", ")}`);

  const notes = policy?.notes && typeof policy.notes === "object" ? (policy.notes as Record<string, unknown>) : {};
  const noteKeys = Object.keys(notes);
  if (noteKeys.length > 0) {
    console.log("");
    console.log(`Notes (${noteKeys.length})`);
    for (const k of noteKeys.slice(0, 10)) {
      printBlockValue(k, formatNoteValue(notes[k]));
    }
    if (noteKeys.length > 10) {
      console.log(`  … ${noteKeys.length - 10} more (--json for all)`);
    }
  }

  const confirmedFacts = facts.filter((f) => f.status === "confirmed");
  const proposedFacts = facts.filter((f) => f.status === "proposed");
  if (confirmedFacts.length > 0 || proposedFacts.length > 0) {
    console.log("");
    const summary = [
      confirmedFacts.length ? `${confirmedFacts.length} confirmed` : null,
      proposedFacts.length ? `${proposedFacts.length} proposed` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`Facts (${summary})`);
    for (const fact of confirmedFacts) printFact(fact);
    if (proposedFacts.length > 0) {
      console.log("");
      console.log("  Proposed");
      for (const fact of proposedFacts) printFact(fact);
    }
  }

  if (accountMemberships.length > 0) {
    console.log("");
    console.log(`Accounts (${accountMemberships.length})`);
    for (const m of accountMemberships) {
      const accName = m.account?.name ?? "(no name)";
      const role = m.role ? ` · role ${m.role}` : "";
      const primary = m.isPrimary ? " · primary" : "";
      console.log(`  · ${accName} (${m.accountId})${role}${primary}`);
    }
  }

  if (opportunities.length > 0) {
    console.log("");
    console.log(`Opportunities (${opportunities.length})`);
    for (const o of opportunities) {
      const value = o.valueCents != null ? formatMoney(o.valueCents, o.currency) : "-";
      console.log(`  · ${o.title} · ${o.status} · ${o.priority} · value ${value}`);
    }
  }

  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "canceled");
  if (openTasks.length > 0) {
    console.log("");
    console.log(`Open tasks (${openTasks.length})`);
    for (const t of openTasks.slice(0, 10)) {
      const due = t.dueAt ? formatDate(t.dueAt) : "-";
      console.log(`  · [${t.priority}] ${due} · ${t.title}`);
    }
    if (openTasks.length > 10) {
      console.log(`  … ${openTasks.length - 10} more (ravi crm tasks list --contact ${contact.id})`);
    }
  }

  if (nextActions.length > 0) {
    console.log("");
    console.log(`Next actions (${nextActions.length})`);
    for (const a of nextActions.slice(0, 10)) {
      const due = a.dueAt ? formatDate(a.dueAt) : "-";
      console.log(`  · [${a.priority}] ${due} · ${a.title}`);
    }
  }

  // Footer: link counts (always shown so callers know they exist even when empty),
  // plus pointer to --json for the raw payload.
  console.log("");
  console.log(
    `Links: ${accountMemberships.length} accounts · ${opportunities.length} opportunities · ${tasks.length} tasks · ${nextActions.length} next actions`,
  );
  console.log("Run with --json for the full payload (raw facts, evidence, metadata, all timestamps).");
}

function divider(char: string): string {
  return char.repeat(Math.min(CARD_WIDTH, 80));
}

function printPair(...labelValuePairs: string[]): void {
  // Compact 3-column layout: each pair is `label: value` with column padding.
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < labelValuePairs.length; i += 2) {
    pairs.push([labelValuePairs[i] ?? "", labelValuePairs[i + 1] ?? "-"]);
  }
  const cellWidth = pairs.length === 1 ? 76 : pairs.length === 2 ? 38 : 25;
  const cells = pairs.map(([label, value]) => {
    const text = `${label}: ${value}`;
    return text.length > cellWidth ? `${text.slice(0, cellWidth - 1)}…` : text.padEnd(cellWidth);
  });
  console.log(`  ${cells.join("")}`);
}

function printBlockValue(label: string, value: string): void {
  const lines = value.split("\n");
  console.log(`  ${label}:`);
  for (const line of lines) {
    const wrapped = line.length > CARD_WIDTH - 4 ? `${line.slice(0, CARD_WIDTH - 5)}…` : line;
    console.log(`    ${wrapped}`);
  }
}

function printFact(fact: {
  key: string;
  value: unknown;
  status: string;
  confidence: number;
  source: string;
  updatedAt: string;
}): void {
  const value = formatFactValue(fact.value);
  console.log(`  · ${fact.key}`);
  const wrapped = value.length > CARD_WIDTH - 6 ? `${value.slice(0, CARD_WIDTH - 7)}…` : value;
  console.log(`      ${wrapped}`);
  const conf = Number.isFinite(fact.confidence) ? fact.confidence.toFixed(2) : "?";
  console.log(`      ${fact.status} · confidence ${conf} · source ${fact.source} · ${formatDate(fact.updatedAt)}`);
}

function formatFactValue(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > FACT_VALUE_PREVIEW ? `${json.slice(0, FACT_VALUE_PREVIEW - 1)}…` : json;
  } catch {
    return String(value);
  }
}

function formatNoteValue(value: unknown): string {
  return formatFactValue(value);
}

function formatBool(value: boolean | null | undefined): string {
  return value ? "yes" : "no";
}

function formatOwner(ownerType?: string | null, ownerId?: string | null): string {
  if (!ownerType && !ownerId) return "-";
  if (ownerType && ownerId) return `${ownerType}:${ownerId}`;
  return ownerType ?? ownerId ?? "-";
}

// SQLite CURRENT_TIMESTAMP serializes as `YYYY-MM-DD HH:MM:SS` (no T, no
// zone). The DB stores UTC but the string lacks the marker, so plain
// `new Date(s)` parses it as local — making "now" look hours in the
// future on negative-offset hosts. Patch the marker when we detect the
// SQLite shape; otherwise pass through.
function parseTimestamp(value: string | number): Date {
  if (typeof value === "number") return new Date(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

function formatDate(value: string | number | null | undefined): string {
  if (value == null) return "-";
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function formatRelative(value: string | number | null | undefined): string {
  if (value == null) return "never";
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return "never";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return formatDate(value);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(value);
}

function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${amount}`;
}

function showCrmAccount(accountRef: string, asJson?: boolean) {
  const account = getCrmAccount(accountRef);
  if (!account) fail(`CRM account not found: ${accountRef}`);
  const visibleContacts = filterCrmRecordsByContact(account.contacts ?? []);
  const payload = { target: accountRef, crm: { ...account, contacts: visibleContacts } };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  console.log(`\nCRM account: ${account.account.name}`);
  console.log(`  id: ${account.account.id}`);
  console.log(`  contacts: ${visibleContacts.length}`);
  console.log(`  opportunities: ${account.opportunities.length}`);
  console.log(`  tasks: ${account.tasks.length}`);
  return payload;
}

function showCrmOpportunity(opportunityId: string, asJson?: boolean) {
  const opportunity = getCrmOpportunity(opportunityId);
  if (!opportunity) failOpportunityNotFound("crm opportunity show", opportunityId, asJson);
  const payload = { target: opportunityId, opportunity };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  console.log(`\nCRM opportunity: ${opportunity.title}`);
  console.log(`  status: ${opportunity.status}`);
  console.log(`  priority: ${opportunity.priority}`);
  console.log(`  value: ${opportunity.valueCents ?? "-"} ${opportunity.currency}`);
  return payload;
}

@Group({
  name: "crm",
  description: "CRM relationship surface",
})
export class ACrmCommands {
  @Scope("open")
  @Command({ name: "help", description: "Show a machine-readable CRM command overview" })
  @CommandAccess({ kind: "read", resource: "crm", action: "help", risk: "low" })
  @Returns(crmHelpReturnSchema)
  help(@Option({ flags: "--json", description: "Print the command overview as JSON" }) asJson?: boolean) {
    const payload = {
      domain: "crm" as const,
      commands: [
        { name: "next", intent: "list prioritized next actions", mutates: false },
        { name: "contacts", intent: "list CRM contacts", mutates: false },
        { name: "board", intent: "list paginated opportunities", mutates: false },
        { name: "lifecycle show", intent: "discover published states", mutates: false },
        { name: "facade plan", intent: "resolve an effect without changing data", mutates: false },
        { name: "facade approve", intent: "obtain external approval for a plan", mutates: true },
        { name: "facade apply", intent: "apply one approved plan", mutates: true },
        { name: "facade verify", intent: "read a plan state", mutates: false },
        { name: "facade recover", intent: "inspect uncertainty without replay", mutates: false },
      ],
      next: ["ravi crm lifecycle show --json", "ravi crm facade plan <operation> <target> --json"],
    };
    if (asJson) printJson(payload);
    else console.log("Use `ravi crm help --json` for a machine-readable CRM overview.");
    return payload;
  }

  @Scope("open")
  @Command({ name: "next", description: "List open CRM next actions" })
  @CommandAccess({ kind: "read", resource: "crm", action: "next", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  next(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contact?: string,
    @Option({ flags: "--account <account>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by opportunity" }) opportunity?: string,
    @Option({ flags: "--task-type <type>", description: "Filter by task_type (e.g. commitment, follow_up, call)" })
    taskType?: string,
    @Option({ flags: "--due-today", description: "Only actions whose due_at is today" }) dueToday?: boolean,
    @Option({ flags: "--due-before <ts>", description: "Only actions with due_at < <ts>" }) dueBefore?: string,
    @Option({ flags: "--due-after <ts>", description: "Only actions with due_at >= <ts>" }) dueAfter?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching actions to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const op = "crm next";
    validateTimestamp(op, "--due-before", dueBefore, asJson);
    validateTimestamp(op, "--due-after", dueAfter, asJson);
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    const ownerFilter = parseOwner(owner);
    if (contact) assertCanReadCrmContact("crm next", contact, asJson);
    const page = listCrmNextActions({
      ...ownerFilter,
      contactRef: contact,
      accountId: account,
      opportunityId: opportunity,
      taskType,
      dueToday: Boolean(dueToday),
      dueBefore,
      dueAfter,
      limit,
      offset,
      readableContactIds: listReadableCrmContactIds(),
    });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "crm", "next"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--owner",
        owner,
        "--contact",
        contact,
        "--account",
        account,
        "--opportunity",
        opportunity,
        "--task-type",
        taskType,
        ...(dueToday ? ["--due-today"] : []),
        "--due-before",
        dueBefore,
        "--due-after",
        dueAfter,
      ],
    });
    const items = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, items, actions: items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No open CRM next actions.");
      return payload;
    }
    console.log(`\nCRM next actions (${page.items.length} returned of ${page.total}):\n`);
    for (const action of page.items) renderNextAction(action);
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "contact", description: "Show CRM profile for one contact" })
  @CommandAccess({ kind: "read", resource: "crm", action: "contact", risk: "low" })
  @Returns(crmProfileReturnSchema)
  contact(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmContactProfile(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "account", description: "Show CRM account" })
  @CommandAccess({ kind: "read", resource: "crm", action: "account", risk: "low" })
  @Returns(crmProfileReturnSchema)
  account(
    @Arg("account", { description: "CRM account ID or org contact ID" }) accountRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmAccount(accountRef, asJson);
  }

  @Scope("open")
  @Command({ name: "opportunity", description: "Show CRM opportunity" })
  @CommandAccess({ kind: "read", resource: "crm", action: "opportunity", risk: "low" })
  @Returns(crmOpportunityReturnSchema)
  opportunity(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmOpportunity(opportunityId, asJson);
  }

  @Scope("open")
  @Command({ name: "contacts", description: "List CRM contact cards" })
  @CommandAccess({ kind: "read", resource: "crm", action: "contacts", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  contacts(
    @Option({ flags: "--status <lifecycle>", description: "Filter by CRM lifecycle" }) lifecycle?: string,
    @Option({ flags: "--owner <type:id>", description: "Filter by owner" }) owner?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching contacts to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const op = "crm contacts";
    validateEnumOption(op, "--status", lifecycle, CRM_CONTACT_LIFECYCLE_VALUES, asJson);
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    const ownerFilter = parseOwner(owner);
    const page = listCrmContactCards({
      ...ownerFilter,
      lifecycle,
      limit,
      offset,
      readableContactIds: listReadableCrmContactIds(),
    });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "crm", "contacts"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--status", lifecycle, "--owner", owner],
    });
    const contactItems = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, items: contactItems, contacts: contactItems };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM contacts found.");
      return payload;
    }
    console.log(`\nCRM contacts (${page.items.length} returned of ${page.total}):\n`);
    for (const contact of page.items) {
      console.log(
        `- ${contact.contactId} ${contact.displayName ?? "-"} lifecycle=${contact.lifecycle ?? "unknown"} next=${contact.nextActionSummary ?? "-"}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "board", description: "Show open opportunity board" })
  @CommandAccess({ kind: "read", resource: "crm", action: "board", risk: "low" })
  @Returns(crmBoardReturnSchema)
  board(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--pipeline <pipeline>", description: "Filter by CRM pipeline ID or name" }) pipeline?: string,
    @Option({ flags: "--include-empty-stages", description: "Include configured stages with no opportunities" })
    includeEmptyStages?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each opportunity" })
    fields?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching opportunities to skip (default: 0)" }) offset?: string,
  ) {
    const op = "crm board";
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    const page = paginateCliItems(filterCrmRecordsByContact(listCrmOpportunityBoard({ pipelineRef: pipeline })), { limit, offset });
    const board = pickFields(page.items, fields);
    const pageOpportunityIds = new Set(page.items.map((opportunity) => opportunity.opportunityId));
    const stages = includeEmptyStages
      ? listCrmOpportunityBoardStages(pipeline).map((stage) => ({
          ...stage,
          opportunities: pickFields(
            filterCrmRecordsByContact(stage.opportunities).filter((opportunity) => pageOpportunityIds.has(opportunity.opportunityId)),
            fields,
          ),
        }))
      : undefined;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "board"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      fields,
      options: ["--pipeline", pipeline, ...(includeEmptyStages ? ["--include-empty-stages"] : [])],
    });
    const payload = stages
      ? { total: page.total, pagination, items: board, stages, opportunities: board }
      : { total: page.total, pagination, items: board, opportunities: board };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (stages) {
      console.log("\nCRM opportunity board:\n");
      for (const group of stages) {
        console.log(`${group.stage.key} ${group.stage.name} (${group.opportunities.length})`);
        for (const opportunity of group.opportunities) {
          console.log(`  - ${opportunity.opportunityId}: ${opportunity.title}`);
        }
      }
      return payload;
    }
    if (board.length === 0) {
      console.log("No open CRM opportunities.");
      return payload;
    }
    console.log("\nCRM opportunity board:\n");
    for (const opportunity of board) {
      console.log(`- ${opportunity.stageKey ?? "-"} ${opportunity.opportunityId}: ${opportunity.title}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.lifecycle",
  description: "Published CRM lifecycle states and allowed operations",
})
export class CrmLifecycleCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM lifecycle states and transitions" })
  @CommandAccess({ kind: "read", resource: "crm.lifecycle", action: "show", risk: "low" })
  @Returns(crmLifecycleReturnSchema)
  show(@Option({ flags: "--json", description: "Print lifecycle contract as JSON" }) asJson?: boolean) {
    const payload = {
      contact: { states: [...CRM_CONTACT_LIFECYCLE_VALUES], transitionPolicy: "profile updates are explicit; no automatic lifecycle transition" },
      opportunity: { states: ["open", "won", "lost", "paused", "archived"], transitionPolicy: "stage moves determine status according to pipeline stage configuration" },
      task: { states: [...CRM_TASK_STATUS_VALUES], operations: { done: "open|scheduled|waiting|snoozed -> done", cancel: "non-terminal -> canceled", snooze: "non-terminal -> snoozed" }, terminal: ["done", "canceled"] },
      fact: { states: [...CRM_FACT_STATUS_VALUES], operations: { confirm: "proposed -> confirmed", reject: "proposed -> rejected", supersede: "confirmed -> superseded" }, terminal: ["rejected", "superseded"] },
    };
    if (asJson) printJson(payload);
    else console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
}

@Group({
  name: "crm.facade",
  description: "CRM agent-first planning and controlled effects",
})
export class CrmFacadeCommands {
  @Scope("open")
  @Command({ name: "plan", aliases: ["intent"], description: "Resolve a CRM intent and create a read-only plan" })
  @CommandAccess({ kind: "read", resource: "crm.facade", action: "plan", risk: "low" })
  @Returns(crmFacadePlanReturnSchema)
  plan(
    @Arg("operation", { description: "CRM operation, e.g. task.done or opportunity.move" }) operation: string,
    @Arg("target", { description: "Exact CRM target id or contact identity" }) target: string,
    @Option({ flags: "--stage <stage>", description: "Target stage for opportunity.move" }) stage?: string,
    @Option({ flags: "--contact <contact>", description: "Contact for a link-contact operation" }) contact?: string,
    @Option({ flags: "--field <field>", description: "CRM contact field for contact.set" }) field?: string,
    @Option({ flags: "--value <value>", description: "CRM contact field value for contact.set" }) value?: string,
    @Option({ flags: "--until <timestamp>", description: "Snooze deadline for task.snooze" }) until?: string,
    @Option({ flags: "--reason <text>", description: "Reason recorded with the operation" }) reason?: string,
    @Option({ flags: "--role <role>", description: "Relationship role for a link-contact operation" }) role?: string,
    @Option({ flags: "--account <account>", description: "Account context for opportunity.link-contact" }) account?: string,
    @Option({ flags: "--primary", description: "Mark the linked contact as primary" }) primary?: boolean,
    @Option({ flags: "--json", description: "Print the immutable plan as JSON" }) asJson?: boolean,
  ) {
    const op = "crm facade plan";
    if (!CRM_FACADE_OPERATIONS.includes(operation as CrmFacadeOperation)) {
      contractFail(op, "USAGE_ERROR", `Unsupported CRM facade operation: ${operation}`, {
        asJson,
        exitCode: 2,
        details: {
          parameter: "operation",
          received: operation,
          acceptedValues: [...CRM_FACADE_OPERATIONS],
          suggestedAction: "Choose one of the listed CRM facade operations",
        },
      });
    }
    try {
      const plan = buildCrmFacadePlan({
        operation: operation as CrmFacadeOperation,
        target,
        stage,
        contact,
        field,
        value,
        until,
        reason,
        role,
        account,
        primary: primary === true ? true : undefined,
      });
      persistCrmFacadePlan(plan);
      if (asJson) {
        printJson(plan);
      } else {
        console.log(`CRM plan ${plan.planId}`);
        console.log(`  operation: ${plan.operation}`);
        console.log(`  target: ${plan.target.label} (${plan.target.id})`);
        console.log(`  plan hash: ${plan.planHash}`);
        console.log("  no CRM data was changed");
      }
      return plan;
    } catch (error) {
      if (error instanceof CrmFacadeResolutionError) {
        contractFail(op, error.code, error.message, { asJson, details: error.details });
      }
      throw error;
    }
  }

  @Command({ name: "verify", description: "Read the current state of a CRM facade plan" })
  @CommandAccess({ kind: "read", resource: "crm.facade", action: "verify", risk: "low" })
  @Returns(crmFacadeVerificationReturnSchema)
  verify(@Arg("planId", { description: "Plan identifier" }) planId: string, @Option({ flags: "--json" }) asJson?: boolean) {
    const plan = loadCrmFacadePlan(planId);
    if (!plan) contractFail("crm facade verify", "NOT_FOUND", `CRM facade plan not found: ${planId}`, { asJson, exitCode: 1 });
    const expired = Date.parse(plan.expiresAt) <= Date.now();
    const payload = { planId, planHash: plan.planHash, state: plan.state, expired, observedAt: new Date().toISOString() };
    if (asJson) printJson(payload); else console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({ name: "recover", description: "Inspect a CRM facade plan without replaying it" })
  @CommandAccess({ kind: "read", resource: "crm.facade", action: "recover", risk: "low" })
  @Returns(crmFacadeRecoveryReturnSchema)
  recover(@Arg("planId", { description: "Plan identifier" }) planId: string, @Option({ flags: "--json" }) asJson?: boolean) {
    const plan = loadCrmFacadePlan(planId);
    if (!plan) contractFail("crm facade recover", "NOT_FOUND", `CRM facade plan not found: ${planId}`, { asJson, exitCode: 1 });
    const payload = { planId, planHash: plan.planHash, state: plan.state, action: "manual_review_required", replay: false };
    if (asJson) printJson(payload); else console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "approve", description: "Request external approval for an immutable CRM facade plan" })
  @CommandAccess({ kind: "mutate", resource: "crm.facade", action: "approve", risk: "high" })
  @Returns(crmFacadePlanReturnSchema)
  async approve(
    @Arg("planId", { description: "Plan identifier" }) planId: string,
    @Option({ flags: "--source <channel:account:chat>", description: "External approval destination" }) sourceText?: string,
    @Option({ flags: "--agent <id>", description: "Requesting agent id" }) agentId?: string,
    @Option({ flags: "--json" }) asJson?: boolean,
  ) {
    const plan = loadCrmFacadePlan(planId);
    if (!plan) contractFail("crm facade approve", "NOT_FOUND", `CRM facade plan not found: ${planId}`, { asJson, exitCode: 1 });
    const parts = sourceText?.split(":", 3);
    if (!parts || parts.length !== 3 || parts.some((part) => !part.trim())) contractFail("crm facade approve", "USAGE_ERROR", "--source channel:account:chat is required", { asJson, exitCode: 2 });
    const source = { channel: parts[0], accountId: parts[1], chatId: parts[2] };
    const approval = await requestCascadingApproval({
      type: "plan",
      sessionName: `crm-facade-${planId}`,
      agentId: agentId?.trim() || "crm-facade",
      resolvedSource: source,
      autoApproveWithoutSource: false,
      text: `Approve CRM plan ${planId} with hash ${plan.planHash}: ${plan.operation} on ${plan.target.label}?`,
      eventData: { planId, planHash: plan.planHash, operation: plan.operation, target: plan.target },
    });
    if (!approval.approved) contractFail("crm facade approve", "APPROVAL_DENIED", approval.reason || "External approval was not granted", { asJson, exitCode: 1 });
    const approvedPlan = approveCrmFacadePlan(planId, source);
    if (asJson) printJson(approvedPlan); else console.log(`✓ CRM facade plan approved: ${planId}`);
    return approvedPlan;
  }

  @Scope("writeContacts")
  @Command({ name: "apply", description: "Apply one externally approved CRM facade plan" })
  @CommandAccess({ kind: "mutate", resource: "crm.facade", action: "apply", risk: "high" })
  @Returns(crmFacadeApplyReturnSchema)
  apply(@Arg("planId", { description: "Plan identifier" }) planId: string, @Option({ flags: "--json" }) asJson?: boolean) {
    try {
      const payload = applyCrmFacadePlan(planId);
      if (asJson) printJson(payload); else console.log(`✓ CRM facade plan ${payload.state}: ${planId}`);
      return payload;
    } catch (error) {
      if (error instanceof CrmFacadeResolutionError) contractFail("crm facade apply", error.code, error.message, { asJson, exitCode: 1, details: error.details });
      throw error;
    }
  }
}

@Group({
  name: "crm.pipeline",
  description: "CRM configurable pipelines",
})
export class CrmPipelineCommands {
  @Scope("open")
  @Command({ name: "list", description: "List CRM pipelines" })
  @CommandAccess({ kind: "read", resource: "crm.pipeline", action: "list", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  list(
    @Option({ flags: "--entity-type <type>", description: "Filter by CRM entity type" }) entityType?: string,
    @Option({ flags: "--include-archived", description: "Include archived pipelines" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching pipelines to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const op = "crm pipeline list";
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    const pipelines = listCrmPipelines({ entityType, includeArchived: Boolean(includeArchived) });
    const page = paginateCliItems(pipelines, { limit, offset });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "crm", "pipeline", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--entity-type", entityType, ...(includeArchived ? ["--include-archived"] : [])],
    });
    const pipelineItems = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, items: pipelineItems, pipelines: pipelineItems };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM pipelines found.");
      return payload;
    }
    for (const pipeline of page.items) {
      console.log(`- ${pipeline.isDefault ? "*" : "-"} ${pipeline.id} ${pipeline.name} ${pipeline.status}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "show", description: "Show one CRM pipeline with stages and topics" })
  @CommandAccess({ kind: "read", resource: "crm.pipeline", action: "show", risk: "low" })
  @Returns(crmPipelineDetailsReturnSchema)
  show(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--explain", description: "Render metadata field-by-field with operational impact" })
    explain?: boolean,
  ) {
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) failPipelineNotFound("crm pipeline show", pipelineRef, asJson);
    const payload = pipeline;
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nCRM pipeline: ${pipeline.pipeline.name}`);
    console.log(`  id: ${pipeline.pipeline.id}`);
    console.log(`  entity: ${pipeline.pipeline.entityType}`);
    console.log(`  status: ${pipeline.pipeline.status}`);
    console.log("\nStages:");
    for (const stage of pipeline.stages) {
      const topics = pipeline.topicsByStage[stage.id] ?? [];
      console.log(
        `- ${stage.key} ${stage.name} order=${stage.sortOrder} status=${stage.status} topics=${topics.length}`,
      );
    }
    if (explain) {
      console.log("\nMetadata (canonical fields):");
      const review = reviewPipelineMetadata(
        {
          id: pipeline.pipeline.id,
          name: pipeline.pipeline.name,
          metadata: pipeline.pipeline.metadata ?? {},
        },
        { runtimeStageKeys: pipeline.stages.map((s) => s.key) },
      );
      const groupOrder = ["identidade", "estrutura", "politicas", "comunicacao", "tags", "integracoes"] as const;
      for (const group of groupOrder) {
        const items = review.fields.filter((f) => f.group === group);
        if (items.length === 0) continue;
        console.log(`\n  [${group.toUpperCase()}]`);
        for (const f of items) {
          const icon = f.present === "present" ? "✓" : f.present === "partial" ? "⚠" : "✗";
          console.log(`    ${icon} ${f.field}: ${f.detail}`);
          if (f.suggestion) console.log(`      → ${f.suggestion}`);
        }
      }
      console.log(
        `\n  Gaps: ${review.totalGaps} total (${review.highSeverityGaps} high severity). Use \`ravi crm pipeline review ${pipeline.pipeline.id}\` for structured report.`,
      );
    }
    return payload;
  }

  @Scope("open")
  @Command({
    name: "review",
    description: "Review pipeline metadata; exits 1 when high-severity gaps are found",
  })
  @CommandAccess({ kind: "read", resource: "crm.pipeline", action: "review", risk: "low" })
  @Returns(crmPipelineReviewReturnSchema)
  review(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) failPipelineNotFound("crm pipeline review", pipelineRef, asJson);
    const report = reviewPipelineMetadata(
      {
        id: pipeline.pipeline.id,
        name: pipeline.pipeline.name,
        metadata: pipeline.pipeline.metadata ?? {},
      },
      { runtimeStageKeys: pipeline.stages.map((s) => s.key) },
    );
    if (report.highSeverityGaps > 0) {
      contractFail(
        "crm pipeline review",
        "PIPELINE_REVIEW_FAILED",
        `Pipeline review found ${report.highSeverityGaps} high-severity gap(s).`,
        {
          asJson,
          details: {
            pipelineId: report.pipelineId,
            totalGaps: report.totalGaps,
            highSeverityGaps: report.highSeverityGaps,
            gaps: report.fields
              .filter((field) => field.present !== "present")
              .map(({ group, field, present, suggestion }) => ({ group, field, present, suggestion })),
            suggestedAction: `Complete the missing pipeline metadata, then run: ravi crm pipeline review ${report.pipelineId} --json`,
          },
        },
      );
    }
    if (asJson) {
      printJson(report);
      return report;
    }
    console.log(`\nReview: ${report.pipelineName} (${report.pipelineId})`);
    console.log(`Gaps: ${report.totalGaps} total / ${report.highSeverityGaps} high severity\n`);
    const groupOrder = ["identidade", "estrutura", "politicas", "comunicacao", "tags", "integracoes"] as const;
    for (const group of groupOrder) {
      const items = report.fields.filter((f: PipelineReviewFieldStatus) => f.group === group);
      if (items.length === 0) continue;
      console.log(`[${group.toUpperCase()}]`);
      for (const f of items) {
        const icon = f.present === "present" ? "✓" : f.present === "partial" ? "⚠" : "✗";
        console.log(`  ${icon} ${f.field}: ${f.detail}`);
        if (f.suggestion) console.log(`    → ${f.suggestion}`);
      }
      console.log("");
    }
    return report;
  }

  @Scope("open")
  @Command({
    name: "validate",
    description: "Validate pipeline metadata against canonical JSON Schema (PASS/WARN/FAIL)",
  })
  @CommandAccess({ kind: "read", resource: "crm.pipeline", action: "validate", risk: "low" })
  @Returns(crmPipelineValidationReturnSchema)
  validate(
    @Arg("pipeline", {
      description: "CRM pipeline ID or name (omit when using --schema-json)",
      required: false,
    })
    pipelineRef: string | undefined,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--schema-json",
      description: "Print canonical JSON Schema (Draft-07) and exit",
    })
    schemaJson?: boolean,
  ) {
    if (schemaJson) {
      const schema = getPipelineMetadataJsonSchema();
      printJson(schema);
      return {
        pipelineId: "",
        ok: true,
        errors: [],
        warnings: [],
        schema,
      };
    }
    if (!pipelineRef) {
      contractFail("crm pipeline validate", "USAGE_ERROR", "pipeline argument required (or pass --schema-json)", {
        asJson,
        exitCode: 2,
        details: { acceptedPositionals: ["<pipeline>"], acceptedFlags: ["--schema-json", "--json"] },
      });
    }
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) failPipelineNotFound("crm pipeline validate", pipelineRef, asJson);
    const result = validatePipelineMetadata(pipeline.pipeline.metadata ?? {}, {
      runtimeStageKeys: pipeline.stages.map((s) => s.key),
    });
    const errors = redactPipelineValidationIssues(result.errors);
    const warnings = redactPipelineValidationIssues(result.warnings);
    const payload = {
      pipelineId: pipeline.pipeline.id,
      ok: result.ok,
      errors,
      warnings,
    };
    if (!result.ok) {
      contractFail(
        "crm pipeline validate",
        "PIPELINE_VALIDATION_FAILED",
        `Pipeline metadata validation failed with ${errors.length} error(s).`,
        {
          asJson,
          details: {
            pipelineId: pipeline.pipeline.id,
            errors,
            warnings,
            suggestedAction: `Correct the reported metadata fields, then run: ravi crm pipeline validate ${pipeline.pipeline.id} --json`,
          },
        },
      );
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nValidate: ${pipeline.pipeline.name} (${pipeline.pipeline.id})`);
    console.log(`Result: ${result.ok ? "PASS" : "FAIL"}`);
    if (errors.length > 0) {
      console.log(`\nErrors (${errors.length}):`);
      for (const e of errors) {
        console.log(`  ✗ ${e.path}: ${e.message}`);
      }
    }
    if (warnings.length > 0) {
      console.log(`\nWarnings (${warnings.length}):`);
      for (const w of warnings) {
        console.log(`  ⚠ ${w.path}: ${w.message}`);
      }
    }
    if (result.ok && warnings.length === 0) {
      console.log("\nNo issues found.");
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({
    name: "create",
    description: "Create a CRM pipeline",
    helpAfter: PIPELINE_CREATE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline", action: "create", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  create(
    @Arg("name", { description: "Pipeline name" }) name: string,
    @Option({ flags: "--entity-type <type>", description: "CRM entity type (default: opportunity)" })
    entityType?: string,
    @Option({ flags: "--default", description: "Mark as default pipeline for the entity type" }) isDefault?: boolean,
    @Option({
      flags: "--metadata <json>",
      description: "Raw metadata JSON object (structured flags merge on top)",
    })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated create attempts" })
    idempotencyKey?: string,
    @Option({ flags: "--objetivo <text>", description: "One-paragraph pipeline purpose" })
    objetivo?: string,
    @Option({
      flags: "--priority-global <n>",
      description: "Cross-pipeline arbitration priority (1=highest, 5=lowest)",
    })
    priorityGlobal?: string,
    @Option({ flags: "--producer <ids>", description: "Comma list of producer agent ids" })
    producers?: string,
    @Option({ flags: "--consumer <ids>", description: "Comma list of consumer agent ids" })
    consumers?: string,
    @Option({ flags: "--reading-list-id <slug>", description: "Reading list slug bound to this pipeline" })
    readingListId?: string,
    @Option({ flags: "--versao <semver>", description: "Semver of this metadata document" })
    versao?: string,
    @Option({ flags: "--vip-guard-tag <tags>", description: "Comma list of VIP tag triggers" })
    vipGuardTags?: string,
    @Option({ flags: "--vip-guard-ltv <n>", description: "Lifetime value threshold for VIP" })
    vipGuardLtv?: string,
    @Option({ flags: "--vip-guard-action <act>", description: "hitl | block | tag_only" })
    vipGuardAction?: string,
    @Option({
      flags: "--send-window <hdtz>",
      description: "Send window 'hours[,days],timezone' (e.g. 9-21,mon-sat,America/Sao_Paulo)",
    })
    sendWindow?: string,
    @Option({ flags: "--hitl-required-when <json>", description: "JSON {conditions:[...]}" })
    hitlRequiredWhen?: string,
    @Option({ flags: "--message-prefix <text>", description: "Outbound message prefix" })
    messagePrefix?: string,
    @Option({ flags: "--message-suffix <text>", description: "Outbound message suffix" })
    messageSuffix?: string,
    @Option({ flags: "--analyst-tone <text>", description: "Tone for analyst-drafted messages" })
    analystTone?: string,
    @Option({
      flags: "--analyst-mentions <list>",
      description: "Comma list of mandatory mentions in analyst messages",
    })
    analystMentions?: string,
    @Option({ flags: "--analyst-avoid <list>", description: "Comma list of forbidden topics" })
    analystAvoid?: string,
    @Option({
      flags: "--regua-tag <json...>",
      description: "Repeatable regua tag JSON {tag,apply_when,linked_stage,apply_by}",
    })
    reguaTags?: string[],
    @Option({ flags: "--related-cron <ids>", description: "Comma list of related CRON ids" })
    relatedCrons?: string,
    @Option({ flags: "--related-trigger <ids>", description: "Comma list of related trigger ids" })
    relatedTriggers?: string,
  ) {
    const base = parseOptionalJsonObject(metadataJson, "--metadata") ?? {};
    const metadata = buildMetadataFromStructuredFlags(base, {
      objetivo,
      priorityGlobal,
      producers,
      consumers,
      readingListId,
      versao,
      vipGuardTags,
      vipGuardLtv,
      vipGuardAction,
      sendWindow,
      hitlRequiredWhen,
      messagePrefix,
      messageSuffix,
      analystTone,
      analystMentions,
      analystAvoid,
      reguaTags,
      relatedCrons,
      relatedTriggers,
    });
    if (Object.keys(metadata).length > 0) {
      assertValidPipelineMetadata(metadata, "crm pipeline create");
    }
    const pipeline = createCrmPipeline({
      name,
      entityType,
      isDefault: isDefault === true,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      source: "cli",
      actorType: "user",
      idempotencyKey,
    });
    const payload = { status: "created" as const, pipeline, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline created: ${pipeline.id} ${pipeline.name}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({
    name: "set",
    description: "Set a CRM pipeline field (or patch metadata via structured flags)",
    helpAfter: PIPELINE_SET_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline", action: "set", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  set(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("field", { description: "name|entity-type|default|status|metadata" }) field: string,
    @Arg("value", { description: "New value (use '-' to patch metadata via structured flags)" })
    value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--objetivo <text>", description: "Patch metadata.objetivo" }) objetivo?: string,
    @Option({ flags: "--priority-global <n>", description: "Patch metadata.priority_global (1-5)" })
    priorityGlobal?: string,
    @Option({ flags: "--producer <ids>", description: "Patch metadata.producers (comma list)" })
    producers?: string,
    @Option({ flags: "--consumer <ids>", description: "Patch metadata.consumers (comma list)" })
    consumers?: string,
    @Option({ flags: "--reading-list-id <slug>", description: "Patch metadata.reading_list_id" })
    readingListId?: string,
    @Option({ flags: "--versao <semver>", description: "Patch metadata.versao" })
    versao?: string,
    @Option({ flags: "--vip-guard-tag <tags>", description: "Patch metadata.vip_guard.tag_triggers" })
    vipGuardTags?: string,
    @Option({ flags: "--vip-guard-ltv <n>", description: "Patch metadata.vip_guard.ltv_threshold" })
    vipGuardLtv?: string,
    @Option({
      flags: "--vip-guard-action <act>",
      description: "Patch metadata.vip_guard.action (hitl|block|tag_only)",
    })
    vipGuardAction?: string,
    @Option({ flags: "--send-window <hdtz>", description: "Patch metadata.send_window" })
    sendWindow?: string,
    @Option({
      flags: "--hitl-required-when <json>",
      description: "Patch metadata.hitl_required_when",
    })
    hitlRequiredWhen?: string,
    @Option({ flags: "--message-prefix <text>", description: "Patch metadata.message_rule.prefix" })
    messagePrefix?: string,
    @Option({ flags: "--message-suffix <text>", description: "Patch metadata.message_rule.suffix" })
    messageSuffix?: string,
    @Option({ flags: "--analyst-tone <text>", description: "Patch metadata.analyst_guidance.tone" })
    analystTone?: string,
    @Option({
      flags: "--analyst-mentions <list>",
      description: "Patch metadata.analyst_guidance.mandatory_mentions (comma)",
    })
    analystMentions?: string,
    @Option({
      flags: "--analyst-avoid <list>",
      description: "Patch metadata.analyst_guidance.avoid (comma)",
    })
    analystAvoid?: string,
    @Option({
      flags: "--regua-tag <json...>",
      description: "Repeatable regua tag JSON (appends to existing list)",
    })
    reguaTags?: string[],
    @Option({ flags: "--related-cron <ids>", description: "Patch metadata.related_crons (comma)" })
    relatedCrons?: string,
    @Option({
      flags: "--related-trigger <ids>",
      description: "Patch metadata.related_triggers (comma)",
    })
    relatedTriggers?: string,
  ) {
    const normalizedField = field.trim().toLowerCase();
    const input: Parameters<typeof updateCrmPipeline>[0] = {
      pipelineRef,
      source: "cli",
      actorType: "user",
    };

    const hasStructuredFlag =
      objetivo !== undefined ||
      priorityGlobal !== undefined ||
      producers !== undefined ||
      consumers !== undefined ||
      readingListId !== undefined ||
      versao !== undefined ||
      vipGuardTags !== undefined ||
      vipGuardLtv !== undefined ||
      vipGuardAction !== undefined ||
      sendWindow !== undefined ||
      hitlRequiredWhen !== undefined ||
      messagePrefix !== undefined ||
      messageSuffix !== undefined ||
      analystTone !== undefined ||
      analystMentions !== undefined ||
      analystAvoid !== undefined ||
      (reguaTags && reguaTags.length > 0) ||
      relatedCrons !== undefined ||
      relatedTriggers !== undefined;

    if (normalizedField === "metadata" && hasStructuredFlag && (value === "-" || value === "")) {
      // Structured-patch mode: merge flags onto existing metadata.
      const current = getCrmPipeline(pipelineRef);
      if (!current) fail(`CRM pipeline not found: ${pipelineRef}`);
      const base = (current.pipeline.metadata as Record<string, unknown> | null) ?? {};
      input.metadata = buildMetadataFromStructuredFlags(base, {
        objetivo,
        priorityGlobal,
        producers,
        consumers,
        readingListId,
        versao,
        vipGuardTags,
        vipGuardLtv,
        vipGuardAction,
        sendWindow,
        hitlRequiredWhen,
        messagePrefix,
        messageSuffix,
        analystTone,
        analystMentions,
        analystAvoid,
        reguaTags,
        relatedCrons,
        relatedTriggers,
      });
      assertValidPipelineMetadata(input.metadata, "crm pipeline set");
    } else if (normalizedField === "name") input.name = value;
    else if (normalizedField === "entity-type" || normalizedField === "entitytype") input.entityType = value;
    else if (normalizedField === "default" || normalizedField === "is-default")
      input.isDefault = parseBooleanValue(value, field);
    else if (normalizedField === "status") input.status = value;
    else if (normalizedField === "metadata") input.metadata = parseJsonObjectArg(value);
    else fail(`Unsupported CRM pipeline field: ${field}`);

    const pipeline = updateCrmPipeline(input);
    const payload = { status: "updated" as const, pipeline, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline updated: ${pipeline.id} ${pipeline.name}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.pipeline.policy",
  description: "Evaluate pipeline metadata policies (engine consumers: send_window, hitl_required_when)",
})
export class CrmPipelinePolicyCommands {
  @Scope("open")
  @Command({
    name: "send-window-check",
    description: "Evaluate metadata.send_window for a pipeline at a given instant (allow / releaseAt)",
  })
  @CommandAccess({
    kind: "read",
    resource: "crm.pipeline.policy",
    action: "send-window-check",
    risk: "low",
  })
  @Returns(crmPipelineSendWindowCheckReturnSchema)
  sendWindowCheck(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({
      flags: "--at <iso>",
      description: "Instant to evaluate (ISO 8601, default: now)",
    })
    atIso?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) fail(`CRM pipeline not found: ${pipelineRef}`);
    const meta = pipeline.pipeline.metadata as Record<string, unknown> | null | undefined;
    const sendWindow = meta?.send_window as PipelineMetadata["send_window"];
    const at = atIso ? new Date(atIso) : new Date();
    if (atIso && Number.isNaN(at.getTime())) fail(`Invalid --at: ${atIso}`);
    const decision = evaluateSendWindow(sendWindow, at);
    const payload = {
      pipelineId: pipeline.pipeline.id,
      ok: decision.allowed,
      errors: [],
      warnings: [],
      decision,
    };
    if (asJson) {
      printJson(payload);
      if (!decision.allowed) process.exitCode = 1;
      return payload;
    }
    console.log(`\nSend-window check: ${pipeline.pipeline.name} (${pipeline.pipeline.id})`);
    console.log(`Evaluated at: ${decision.evaluatedAtIso} (tz=${decision.timezone})`);
    console.log(`Allowed: ${decision.allowed ? "YES" : "NO"} (${decision.reason})`);
    if (!decision.allowed && decision.releaseAtIso) {
      console.log(`Release at: ${decision.releaseAtIso}`);
    }
    if (!decision.allowed) process.exitCode = 1;
    return payload;
  }

  @Scope("open")
  @Command({
    name: "hitl-check",
    description: "Evaluate metadata.hitl_required_when against a JSON context (decide if send needs human approval)",
  })
  @CommandAccess({
    kind: "read",
    resource: "crm.pipeline.policy",
    action: "hitl-check",
    risk: "low",
  })
  @Returns(crmPipelineHitlCheckReturnSchema)
  hitlCheck(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({
      flags: "--context <json>",
      description: "JSON object with context (tags, contact_value, ltv)",
    })
    contextJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) fail(`CRM pipeline not found: ${pipelineRef}`);
    const meta = pipeline.pipeline.metadata as Record<string, unknown> | null | undefined;
    const rules = meta?.hitl_required_when as PipelineMetadata["hitl_required_when"];
    const context = contextJson ? (parseJsonObjectArg(contextJson) ?? {}) : {};
    const decision = evaluateHitlRequiredWhen(rules, context);
    const payload = {
      pipelineId: pipeline.pipeline.id,
      ok: !decision.hitlRequired,
      errors: [],
      warnings: [],
      decision,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nHITL check: ${pipeline.pipeline.name} (${pipeline.pipeline.id})`);
    console.log(`HITL required: ${decision.hitlRequired ? "YES" : "NO"}`);
    if (decision.matchedConditions > 0) {
      console.log(`Matched conditions (${decision.matchedConditions}):`);
      for (const r of decision.reasons) console.log(`  - ${r}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.pipeline.stage",
  description: "CRM pipeline stages",
})
export class CrmPipelineStageCommands {
  @Scope("open")
  @Command({ name: "list", description: "List stages in a CRM pipeline" })
  @CommandAccess({ kind: "read", resource: "crm.pipeline.stage", action: "list", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  list(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({ flags: "--include-archived", description: "Include archived stages" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching stages to skip (default: 0)" }) offset?: string,
  ) {
    const stages = listCrmPipelineStages(pipelineRef, { includeArchived: Boolean(includeArchived) });
    const page = paginateCliItems(stages, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "pipeline", "stage", "list", pipelineRef],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: includeArchived ? ["--include-archived"] : [],
    });
    const payload = { pipeline: pipelineRef, total: page.total, pagination, items: page.items, stages: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM pipeline stages found.");
      return payload;
    }
    for (const stage of page.items) {
      console.log(`- ${stage.sortOrder} ${stage.key} ${stage.name} ${stage.status}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "show", description: "Show one CRM pipeline stage" })
  @CommandAccess({ kind: "read", resource: "crm.pipeline.stage", action: "show", risk: "low" })
  @Returns(crmPipelineStageDetailsReturnSchema)
  show(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const stage = getCrmPipelineStage(pipelineRef, stageRef);
    if (!stage) fail(`CRM pipeline stage not found: ${stageRef}`);
    if (asJson) {
      printJson(stage);
      return stage;
    }
    console.log(`\nCRM pipeline stage: ${stage.stage.name}`);
    console.log(`  key: ${stage.stage.key}`);
    console.log(`  order: ${stage.stage.sortOrder}`);
    console.log(`  topics: ${stage.topics.length}`);
    return stage;
  }

  @Scope("writeContacts")
  @Command({ name: "add", description: "Add a stage to a CRM pipeline" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage", action: "add", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  add(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("key", { description: "Stage key" }) key: string,
    @Option({ flags: "--name <name>", description: "Stage display name" }) name?: string,
    @Option({ flags: "--order <n>", description: "Stage sort order" }) order?: string,
    @Option({ flags: "--category <category>", description: "new|active|waiting|terminal_won|terminal_lost" })
    category?: string,
    @Option({ flags: "--probability <n>", description: "Default probability between 0 and 1" }) probability?: string,
    @Option({ flags: "--terminal", description: "Mark stage as terminal" }) terminal?: boolean,
    @Option({ flags: "--metadata <json>", description: "Metadata JSON object" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated create attempts" })
    idempotencyKey?: string,
  ) {
    if (!name) fail("--name is required");
    if (!order) fail("--order is required");
    const stage = createCrmPipelineStage({
      pipelineRef,
      key,
      name,
      sortOrder: parseRequiredNumber(order, "--order"),
      category,
      probability: parseOptionalNumber(probability, "--probability") ?? undefined,
      isTerminal: terminal === true ? true : undefined,
      metadata: parseOptionalJsonObject(metadataJson, "--metadata"),
      source: "cli",
      actorType: "user",
      idempotencyKey,
    });
    const payload = { status: "created" as const, stage, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage created: ${stage.key} ${stage.name}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set a CRM pipeline stage field" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage", action: "set", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  set(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Arg("field", { description: "key|name|order|category|probability|terminal|status|metadata" }) field: string,
    @Arg("value", { description: "New value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedField = field.trim().toLowerCase();
    const input: Parameters<typeof updateCrmPipelineStage>[0] = {
      pipelineRef,
      stageRef,
      source: "cli",
      actorType: "user",
    };
    if (normalizedField === "key") input.key = value;
    else if (normalizedField === "name") input.name = value;
    else if (normalizedField === "order" || normalizedField === "sort-order")
      input.sortOrder = parseRequiredNumber(value, field);
    else if (normalizedField === "category") input.category = value;
    else if (normalizedField === "probability") input.probability = parseOptionalNumber(value, field);
    else if (normalizedField === "terminal" || normalizedField === "is-terminal")
      input.isTerminal = parseBooleanValue(value, field);
    else if (normalizedField === "status") input.status = value;
    else if (normalizedField === "metadata") input.metadata = parseJsonObjectArg(value);
    else fail(`Unsupported CRM pipeline stage field: ${field}`);

    const stage = updateCrmPipelineStage(input);
    const payload = { status: "updated" as const, stage, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage updated: ${stage.key} ${stage.name}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "archive", description: "Archive a CRM pipeline stage" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage", action: "archive", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  archive(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const stage = archiveCrmPipelineStage({ pipelineRef, stageRef, source: "cli", actorType: "user" });
    const payload = { status: "archived" as const, stage, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage archived: ${stage.key}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "topics", description: "List topics configured for a CRM pipeline stage" })
  @CommandAccess({ kind: "read", resource: "crm.pipeline.stage", action: "topics", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  topics(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Option({ flags: "--include-archived", description: "Include archived topics" }) includeArchived?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching topics to skip (default: 0)" }) offset?: string,
  ) {
    const topics = listCrmPipelineStageTopics(pipelineRef, stageRef, { includeArchived: Boolean(includeArchived) });
    const page = paginateCliItems(topics, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "pipeline", "stage", "topics", pipelineRef, stageRef],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: includeArchived ? ["--include-archived"] : [],
    });
    const payload = {
      pipeline: pipelineRef,
      stage: stageRef,
      total: page.total,
      pagination,
      items: page.items,
      topics: page.items,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM pipeline stage topics found.");
      return payload;
    }
    for (const topic of page.items) {
      console.log(`- ${topic.sortOrder} ${topic.key} ${topic.title} ${topic.status}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }
}

@Group({
  name: "crm.pipeline.stage.topic",
  description: "CRM pipeline stage topics",
})
export class CrmPipelineStageTopicCommands {
  @Scope("writeContacts")
  @Command({ name: "add", description: "Add a topic to a CRM pipeline stage" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage.topic", action: "add", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  add(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Arg("key", { description: "Topic key" }) key: string,
    @Option({ flags: "--title <title>", description: "Topic title" }) title?: string,
    @Option({ flags: "--description <text>", description: "Topic description" }) description?: string,
    @Option({
      flags: "--type <type>",
      description: "subject|objection|qualification|proposal|pricing|next_action|risk",
    })
    topicType?: string,
    @Option({ flags: "--order <n>", description: "Topic sort order" }) order?: string,
    @Option({ flags: "--metadata <json>", description: "Metadata JSON object" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated create attempts" })
    idempotencyKey?: string,
  ) {
    if (!title) fail("--title is required");
    const topic = createCrmPipelineStageTopic({
      pipelineRef,
      stageRef,
      key,
      title,
      description,
      topicType,
      sortOrder: order === undefined ? undefined : parseRequiredNumber(order, "--order"),
      metadata: parseOptionalJsonObject(metadataJson, "--metadata"),
      source: "cli",
      actorType: "user",
      idempotencyKey,
    });
    const payload = { status: "created" as const, topic, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage topic created: ${topic.key} ${topic.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set a CRM pipeline stage topic field" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage.topic", action: "set", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  set(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Arg("topic", { description: "Topic key or ID" }) topicRef: string,
    @Arg("field", { description: "key|title|description|type|order|status|metadata" }) field: string,
    @Arg("value", { description: "New value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedField = field.trim().toLowerCase();
    const input: Parameters<typeof updateCrmPipelineStageTopic>[0] = {
      pipelineRef,
      stageRef,
      topicRef,
      source: "cli",
      actorType: "user",
    };
    if (normalizedField === "key") input.key = value;
    else if (normalizedField === "title") input.title = value;
    else if (normalizedField === "description") input.description = parseNullable(value);
    else if (normalizedField === "type" || normalizedField === "topic-type") input.topicType = value;
    else if (normalizedField === "order" || normalizedField === "sort-order")
      input.sortOrder = parseRequiredNumber(value, field);
    else if (normalizedField === "status") input.status = value;
    else if (normalizedField === "metadata") input.metadata = parseJsonObjectArg(value);
    else fail(`Unsupported CRM pipeline stage topic field: ${field}`);

    const topic = updateCrmPipelineStageTopic(input);
    const payload = { status: "updated" as const, topic, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage topic updated: ${topic.key} ${topic.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "archive", description: "Archive a CRM pipeline stage topic" })
  @CommandAccess({ kind: "mutate", resource: "crm.pipeline.stage.topic", action: "archive", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  archive(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Arg("stage", { description: "Stage key or ID" }) stageRef: string,
    @Arg("topic", { description: "Topic key or ID" }) topicRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const topic = archiveCrmPipelineStageTopic({ pipelineRef, stageRef, topicRef, source: "cli", actorType: "user" });
    const payload = { status: "archived" as const, topic, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM pipeline stage topic archived: ${topic.key}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.contact",
  description: "CRM contact profile mutations",
})
export class CrmContactCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM profile for one contact" })
  @CommandAccess({ kind: "read", resource: "crm.contact", action: "show", risk: "low" })
  @Returns(crmProfileReturnSchema)
  show(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmContactProfile(contactRef, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set one CRM contact profile field" })
  @CommandAccess({ kind: "mutate", resource: "crm.contact", action: "set", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("field", { description: "CRM field" }) field: string,
    @Arg("value", { description: "Field value, '-' to clear nullable fields" }) value: string,
    @Option({ flags: "--source <source>", description: "Mutation source (default: cli)" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCanReadCrmContact("crm contact set", contactRef, asJson);
    const input: Parameters<typeof updateCrmContactProfile>[0] = {
      contactRef,
      source: source?.trim() || "cli",
      actorType: "user",
    };
    switch (field) {
      case "lifecycle":
        input.lifecycle = parseNullable(value);
        break;
      case "relationship-health":
      case "health":
        input.relationshipHealth = parseNullable(value);
        break;
      case "priority":
        input.priority = parseNullable(value);
        break;
      case "score":
        input.score = parseOptionalNumber(value, "score");
        break;
      case "health-score":
        input.healthScore = parseOptionalNumber(value, "health-score");
        break;
      case "owner": {
        if (value === "-" || value === "null") {
          input.ownerType = null;
          input.ownerId = null;
        } else {
          Object.assign(input, parseOwner(value));
        }
        break;
      }
      case "primary-account":
        input.primaryAccountId = parseNullable(value);
        break;
      case "primary-opportunity":
        input.primaryOpportunityId = parseNullable(value);
        break;
      case "lead-source":
        input.leadSource = parseNullable(value);
        break;
      case "persona":
        input.persona = parseNullable(value);
        break;
      case "buying-role":
        input.buyingRole = parseNullable(value);
        break;
      case "last-meaningful-interaction-at":
        input.lastMeaningfulInteractionAt = parseNullable(value);
        break;
      case "next-action-at":
        input.nextActionAt = parseNullable(value);
        break;
      case "next-action-summary":
        input.nextActionSummary = parseNullable(value);
        break;
      case "next-task":
        input.nextTaskId = parseNullable(value);
        break;
      case "metadata":
        input.metadata = parseJsonObjectArg(value);
        break;
      default:
        fail(
          "Unknown CRM contact field. Use lifecycle, relationship-health, priority, score, health-score, owner, primary-account, primary-opportunity, lead-source, persona, buying-role, next-action-at, next-action-summary, next-task, metadata.",
        );
    }
    const profile = updateCrmContactProfile(input);
    const payload = { status: "updated" as const, contactId: profile.contactId, field, profile, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM contact updated: ${profile.contactId} ${field}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.account",
  description: "CRM account mutations",
})
export class CrmAccountCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM account" })
  @CommandAccess({ kind: "read", resource: "crm.account", action: "show", risk: "low" })
  @Returns(crmProfileReturnSchema)
  show(
    @Arg("account", { description: "CRM account ID or org contact ID" }) accountRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmAccount(accountRef, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM account" })
  @CommandAccess({ kind: "mutate", resource: "crm.account", action: "create", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  create(
    @Arg("name", { description: "Account name" }) name: string,
    @Option({ flags: "--contact <orgContact>", description: "Organization contact ID" }) orgContactRef?: string,
    @Option({ flags: "--domain <domain>", description: "Account domain" }) domain?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated account creation" })
    idempotencyKey?: string,
  ) {
    const account = createCrmAccount({
      name,
      orgContactRef,
      domain,
      ...parseOwner(owner),
      idempotencyKey,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "created" as const, account, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM account created: ${account.id} ${account.name}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "link-contact", description: "Link a contact to an account" })
  @CommandAccess({ kind: "mutate", resource: "crm.account", action: "link-contact", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  linkContact(
    @Arg("account", { description: "CRM account ID" }) accountId: string,
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--role <role>", description: "Membership role (default: member)" }) role?: string,
    @Option({ flags: "--primary", description: "Mark as primary account contact" }) primary?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const account = getCrmAccount(accountId);
    if (!account) {
      contractFail("crm account link-contact", "CRM_ACCOUNT_NOT_FOUND", `CRM account not found: ${accountId}`, {
        asJson,
        details: { suggestedAction: "Check the CRM account id with: ravi crm account --json" },
      });
    }
    assertCanReadCrmContact("crm account link-contact", contactRef, asJson);
    const membership = linkCrmAccountContact({
      accountId,
      contactRef,
      role,
      isPrimary: primary === true ? true : undefined,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "linked" as const, membership, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM account contact linked: ${membership.accountId} -> ${membership.contactId}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.opportunity",
  description: "CRM opportunity mutations",
})
export class CrmOpportunityCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM opportunity" })
  @CommandAccess({ kind: "read", resource: "crm.opportunity", action: "show", risk: "low" })
  @Returns(crmOpportunityReturnSchema)
  show(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmOpportunity(opportunityId, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM opportunity" })
  @CommandAccess({ kind: "mutate", resource: "crm.opportunity", action: "create", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  create(
    @Arg("title", { description: "Opportunity title" }) title: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--contact <contact>", description: "Contact ID or identity" }) contactRef?: string,
    @Option({ flags: "--pipeline <pipeline>", description: "Pipeline ID or name" }) pipeline?: string,
    @Option({ flags: "--stage <stage>", description: "Pipeline stage key or ID" }) stage?: string,
    @Option({ flags: "--value <cents>", description: "Opportunity value in cents" }) value?: string,
    @Option({ flags: "--currency <code>", description: "Currency (default: BRL)" }) currency?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated opportunity creation" })
    idempotencyKey?: string,
  ) {
    if (value !== undefined && value !== "-" && value !== "null" && !Number.isFinite(Number(value))) {
      contractFail("crm opportunity create", "USAGE_ERROR", `--value must be a number (got: ${value})`, {
        asJson,
        exitCode: 2,
        details: {
          suggestedAction: "Pass the opportunity value in integer cents, e.g. --value 500000",
          acceptedFlags: [
            "--account",
            "--contact",
            "--pipeline",
            "--stage",
            "--value",
            "--currency",
            "--owner",
            "--json",
            "--idempotency-key",
          ],
        },
      });
    }
    const createInput = {
      title,
      accountId,
      contactRef,
      pipelineId: pipeline,
      stageKey: stage,
      valueCents: parseOptionalNumber(value, "value") ?? undefined,
      currency,
      ...parseOwner(owner),
      idempotencyKey,
    };
    const opportunity = createCrmOpportunity({
      ...createInput,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "created" as const, opportunity, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity created: ${opportunity.id} ${opportunity.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "move", description: "Move an opportunity to another stage" })
  @CommandAccess({ kind: "mutate", resource: "crm.opportunity", action: "move", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  move(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Arg("stage", { description: "Pipeline stage key or ID" }) stageRef: string,
    @Option({ flags: "--lost-reason <text>", description: "Lost reason when moving to lost" }) lostReason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmOpportunityMutationTarget("crm opportunity move", opportunityId, asJson);
    const opportunity = moveCrmOpportunityStage({
      opportunityId,
      stageRef,
      lostReason,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "moved" as const, opportunity, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity moved: ${opportunity.id} status=${opportunity.status}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "contacts", description: "List contacts linked to an opportunity" })
  @CommandAccess({ kind: "read", resource: "crm.opportunity", action: "contacts", risk: "low" })
  @Returns(crmOpportunityContactsReturnSchema)
  contacts(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contacts = filterCrmRecordsByContact(listCrmOpportunityContacts(opportunityId));
    const payload = { total: contacts.length, contacts };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (contacts.length === 0) {
      console.log("No CRM opportunity contacts.");
      return payload;
    }
    for (const contact of contacts) {
      console.log(`- ${contact.isPrimary ? "*" : "-"} ${contact.contactId} ${contact.role}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "link-contact", description: "Link a contact to an opportunity" })
  @CommandAccess({ kind: "mutate", resource: "crm.opportunity", action: "link-contact", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  linkContact(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--role <role>", description: "Opportunity role (default: stakeholder)" }) role?: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--primary", description: "Mark as primary opportunity contact" }) primary?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmOpportunityMutationTarget("crm opportunity link-contact", opportunityId, asJson);
    assertCanReadCrmContact("crm opportunity link-contact", contactRef, asJson);
    const contact = linkCrmOpportunityContact({
      opportunityId,
      contactRef,
      role,
      accountId,
      isPrimary: primary === true ? true : undefined,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "linked" as const, contact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity contact linked: ${contact.opportunityId} -> ${contact.contactId}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.fact",
  description: "CRM proposed and confirmed facts",
})
export class CrmFactCommands {
  @Scope("open")
  @Command({ name: "list", description: "List CRM facts" })
  @CommandAccess({ kind: "read", resource: "crm.fact", action: "list", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  list(
    @Option({ flags: "--entity-type <type>", description: "Filter by CRM entity type" }) entityType?: string,
    @Option({ flags: "--entity <id>", description: "Filter by CRM entity id" }) entityId?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "Filter by CRM account" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by CRM opportunity" }) opportunityId?: string,
    @Option({ flags: "--status <status>", description: "proposed|confirmed|rejected|superseded" }) status?: string,
    @Option({ flags: "--key <key>", description: "Filter by fact key" }) key?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching facts to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crm fact list";
    validateEnumOption(op, "--entity-type", entityType, CRM_ENTITY_TYPE_VALUES, asJson);
    validateEnumOption(op, "--status", status, CRM_FACT_STATUS_VALUES, asJson);
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    if (contactRef) assertCanReadCrmContact("crm fact list", contactRef, asJson);
    const page = listCrmFacts({
      entityType,
      entityId,
      contactRef,
      accountId,
      opportunityId,
      status,
      key,
      limit,
      offset,
      readableContactIds: listReadableCrmContactIds(),
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "fact", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--entity-type",
        entityType,
        "--entity",
        entityId,
        "--contact",
        contactRef,
        "--account",
        accountId,
        "--opportunity",
        opportunityId,
        "--status",
        status,
        "--key",
        key,
      ],
    });
    const payload = { total: page.total, pagination, items: page.items, facts: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM facts found.");
      return payload;
    }
    for (const fact of page.items) {
      console.log(`- ${fact.status.padEnd(10)} ${fact.entityType}:${fact.entityId} ${fact.key}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "propose", description: "Propose or confirm a CRM fact" })
  @CommandAccess({ kind: "mutate", resource: "crm.fact", action: "propose", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  propose(
    @Arg("entityType", { description: "CRM entity type" }) entityType: string,
    @Arg("entity", { description: "CRM entity id" }) entityId: string,
    @Arg("key", { description: "Fact key" }) key: string,
    @Arg("value", { description: "JSON value or plain string" }) value: string,
    @Option({ flags: "--contact <contact>", description: "Related contact" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "Related account" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Related opportunity" }) opportunityId?: string,
    @Option({ flags: "--status <status>", description: "proposed|confirmed" }) status?: string,
    @Option({ flags: "--confidence <n>", description: "Confidence between 0 and 1" }) confidence?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated fact writes" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const fact = proposeCrmFact({
      entityType,
      entityId,
      key,
      value: parseJsonValueArg(value),
      contactRef,
      accountId,
      opportunityId,
      status,
      confidence: parseOptionalNumber(confidence, "confidence") ?? undefined,
      idempotencyKey,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "proposed" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact ${fact.status}: ${fact.id} ${fact.key}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "confirm", description: "Confirm a CRM fact" })
  @CommandAccess({ kind: "mutate", resource: "crm.fact", action: "confirm", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  confirm(
    @Arg("fact", { description: "CRM fact ID" }) factId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmFactMutationTarget("crm fact confirm", factId, asJson);
    const fact = confirmCrmFact({ factId, source: "cli", actorType: "user" });
    const payload = { status: "confirmed" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact confirmed: ${fact.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "reject", description: "Reject a CRM fact" })
  @CommandAccess({ kind: "mutate", resource: "crm.fact", action: "reject", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  reject(
    @Arg("fact", { description: "CRM fact ID" }) factId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmFactMutationTarget("crm fact reject", factId, asJson);
    const fact = rejectCrmFact({ factId, source: "cli", actorType: "user" });
    const payload = { status: "rejected" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact rejected: ${fact.id}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.task",
  description: "CRM task mutations",
})
export class CrmTaskCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM task" })
  @CommandAccess({ kind: "read", resource: "crm.task", action: "show", risk: "low" })
  @Returns(crmTaskReturnSchema)
  show(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const task = getCrmTask(taskId);
    if (!task) failCrmTaskNotFound("crm task show", taskId, asJson);
    if (task.contactId && !canReadCrmContact(task.contactId)) {
      failCrmTaskNotFound("crm task show", taskId, asJson);
    }
    const payload = { target: taskId, task: formatCrmTaskForJson(task) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nCRM task: ${task.title}`);
    console.log(`  status: ${task.status}`);
    console.log(`  due: ${task.dueAt ?? "-"}`);
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM relationship task" })
  @CommandAccess({ kind: "mutate", resource: "crm.task", action: "create", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  create(
    @Arg("title", { description: "Task title" }) title: string,
    @Option({ flags: "--contact <contact>", description: "Contact ID or identity" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "CRM opportunity ID" }) opportunityId?: string,
    @Option({ flags: "--due <date>", description: "Due date/time" }) dueAt?: string,
    @Option({ flags: "--priority <priority>", description: "low|normal|high|urgent" }) priority?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--task-type <type>", description: "Task type (e.g. follow_up, commitment, call)" })
    taskType?: string,
    @Option({ flags: "--body <text>", description: "Task body / longer description" }) body?: string,
    @Option({ flags: "--source <source>", description: "Source label (default: cli)" }) source?: string,
    @Option({ flags: "--confidence <n>", description: "Confidence in the task (0.0–1.0)" }) confidence?: string,
    @Option({ flags: "--evidence <json>", description: "Evidence JSON array attached to the task event" })
    evidenceJson?: string,
    @Option({ flags: "--metadata <json>", description: "Metadata JSON object stored on the task" })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated task creation" })
    idempotencyKey?: string,
  ) {
    const evidence = parseOptionalJson(evidenceJson, "--evidence");
    const metadata = parseOptionalJsonObject(metadataJson, "--metadata");
    const confidenceValue = confidence !== undefined ? parseFloatOrFail(confidence, "--confidence") : undefined;
    const task = createCrmTask({
      title,
      contactRef,
      accountId,
      opportunityId,
      dueAt,
      priority,
      taskType,
      body,
      ...parseOwner(owner),
      idempotencyKey,
      source: source ?? "cli",
      actorType: "user",
      confidence: confidenceValue,
      evidence,
      metadata,
    });
    const payload = { status: "created" as const, task: formatCrmTaskForJson(task), changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task created: ${task.id} ${task.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "done", description: "Complete a CRM task" })
  @CommandAccess({ kind: "mutate", resource: "crm.task", action: "done", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  done(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmTaskMutationTarget("crm task done", taskId, asJson);
    const task = completeCrmTask({ taskId, source: "cli", actorType: "user" });
    const payload = { status: "done" as const, task: formatCrmTaskForJson(task), changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task completed: ${task.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "cancel", description: "Cancel a CRM task" })
  @CommandAccess({ kind: "mutate", resource: "crm.task", action: "cancel", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  cancel(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Reason for cancellation (stored in event payload)" })
    reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertCrmTaskMutationTarget("crm task cancel", taskId, asJson);
    const task = cancelCrmTask({ taskId, reason, source: "cli", actorType: "user" });
    const payload = { status: "canceled" as const, task: formatCrmTaskForJson(task), changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task canceled: ${task.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "snooze", description: "Snooze a CRM task to a new due_at" })
  @CommandAccess({ kind: "mutate", resource: "crm.task", action: "snooze", risk: "medium" })
  @Returns(changedEntityReturnSchema)
  snooze(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--until <ts>", description: "New due_at / snoozed_until (ISO timestamp)" }) until?: string,
    @Option({ flags: "--reason <text>", description: "Reason for snoozing" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!until) fail("--until <ts> is required");
    assertCrmTaskMutationTarget("crm task snooze", taskId, asJson);
    validateTimestamp("crm task snooze", "--until", until, asJson);
    const task = snoozeCrmTask({
      taskId,
      snoozedUntil: until,
      source: "cli",
      actorType: "user",
      evidence: reason ? { reason } : undefined,
    });
    const payload = { status: "snoozed" as const, task: formatCrmTaskForJson(task), changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task snoozed until ${until}: ${task.id}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "list", description: "List CRM tasks (all statuses)" })
  @CommandAccess({ kind: "read", resource: "crm.task", action: "list", risk: "low" })
  @Returns(pagedItemsReturnSchema)
  list(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contact?: string,
    @Option({ flags: "--account <account>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by opportunity" }) opportunity?: string,
    @Option({ flags: "--task-type <type>", description: "Filter by task_type" }) taskType?: string,
    @Option({ flags: "--status <status>", description: "Filter by status (open, scheduled, done, canceled, snoozed)" })
    status?: string,
    @Option({ flags: "--due-today", description: "Only tasks whose due_at is today" }) dueToday?: boolean,
    @Option({ flags: "--due-before <ts>", description: "Only tasks with due_at < <ts>" }) dueBefore?: string,
    @Option({ flags: "--due-after <ts>", description: "Only tasks with due_at >= <ts>" }) dueAfter?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching tasks to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crm task list";
    validateEnumOption(op, "--status", status, CRM_TASK_STATUS_VALUES, asJson);
    validateTimestamp(op, "--due-before", dueBefore, asJson);
    validateTimestamp(op, "--due-after", dueAfter, asJson);
    validateNonNegativeInteger(op, "--limit", limit, asJson);
    validateNonNegativeInteger(op, "--offset", offset, asJson);
    const ownerFilter = parseOwner(owner);
    if (contact) assertCanReadCrmContact("crm task list", contact, asJson);
    const page = listCrmTasks({
      ...ownerFilter,
      contactRef: contact,
      accountId: account,
      opportunityId: opportunity,
      taskType,
      status,
      dueToday: Boolean(dueToday),
      dueBefore,
      dueAfter,
      limit,
      offset,
      readableContactIds: listReadableCrmContactIds(),
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "task", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--owner",
        owner,
        "--contact",
        contact,
        "--account",
        account,
        "--opportunity",
        opportunity,
        "--task-type",
        taskType,
        "--status",
        status,
        ...(dueToday ? ["--due-today"] : []),
        "--due-before",
        dueBefore,
        "--due-after",
        dueAfter,
      ],
    });
    const items = page.items.map(formatCrmTaskForJson);
    const payload = { total: page.total, pagination, items, tasks: items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM tasks match the filter.");
      return payload;
    }
    console.log(`\nCRM tasks (${page.items.length} returned of ${page.total}):\n`);
    for (const task of page.items) {
      console.log(
        `  ${task.id}  [${task.status}]  ${task.taskType.padEnd(12)}  due=${task.dueAt ?? "-"}  ${task.title}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }
}

function parseOptionalJson(value: string | undefined, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} must be valid JSON: ${(error as Error).message}`);
  }
}

function parseOptionalJsonObject(value: string | undefined, label: string): Record<string, unknown> | undefined {
  const parsed = parseOptionalJson(value, label);
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseFloatOrFail(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a number`);
  return parsed;
}
