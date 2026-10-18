import { getContext, type ToolContext } from "../cli/context.js";
import { getAgent } from "../router/config.js";
import { getAccountForAgent } from "../router/router-db.js";
import { evaluateFilter, validateFilter } from "../triggers/filter.js";
import { findTriggerTopicCatalogEntry } from "../triggers/topic-catalog.js";
import { dbCreateTrigger, dbDeleteTrigger, dbListTriggers, dbUpdateTrigger } from "../triggers/triggers-db.js";
import type { Trigger, TriggerInput, TriggerReplySource } from "../triggers/types.js";
import { PAGE_COMMENT_CREATED_MESSAGE, PAGE_COMMENT_CREATED_TOPIC } from "../watch/page-comment.js";

export {
  PAGE_COMMENT_CREATED_EVENT,
  PAGE_COMMENT_CREATED_MESSAGE,
  PAGE_COMMENT_CREATED_TOPIC,
  PAGE_COMMENT_RESOLVED_EVENT,
  PAGE_COMMENT_RESOLVED_TOPIC,
} from "../watch/page-comment.js";

/** Every comment is its own event: a cooldown would drop the second comment of a burst. */
export const PAGE_COMMENT_FOLLOW_COOLDOWN_MS = 0;
export const PAGE_COMMENT_CREATED_TEMPLATE_ID = "page-comment-created-default";

/** One shipped route: the site id Console returned plus the route path. */
export interface PageCommentBinding {
  pageId: string;
  routePath: string;
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
  /** The route's trigger existed for another session or agent and now wakes this one. */
  rebound?: boolean;
  /** Session the comments wake (the one that shipped). */
  replySession?: string;
  /** Id of the old per-site trigger this ship replaced. */
  replacedTriggerId?: string;
  pageId?: string;
  routePath?: string;
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
  /** Route the ship published (`--route`, default `/`). */
  route?: string | null;
}

export type PageCommentTriggerUpdate = Partial<
  Pick<Trigger, "agentId" | "accountId" | "replySource" | "cooldownMs" | "message" | "messageSource">
> & { filter?: string | null; replySession?: string | null; messageTemplateId?: string | null };

export interface PageCommentFollowDeps {
  createTrigger?: (input: TriggerInput) => Trigger;
  listTriggers?: () => Trigger[];
  updateTrigger?: (id: string, updates: PageCommentTriggerUpdate) => Trigger;
  deleteTrigger?: (id: string) => boolean;
  emitTriggersRefresh?: () => Promise<void>;
  getCreator?: () => PageCommentCreator | null;
  agentExists?: (agentId: string) => boolean;
  resolveAccountForAgent?: (agentId: string) => string | undefined;
  buildFilter?: (binding: PageCommentBinding) => string;
}

const PAGE_IDENTITY_PATHS = ["data.payload.pageId", "data.pageId", "data.payload.siteId", "data.siteId"];
const ORG_IDENTITY_PATHS = ["data.payload.orgId", "data.orgId", "data.payload.organizationId", "data.organizationId"];
const PROJECT_IDENTITY_PATHS = ["data.payload.projectId", "data.projectId"];
const ROUTE_IDENTITY_PATHS = ["data.payload.routePath", "data.routePath"];

/** One trigger per shipped route; the session that shipped the route last owns it. */
export function pageCommentTriggerName(pageId: string, routePath: string): string {
  return `page-comment:${pageId}:${routePath}`;
}

/** Name of the v0 trigger, one per site, that the per-route triggers replace. */
export function legacyPageCommentTriggerName(pageId: string): string {
  return `page-comment:${pageId}`;
}

/** Route path as Console stores it: leading slash, no trailing slash except for `/`. */
export function normalizeCommentRoutePath(route: string | null | undefined): string {
  const trimmed = route?.trim() ?? "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const stripped = withSlash.replace(/\/+$/g, "");
  return stripped || "/";
}

