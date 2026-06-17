import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  changedEntityReturnSchema,
  crmBoardReturnSchema,
  crmOpportunityContactsReturnSchema,
  crmOpportunityReturnSchema,
  crmPipelineDetailsReturnSchema,
  crmPipelineReviewReturnSchema,
  crmPipelineStageDetailsReturnSchema,
  crmPipelineValidationReturnSchema,
  crmProfileReturnSchema,
  crmTaskReturnSchema,
  pagedItemsReturnSchema,
} from "./operational-return-schemas.js";
import {
  getPipelineMetadataJsonSchema,
  type PipelineReviewFieldStatus,
  reviewPipelineMetadata,
  validatePipelineMetadata,
} from "../../crm/pipeline-metadata.js";
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
  getContactDetails,
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

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
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
    const vip: Record<string, unknown> = {};
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
    const mr: Record<string, unknown> = {};
    if (flags.messagePrefix !== undefined) mr.prefix = flags.messagePrefix;
    if (flags.messageSuffix !== undefined) mr.suffix = flags.messageSuffix;
    meta.message_rule = mr;
  }

  if (flags.analystTone !== undefined || flags.analystMentions !== undefined || flags.analystAvoid !== undefined) {
    const ag: Record<string, unknown> = {};
    if (flags.analystTone !== undefined) ag.tone = flags.analystTone;
    const mentions = splitCommaList(flags.analystMentions);
    if (mentions) ag.mandatory_mentions = mentions;
    const avoid = splitCommaList(flags.analystAvoid);
    if (avoid) ag.avoid = avoid;
    meta.analyst_guidance = ag;
  }

  if (flags.reguaTags && flags.reguaTags.length > 0) {
    meta.regua_tags = flags.reguaTags.map((raw, i) => {
      const parsed = parseJsonObjectArg(raw);
      if (!parsed) fail(`--regua-tag #${i + 1} must be a non-null JSON object`);
      return parsed;
    });
  }

  const crons = splitCommaList(flags.relatedCrons);
  if (crons) meta.related_crons = crons;
  const triggers = splitCommaList(flags.relatedTriggers);
  if (triggers) meta.related_triggers = triggers;

  return meta;
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
    --producer agent:lead-capture \\
    --consumer agent:salesrep \\
    --versao 1.0.0

  # 2) Rich pipeline ('subscription-renewal') — lifecycle + policies + regua tags
  ravi crm pipeline create subscription-renewal \\
    --objetivo 'Secure recurring subscription renewal before expiry' \\
    --priority-global 2 \\
    --producer agent:billing \\
    --consumer agent:salesrep,agent:dispatcher \\
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

