import { getContext, type ToolContext } from "../cli/context.js";
import { getAgent } from "../router/config.js";
import { getAccountForAgent } from "../router/router-db.js";
import { evaluateFilter, validateFilter } from "../triggers/filter.js";
import { findTriggerTopicCatalogEntry } from "../triggers/topic-catalog.js";
import { dbCreateTrigger, dbListTriggers, dbUpdateTrigger } from "../triggers/triggers-db.js";
import type { Trigger, TriggerInput, TriggerReplySource } from "../triggers/types.js";
import { PAGE_COMMENT_CREATED_MESSAGE, PAGE_COMMENT_CREATED_TOPIC } from "../watch/page-comment.js";

export {
  PAGE_COMMENT_CREATED_EVENT,
  PAGE_COMMENT_CREATED_MESSAGE,
  PAGE_COMMENT_CREATED_TOPIC,
  PAGE_COMMENT_RESOLVED_EVENT,
  PAGE_COMMENT_RESOLVED_TOPIC,
} from "../watch/page-comment.js";

export const PAGE_COMMENT_FOLLOW_COOLDOWN_MS = 30_000;
export const PAGE_COMMENT_CREATED_TEMPLATE_ID = "page-comment-created-default";

export interface PageCommentBinding {
  pageId: string;
  orgId?: string;
  projectId?: string;
}

export interface PageCommentCreator {
  agentId: string;
  accountId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
}

export type PageCommentFollowSkip = "missing_page" | "missing_creator" | "invalid_filter" | "unbound_agent";

export interface PageCommentFollowResult {
  ok: boolean;
  topic: string;
  session: "main";
  filter?: string;
  agentId?: string;
  triggerId?: string;
  reused?: boolean;
  pageId?: string;
  orgId?: string | null;
  projectId?: string | null;
  warning?: string;
  skipped?: PageCommentFollowSkip;
}

export interface PageCommentShipSource {
  site?: Record<string, unknown> | null;
  ensuredSite?: Record<string, unknown> | null;
  publish?: {
    artifact?: unknown;
    site?: unknown;
    publish?: unknown;
    release?: unknown;
  } | null;
  organizationId?: string | null;
  projectId?: string | null;
}

export interface PageCommentFollowDeps {
  createTrigger?: (input: TriggerInput) => Trigger;
  listTriggers?: () => Trigger[];
  updateTrigger?: (id: string, updates: { filter?: string | null }) => Trigger;
  emitTriggersRefresh?: () => Promise<void>;
  getCreator?: () => PageCommentCreator | null;
  agentExists?: (agentId: string) => boolean;
  resolveAccountForAgent?: (agentId: string) => string | undefined;
  buildFilter?: (binding: PageCommentBinding) => string;
}

const PAGE_IDENTITY_PATHS = ["data.payload.pageId", "data.pageId", "data.payload.siteId", "data.siteId"];
const ORG_IDENTITY_PATHS = ["data.payload.orgId", "data.orgId", "data.payload.organizationId", "data.organizationId"];
const PROJECT_IDENTITY_PATHS = ["data.payload.projectId", "data.projectId"];

export function pageCommentTriggerName(pageId: string): string {
  return `page-comment:${pageId}`;
}

export function pageCommentFilter(binding: PageCommentBinding): string {
  const parts = [quotedEquals(PAGE_IDENTITY_PATHS, binding.pageId)];
  if (binding.orgId) parts.push(quotedEquals(ORG_IDENTITY_PATHS, binding.orgId));
  if (binding.projectId) parts.push(quotedEquals(PROJECT_IDENTITY_PATHS, binding.projectId));
  return parts.join(" && ");
}

export function pageCommentMatchesEvent(binding: PageCommentBinding, data: unknown): boolean {
  const filter = pageCommentFilter(binding);
  if (!validateFilter(filter).ok) return false;
  return evaluateFilter(filter, data);
}