export function pageCommentFilter(binding: PageCommentBinding): string {
  const parts = [
    quotedEquals(PAGE_IDENTITY_PATHS, binding.pageId),
    quotedEquals(ROUTE_IDENTITY_PATHS, binding.routePath),
  ];
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
    routePath: normalizeCommentRoutePath(input.route),
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
    name: pageCommentTriggerName(binding.pageId, binding.routePath),
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

export function findExistingPageCommentTrigger(binding: PageCommentBinding, triggers: Trigger[]): Trigger | undefined {
  const name = pageCommentTriggerName(binding.pageId, binding.routePath);
  return triggers.find((trigger) => trigger.name === name);
}

export async function ensurePageCommentFollow(
  input: PageCommentShipSource,
  deps: PageCommentFollowDeps = {},
): Promise<PageCommentFollowResult> {
  const binding = pageCommentBindingFromShip(input);
  if (!binding) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      orgId: null,
      projectId: null,
      skipped: "missing_page",
      warning: "Page comment trigger skipped: Console did not return a stable page id.",
    };
  }
  const scope = {
    pageId: binding.pageId,
    routePath: binding.routePath,
    orgId: binding.orgId ?? null,
    projectId: binding.projectId ?? null,
  };

  const creator = (deps.getCreator ?? (() => pageCommentCreatorFromContext()))();
  if (!creator) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      filter: safeFilter(binding, deps),
      ...scope,
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
        ...scope,
        skipped: "invalid_filter",
        warning: ensured.warning,
      };
    }

    const boundAgentId = ensured.trigger.agentId ?? creator.agentId;
    const bound = {
      filter: ensured.trigger.filter,
      agentId: boundAgentId,
      triggerId: ensured.trigger.id,
      reused: ensured.reused,
      ...(ensured.rebound ? { rebound: true } : {}),
      ...(ensured.trigger.replySession ? { replySession: ensured.trigger.replySession } : {}),
      ...(ensured.replacedTriggerId ? { replacedTriggerId: ensured.replacedTriggerId } : {}),
      ...scope,
    };
    const agentExists = (deps.agentExists ?? ((agentId: string) => getAgent(agentId) != null))(boundAgentId);
    if (!agentExists) {
      return {
        ok: false,
        topic: PAGE_COMMENT_CREATED_TOPIC,
        session: "main",
        ...bound,
        skipped: "unbound_agent",
        warning: `Page comment trigger saved for agent ${boundAgentId}, but that agent does not exist (unbound_agent). It will not wake until the agent exists.`,
      };
    }

    return { ok: true, topic: PAGE_COMMENT_CREATED_TOPIC, session: "main", ...bound };
  } catch (error) {
    return {
      ok: false,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      session: "main",
      agentId: creator.agentId,
      ...scope,
      warning: `Page comment trigger failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type PageCommentTriggerOutcome =
  | { ok: true; trigger: Trigger; reused: boolean; rebound: boolean; replacedTriggerId?: string }
  | { ok: false; filter: string; warning: string };

/**
 * Creates the route's trigger, or points the existing one at the session that
 * shipped now: comments on a route wake the session that published it last.
 * The v0 per-site trigger for the same site is removed so a comment does not
 * wake twice.
 */
export async function ensurePageCommentTrigger(
  binding: PageCommentBinding,
  creator: PageCommentCreator,
  deps: PageCommentFollowDeps = {},
): Promise<PageCommentTriggerOutcome> {
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

  const triggers = (deps.listTriggers ?? dbListTriggers)();
  const replacedTriggerId = removeLegacySiteTrigger(binding.pageId, triggers, deps);
  const existing = findExistingPageCommentTrigger(binding, triggers);

  let trigger: Trigger;
  let rebound = false;
  let changed = replacedTriggerId !== undefined;
  if (existing) {
    const updates = rebindUpdates(existing, input);
    rebound = updates.agentId !== undefined || updates.replySession !== undefined;
    const repairedFilter = repairedFilterFor(existing, filter);
    if (repairedFilter) updates.filter = repairedFilter;
    if (Object.keys(updates).length > 0) {
      trigger = (deps.updateTrigger ?? ((id, next) => dbUpdateTrigger(id, next)))(existing.id, updates);
      changed = true;
    } else {
      trigger = existing;
    }
  } else {
    trigger = (deps.createTrigger ?? dbCreateTrigger)(input);
    changed = true;
  }

  if (changed) {
    try {
      await (deps.emitTriggersRefresh ?? defaultEmitTriggersRefresh)();
    } catch {
      // Trigger rows are durable; the daemon reloads on the next refresh or restart.
    }
  }
  return {
    ok: true,
    trigger,
    reused: Boolean(existing),
    rebound,
    ...(replacedTriggerId ? { replacedTriggerId } : {}),
  };
}

/** The fields that move a route's trigger to the session that shipped now. */
function rebindUpdates(existing: Trigger, input: TriggerInput): PageCommentTriggerUpdate {
  const updates: PageCommentTriggerUpdate = {};
  const sameOwner =
    existing.agentId === input.agentId && (existing.replySession ?? undefined) === (input.replySession ?? undefined);
  if (!sameOwner) {
    updates.agentId = input.agentId;
    updates.replySession = input.replySession ?? null;
    if (input.accountId !== existing.accountId) updates.accountId = input.accountId;
    if (JSON.stringify(input.replySource ?? null) !== JSON.stringify(existing.replySource ?? null)) {
      updates.replySource = input.replySource;
    }
  }
  if (existing.cooldownMs !== PAGE_COMMENT_FOLLOW_COOLDOWN_MS) updates.cooldownMs = PAGE_COMMENT_FOLLOW_COOLDOWN_MS;
  return updates;
}

/** A stored invalid filter becomes the canonical one; a valid custom filter is left alone. */
function repairedFilterFor(existing: Trigger, canonical: string): string | undefined {
  if (!existing.filter || validateFilter(existing.filter).ok) return undefined;
  return canonical;
}

function removeLegacySiteTrigger(pageId: string, triggers: Trigger[], deps: PageCommentFollowDeps): string | undefined {
  const legacyName = legacyPageCommentTriggerName(pageId);
  const legacy = triggers.find((trigger) => trigger.name === legacyName);
  if (!legacy) return undefined;
  (deps.deleteTrigger ?? dbDeleteTrigger)(legacy.id);
  return legacy.id;
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