function routeAgentForCrmContact(contactRef: string): string | null {
  const details = getContactDetails(contactRef);
  if (!details) return null;
  if (!cachedRoutes) cachedRoutes = dbListRoutes();
  for (const identity of details.platformIdentities) {
    const value = identity.normalizedPlatformUserId.toLowerCase();
    const match = cachedRoutes.find((route) => route.pattern === value);
    if (match) return match.agent;
  }
  return null;
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

function assertCanReadCrmContact(contactRef: string): void {
  if (canReadCrmContact(contactRef)) return;
  fail(`Contact not found: ${contactRef}`);
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

function visiblePage<T extends object>(page: { total: number; limit: number; offset: number; items: T[] }) {
  if (!isScopeEnforced(getScopeContext())) return page;
  const items = filterCrmRecordsByContact(page.items);
  return {
    ...page,
    total: items.length,
    items,
  };
}

function showCrmContactProfile(contactRef: string, asJson?: boolean) {
  assertCanReadCrmContact(contactRef);
  const profile = getCrmContactProfile(contactRef);
  if (!profile) fail(`Contact not found: ${contactRef}`);
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
  if (!opportunity) fail(`CRM opportunity not found: ${opportunityId}`);
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
  ) {
    const ownerFilter = parseOwner(owner);
    if (contact) assertCanReadCrmContact(contact);
    const page = visiblePage(
      listCrmNextActions({
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
      }),
    );
    const pagination = buildCliOffsetPagination({
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
    const payload = { total: page.total, pagination, items: page.items, actions: page.items };
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
  ) {
    const ownerFilter = parseOwner(owner);
    const page = visiblePage(listCrmContactCards({ ...ownerFilter, lifecycle, limit, offset }));
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "contacts"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--status", lifecycle, "--owner", owner],
    });
    const payload = { total: page.total, pagination, items: page.items, contacts: page.items };
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
  ) {
    const board = filterCrmRecordsByContact(listCrmOpportunityBoard({ pipelineRef: pipeline }));
    const stages = includeEmptyStages
      ? listCrmOpportunityBoardStages(pipeline).map((stage) => ({
          ...stage,
          opportunities: filterCrmRecordsByContact(stage.opportunities),
        }))
      : undefined;
    const payload = stages
      ? { total: board.length, stages, opportunities: board }
      : { total: board.length, opportunities: board };
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
  ) {
    const pipelines = listCrmPipelines({ entityType, includeArchived: Boolean(includeArchived) });
    const page = paginateCliItems(pipelines, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "pipeline", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--entity-type", entityType, ...(includeArchived ? ["--include-archived"] : [])],
    });
    const payload = { total: page.total, pagination, items: page.items, pipelines: page.items };
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
    if (!pipeline) fail(`CRM pipeline not found: ${pipelineRef}`);
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
    description: "Review pipeline metadata against canonical schema (12 fields, ✓/⚠/✗ + suggestions)",
  })
  @CommandAccess({ kind: "read", resource: "crm.pipeline", action: "review", risk: "low" })
  @Returns(crmPipelineReviewReturnSchema)
  review(
    @Arg("pipeline", { description: "CRM pipeline ID or name" }) pipelineRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) fail(`CRM pipeline not found: ${pipelineRef}`);
    const report = reviewPipelineMetadata(
      {
        id: pipeline.pipeline.id,
        name: pipeline.pipeline.name,
        metadata: pipeline.pipeline.metadata ?? {},
      },
      { runtimeStageKeys: pipeline.stages.map((s) => s.key) },
    );
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
    if (report.highSeverityGaps > 0) {
      process.exitCode = 1;
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
    if (!pipelineRef) fail("pipeline argument required (or pass --schema-json)");
    const pipeline = getCrmPipeline(pipelineRef);
    if (!pipeline) fail(`CRM pipeline not found: ${pipelineRef}`);
    const result = validatePipelineMetadata(pipeline.pipeline.metadata ?? {}, {
      runtimeStageKeys: pipeline.stages.map((s) => s.key),
    });
    const payload = {
      pipelineId: pipeline.pipeline.id,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
    };
    if (asJson) {
      printJson(payload);
      if (!result.ok) process.exitCode = 1;
      return payload;
    }
    console.log(`\nValidate: ${pipeline.pipeline.name} (${pipeline.pipeline.id})`);
    console.log(`Result: ${result.ok ? "PASS" : "FAIL"}`);
    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      for (const e of result.errors) {
        console.log(`  ✗ ${e.path}: ${e.message}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log(`\nWarnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w.path}: ${w.message}`);
      }
    }
    if (result.ok && result.warnings.length === 0) {
      console.log("\nNo issues found.");
    }
    if (!result.ok) process.exitCode = 1;
    return payload;
  }

  @Scope("writeContacts")
  @Command({
    name: "create",
    description: "Create a CRM pipeline (with optional declarative metadata)",
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
      description: "Repeatable regua tag JSON (replaces existing list)",
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
    const opportunity = createCrmOpportunity({
      title,
      accountId,
      contactRef,
      pipelineId: pipeline,
      stageKey: stage,
      valueCents: parseOptionalNumber(value, "value") ?? undefined,
      currency,
      ...parseOwner(owner),
      idempotencyKey,
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
  @CommandAccess({ kind: "read", resource: "crm.opportunity", action: "move", risk: "low" })
  @Returns(changedEntityReturnSchema)
  move(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Arg("stage", { description: "Pipeline stage key or ID" }) stageRef: string,
    @Option({ flags: "--lost-reason <text>", description: "Lost reason when moving to lost" }) lostReason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
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
    if (contactRef) assertCanReadCrmContact(contactRef);
    const page = visiblePage(
      listCrmFacts({
        entityType,
        entityId,
        contactRef,
        accountId,
        opportunityId,
        status,
        key,
        limit,
        offset,
      }),
    );
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
  @CommandAccess({ kind: "read", resource: "crm.fact", action: "propose", risk: "low" })
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
  @CommandAccess({ kind: "read", resource: "crm.fact", action: "confirm", risk: "low" })
  @Returns(changedEntityReturnSchema)
  confirm(
    @Arg("fact", { description: "CRM fact ID" }) factId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
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
    if (!task) fail(`CRM task not found: ${taskId}`);
    if (task.contactId && !canReadCrmContact(task.contactId)) fail(`CRM task not found: ${taskId}`);
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
  @CommandAccess({ kind: "read", resource: "crm.task", action: "snooze", risk: "low" })
  @Returns(changedEntityReturnSchema)
  snooze(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--until <ts>", description: "New due_at / snoozed_until (ISO timestamp)" }) until?: string,
    @Option({ flags: "--reason <text>", description: "Reason for snoozing" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!until) fail("--until <ts> is required");
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
    const ownerFilter = parseOwner(owner);
    if (contact) assertCanReadCrmContact(contact);
    const page = visiblePage(
      listCrmTasks({
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
      }),
    );
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