export function pageCommentBindingFromShip(input: PageCommentShipSource): PageCommentBinding | null {
  const publishSite = objectValue(input.publish?.site);
  const publishRecord = objectValue(input.publish?.publish);
  const release = objectValue(input.publish?.release);
  const artifact = objectValue(input.publish?.artifact);
  const site = input.site ?? null;
  const ensured = input.ensuredSite ?? null;

  const pageId =
    idFrom(publishSite, "id") ??
    idFrom(publishRecord, "siteId") ??
    idFrom(release, "siteId") ??
    idFrom(ensured, "id") ??
    idFrom(site, "id");
  if (!pageId) return null;

  const orgId =
    cleanId(input.organizationId) ??
    idFrom(site, "organizationId") ??
    idFrom(site, "orgId") ??
    idFrom(publishSite, "organizationId") ??
    idFrom(publishSite, "orgId");
  const projectId =
    idFrom(publishSite, "projectId") ??
    idFrom(artifact, "projectId") ??
    idFrom(publishRecord, "projectId") ??
    idFrom(release, "projectId") ??
    idFrom(site, "projectId") ??
    cleanId(input.projectId);

  return {
    pageId,
    ...(orgId ? { orgId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export function pageCommentCreatorFromContext(readContext?: () => ToolContext | undefined): PageCommentCreator | null {
  const ctx = (readContext ?? getContext)();
  const agentId = cleanId(ctx?.agentId) ?? cleanId(process.env.RAVI_AGENT_ID);
  if (!agentId) return null;
  const source =
    ctx?.source?.channel && ctx.source.accountId && ctx.source.chatId
      ? {
          channel: ctx.source.channel,
          accountId: ctx.source.accountId,
          chatId: ctx.source.chatId,
          ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}),
        }
      : undefined;
  return {
    agentId,
    accountId: ctx?.source?.accountId,
    sessionName: ctx?.sessionName,
    sessionKey: ctx?.sessionKey,
    source,
  };
}

export function buildPageCommentTriggerInput(binding: PageCommentBinding, creator: PageCommentCreator): TriggerInput {
  const filter = pageCommentFilter(binding);
  const catalog = findTriggerTopicCatalogEntry(PAGE_COMMENT_CREATED_TOPIC);
  const template = catalog?.messageTemplate?.template ?? PAGE_COMMENT_CREATED_MESSAGE;
  return {
    name: pageCommentTriggerName(binding.pageId),
    topic: PAGE_COMMENT_CREATED_TOPIC,
    message: template,
    messageSource: catalog?.messageTemplate ? "catalog" : "manual",
    messageTemplateId: catalog?.messageTemplate?.id ?? PAGE_COMMENT_CREATED_TEMPLATE_ID,
    agentId: creator.agentId,
    accountId: creator.accountId ?? creator.source?.accountId,
    replySession: creator.sessionName ?? creator.sessionKey,
    replySource: creator.source,
    session: "main",
    cooldownMs: PAGE_COMMENT_FOLLOW_COOLDOWN_MS,
    filter,
  };
}

export function findExistingPageCommentTrigger(pageId: string, triggers: Trigger[]): Trigger | undefined {
  const name = pageCommentTriggerName(pageId);
  return triggers.find((trigger) => trigger.name === name);
}

export async function ensurePageCommentFollow(
  input: PageCommentShipSource,
  deps: PageCommentFollowDeps = {},
): Promise<PageCommentFollowResult> {
  const binding = pageCommentBindingFromShip(input);
  const scope = {
    pageId: binding?.pageId,
    orgId: binding?.orgId ?? null,
    projectId: binding?.projectId ?? null,
  };
  if (!binding) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      ...scope,
      skipped: "missing_page",
      warning: "Page comment trigger skipped: Console did not return a stable page id.",
    };
  }

  const creator = (deps.getCreator ?? (() => pageCommentCreatorFromContext()))();
  if (!creator) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      filter: safeFilter(binding, deps),
      pageId: binding.pageId,
      orgId: binding.orgId ?? null,
      projectId: binding.projectId ?? null,
      skipped: "missing_creator",
      warning: "Page comment trigger skipped: no creator agent in the current session.",
    };
  }

  try {
    const ensured = await ensurePageCommentTrigger(binding, creator, deps);
    if (!ensured.ok) {
      return {
        ok: false,
        topic: PAGE_COMMENT_CREATED_TOPIC,
        session: "main",
        filter: ensured.filter,
        agentId: creator.agentId,
        pageId: binding.pageId,
        orgId: binding.orgId ?? null,
        projectId: binding.projectId ?? null,
        skipped: "invalid_filter",
        warning: ensured.warning,
      };
    }

    const boundAgentId = ensured.trigger.agentId ?? creator.agentId;
    const agentExists = (deps.agentExists ?? ((agentId: string) => getAgent(agentId) != null))(boundAgentId);
    if (!agentExists) {
      return {
        ok: false,
        topic: PAGE_COMMENT_CREATED_TOPIC,
        session: "main",
        filter: ensured.trigger.filter,
        agentId: boundAgentId,
        triggerId: ensured.trigger.id,
        reused: ensured.reused,
        pageId: binding.pageId,
        orgId: binding.orgId ?? null,
        projectId: binding.projectId ?? null,
        skipped: "unbound_agent",
        warning: `Page comment trigger saved for agent ${boundAgentId}, but that agent does not exist (unbound_agent). It will not wake until the agent exists.`,
      };
    }

    return {
      ok: true,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      filter: ensured.trigger.filter,
      agentId: boundAgentId,
      triggerId: ensured.trigger.id,
      reused: ensured.reused,
      pageId: binding.pageId,
      orgId: binding.orgId ?? null,
      projectId: binding.projectId ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      agentId: creator.agentId,
      pageId: binding.pageId,
      orgId: binding.orgId ?? null,
      projectId: binding.projectId ?? null,
      warning: `Page comment trigger failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function ensurePageCommentTrigger(
  binding: PageCommentBinding,
  creator: PageCommentCreator,
  deps: PageCommentFollowDeps = {},
): Promise<{ ok: true; trigger: Trigger; reused: boolean } | { ok: false; filter: string; warning: string }> {
  const buildFilter = deps.buildFilter ?? pageCommentFilter;
  const filter = buildFilter(binding);
  const validation = validateFilter(filter);
  if (!validation.ok) {
    return {
      ok: false,
      filter,
      warning: `Page comment trigger skipped: filter is invalid and was not saved (${validation.error}).`,
    };
  }

  const listTriggers = deps.listTriggers ?? dbListTriggers;
  const existing = findExistingPageCommentTrigger(binding.pageId, listTriggers());
  if (existing) {
    const trigger = await repairInvalidFilter(existing, filter, deps);
    if (trigger.filter !== existing.filter) {
      try {
        await (deps.emitTriggersRefresh ?? defaultEmitTriggersRefresh)();
      } catch {
        // The repaired filter is durable; the daemon reloads on the next refresh or restart.
      }
    }
    return { ok: true, trigger, reused: true };
  }

  const resolved: PageCommentCreator = { ...creator };
  if (!resolved.accountId && resolved.agentId) {
    try {
      resolved.accountId = (deps.resolveAccountForAgent ?? getAccountForAgent)(resolved.agentId);
    } catch {
      // Account lookup is optional; trigger fire-time resolution still works.
    }
  }

  const input = buildPageCommentTriggerInput(binding, resolved);
  input.filter = filter;
  const validationAfterBuild = validateFilter(input.filter);
  if (!validationAfterBuild.ok) {
    return {
      ok: false,
      filter: input.filter ?? filter,
      warning: `Page comment trigger skipped: filter is invalid and was not saved (${validationAfterBuild.error}).`,
    };
  }

  const createTrigger = deps.createTrigger ?? dbCreateTrigger;
  const trigger = createTrigger(input);
  try {
    await (deps.emitTriggersRefresh ?? defaultEmitTriggersRefresh)();
  } catch {
    // Trigger is durable; the daemon reloads on the next refresh or restart.
  }
  return { ok: true, trigger, reused: false };
}

async function repairInvalidFilter(
  existing: Trigger,
  canonical: string,
  deps: PageCommentFollowDeps,
): Promise<Trigger> {
  if (!existing.filter || validateFilter(existing.filter).ok) return existing;
  if (!validateFilter(canonical).ok) return existing;
  const updateTrigger = deps.updateTrigger ?? ((id, updates) => dbUpdateTrigger(id, updates));
  return updateTrigger(existing.id, { filter: canonical });
}

function safeFilter(binding: PageCommentBinding, deps: PageCommentFollowDeps): string | undefined {
  const filter = (deps.buildFilter ?? pageCommentFilter)(binding);
  return validateFilter(filter).ok ? filter : undefined;
}

function quotedEquals(paths: string[], value: string): string {
  const quoted = JSON.stringify(value);
  const clauses = paths.map((path) => `${path} == ${quoted}`);
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join(" || ")})`;
}

function idFrom(record: Record<string, unknown> | null, key: string): string | undefined {
  return cleanId(record?.[key]);
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function defaultEmitTriggersRefresh(): Promise<void> {
  const { nats } = await import("../nats.js");
  await nats.emit("ravi.triggers.refresh", {});
}
