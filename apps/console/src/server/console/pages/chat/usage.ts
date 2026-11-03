import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  usageEventTypes,
  usageMetricKeys,
  type UsageEventRecordInput,
} from "@/server/console/billing/usage-metering";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  estimatePageChatCostUsd,
  evaluatePageChatAllowance,
  guestPageChatLimits,
  parsePageChatLimits,
  PAGE_CHAT_DEFAULT_LIMITS,
  type PageChatAllowance,
  type PageChatLimits,
  VOICE_USD_PER_SECOND,
} from "./limits";

export const PAGE_CHAT_FEATURE_KEY = "console.pages.chat";

export type PageChatEndReason = "viewer_closed" | "limit_reached" | "start_failed" | "disconnected" | "error";

/**
 * What the Pages serving plane reports when a conversation ends. Raw provider
 * facts stop here: the events built from it use Ravi metric keys only, and the
 * model name stays in internal metadata.
 */
export type PageChatSessionReport = {
  organizationId: string;
  projectId?: string | null;
  siteId?: string | null;
  releaseId?: string | null;
  routeId?: string | null;
  chatSessionId: string;
  viewerUserId: string;
  requestId: string;
  endedAt: Date;
  endReason: PageChatEndReason;
  voiceSeconds: number;
  /** False when the provider's final usage never arrived and seconds come from the session clock. */
  usageComplete: boolean;
  model?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Calls per tool name, e.g. { "page.read": 3, "bases.query": 1 }. */
  toolCalls?: Record<string, number>;
};

export function buildPageChatSessionUsageEvents(report: PageChatSessionReport): UsageEventRecordInput[] {
  const cost = estimatePageChatCostUsd(report);
  const base = {
    organizationId: report.organizationId,
    projectId: report.projectId ?? null,
    siteId: report.siteId ?? null,
    releaseId: report.releaseId ?? null,
    routeId: report.routeId ?? null,
    artifactId: null,
    artifactVersionId: null,
    assetId: null,
    publishId: null,
    source: "pages_chat",
    eventType: usageEventTypes.pagesChatSessionClosed,
    requestId: report.requestId,
    occurredAt: report.endedAt,
  };
  const dimensionsJson: JsonRecord = {
    service: "pages",
    object: "chat_session",
    chatSessionId: report.chatSessionId,
    viewerUserId: report.viewerUserId,
    endReason: report.endReason,
  };
  const metadataJson: JsonRecord = report.model ? { model: report.model } : {};
  const key = (metricKey: string) => `${usageEventTypes.pagesChatSessionClosed}:${report.chatSessionId}:${metricKey}`;
  const event = (
    metricKey: string,
    quantity: number,
    unit: string,
    measurementsJson: JsonRecord = {},
  ): UsageEventRecordInput => ({
    ...base,
    metricKey,
    quantity: decimal(quantity),
    unit,
    dimensionsJson,
    measurementsJson,
    evidenceJson: { usageComplete: report.usageComplete },
    metadataJson,
    idempotencyKey: key(metricKey),
  });

  const events = [
    event(usageMetricKeys.pagesChatSessions, 1, "count", {
      estimatedCostUsd: cost.usd,
      estimatedVoiceCostUsd: cost.voiceUsd,
      estimatedModelCostUsd: cost.modelUsd,
      estimatedCostComplete: cost.complete,
      priceVersion: cost.priceVersion,
    }),
    event(usageMetricKeys.pagesChatVoiceSeconds, report.voiceSeconds, "seconds"),
  ];

  const tokens: Array<[string, number | undefined]> = [
    [usageMetricKeys.pagesChatModelInputTokens, report.inputTokens],
    [usageMetricKeys.pagesChatModelCachedInputTokens, report.cachedInputTokens],
    [usageMetricKeys.pagesChatModelOutputTokens, report.outputTokens],
  ];
  for (const [metricKey, quantity] of tokens) {
    if (quantity && quantity > 0) events.push(event(metricKey, quantity, "tokens"));
  }

  const toolCalls = Object.entries(report.toolCalls ?? {}).filter(([, count]) => count > 0);
  const totalToolCalls = toolCalls.reduce((sum, [, count]) => sum + count, 0);
  if (totalToolCalls > 0) {
    events.push(event(usageMetricKeys.pagesChatToolCalls, totalToolCalls, "count", { byTool: Object.fromEntries(toolCalls) }));
  }

  return events;
}

export async function recordPageChatSession(report: PageChatSessionReport): Promise<void> {
  await db.insert(schema.usageEvents).values(buildPageChatSessionUsageEvents(report)).onConflictDoNothing();
}

export type PageChatSessionStart = {
  organizationId: string;
  projectId: string;
  siteId: string;
  releaseId: string | null;
  routeId: string | null;
  chatSessionId: string;
  viewerUserId: string;
  requestId: string;
  startedAt: Date;
  sessionMaxSeconds: number;
};

/**
 * The marker an authorized conversation leaves when it opens. It carries a
 * zero quantity, so billing sums are unchanged; it exists so concurrency can
 * be counted as "started and not yet closed".
 */
export function buildPageChatSessionStartedEvent(start: PageChatSessionStart): UsageEventRecordInput {
  return {
    organizationId: start.organizationId,
    projectId: start.projectId,
    siteId: start.siteId,
    releaseId: start.releaseId,
    routeId: start.routeId,
    artifactId: null,
    artifactVersionId: null,
    assetId: null,
    publishId: null,
    source: "pages_chat",
    eventType: usageEventTypes.pagesChatSessionStarted,
    metricKey: usageMetricKeys.pagesChatSessions,
    quantity: "0",
    unit: "count",
    dimensionsJson: {
      service: "pages",
      object: "chat_session",
      chatSessionId: start.chatSessionId,
      viewerUserId: start.viewerUserId,
    },
    measurementsJson: { sessionMaxSeconds: start.sessionMaxSeconds },
    evidenceJson: {},
    metadataJson: {},
    requestId: start.requestId,
    idempotencyKey: `${usageEventTypes.pagesChatSessionStarted}:${start.chatSessionId}`,
    occurredAt: start.startedAt,
  };
}

export async function recordPageChatSessionStarted(start: PageChatSessionStart): Promise<void> {
  await db.insert(schema.usageEvents).values(buildPageChatSessionStartedEvent(start)).onConflictDoNothing();
}

/**
 * Seconds after which an unclosed conversation stops counting as open. A
 * session cannot outlive its cap, so a start older than the longest cap plus
 * this grace was lost without a report, not still running.
 */
export const PAGE_CHAT_OPEN_SESSION_GRACE_SECONDS = 120;

export type OpenPageChatSessions = {
  /** Conversations in the organization that started recently and have not reported their close. */
  count: number;
  /** Seconds those conversations may still bill: each one's allowed duration. */
  orgReservedSeconds: number;
  /** The same, for one viewer's conversations. */
  viewerReservedSeconds: number;
};

/**
 * Open conversations and the voice time they hold. A start that has not
 * closed counts at its full allowed duration, so parallel conversations
 * cannot each get the whole remaining budget or day.
 */
export async function summarizeOpenPageChatSessions(input: {
  organizationId: string;
  viewerUserId?: string;
  sessionMaxSeconds: number;
  now?: Date;
}): Promise<OpenPageChatSessions> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.sessionMaxSeconds + PAGE_CHAT_OPEN_SESSION_GRACE_SECONDS) * 1000);
  const closed = sql`EXISTS (
    SELECT 1 FROM ${schema.usageEvents} AS closed
    WHERE closed.organization_id = ${schema.usageEvents.organizationId}
      AND closed.event_type = ${usageEventTypes.pagesChatSessionClosed}
      AND closed.metric_key = ${usageMetricKeys.pagesChatSessions}
      AND closed.dimensions_json->>'chatSessionId' = ${schema.usageEvents.dimensionsJson}->>'chatSessionId'
  )`;
  const reserved = sql`COALESCE((${schema.usageEvents.measurementsJson}->>'sessionMaxSeconds')::numeric, ${input.sessionMaxSeconds})`;
  const isViewer = sql`${schema.usageEvents.dimensionsJson}->>'viewerUserId' = ${input.viewerUserId ?? ""}`;
  const [row] = await db
    .select({
      open: sql<string>`COUNT(*)`,
      orgSeconds: sql<string>`COALESCE(SUM(${reserved}), 0)`,
      viewerSeconds: sql<string>`COALESCE(SUM(CASE WHEN ${isViewer} THEN ${reserved} ELSE 0 END), 0)`,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.organizationId, input.organizationId),
        eq(schema.usageEvents.eventType, usageEventTypes.pagesChatSessionStarted),
        gte(schema.usageEvents.occurredAt, since),
        sql`NOT ${closed}`,
      ),
    );
  return {
    count: Number(row?.open ?? 0),
    orgReservedSeconds: Number(row?.orgSeconds ?? 0),
    viewerReservedSeconds: input.viewerUserId ? Number(row?.viewerSeconds ?? 0) : 0,
  };
}

/** Conversations in the organization that started recently and have not reported their close. */
export async function countOpenPageChatSessions(input: {
  organizationId: string;
  sessionMaxSeconds: number;
  now?: Date;
}): Promise<number> {
  return (await summarizeOpenPageChatSessions(input)).count;
}

/** Who opens the conversation: an org member with a role, or a guest given pages of the site (no role). */
export type PageChatAllowanceViewer = { kind: "member"; role: string } | { kind: "guest"; userId: string };

/** What the allowance reads from the database; injectable for tests. */
export type PageChatAllowanceFacts = {
  entitlementValueJson: Record<string, unknown> | null;
  orgMonthSpentUsd: number;
  viewerDaySeconds: number;
};

export type PageChatAllowanceDeps = {
  featureAccess?: typeof getConsoleFeatureAccessForOrganizationRole;
  readFacts?: (input: { organizationId: string; viewerUserId: string; now: Date }) => Promise<PageChatAllowanceFacts>;
};

/**
 * Whether `viewerUserId` may open a conversation in `organizationId` now, and
 * for how long. `openSessions` is the organization's open conversations, or a
 * function of its limits that reads them (see summarizeOpenPageChatSessions);
 * their reserved time counts against the budget and the viewer's day.
 *
 * A member is checked by role (`viewerRole`). A guest (`viewer.kind:
 * "guest"`) has no role: the feature is checked at the organization level and
 * the guest's day is capped at PAGE_CHAT_GUEST_DAILY_SECONDS_CAP.
 */
export async function resolvePageChatAllowance(
  input: {
    organizationId: string;
    viewerUserId: string;
    viewerRole?: string;
    viewer?: PageChatAllowanceViewer;
    openSessions: OpenPageChatSessions | ((limits: PageChatLimits) => Promise<OpenPageChatSessions>);
    now?: Date;
  },
  deps: PageChatAllowanceDeps = {},
): Promise<PageChatAllowance> {
  const now = input.now ?? new Date();
  const featureAccess = deps.featureAccess ?? getConsoleFeatureAccessForOrganizationRole;
  const guest = input.viewer?.kind === "guest";
  const role = input.viewer?.kind === "member" ? input.viewer.role : input.viewerRole;
  let featureOn: boolean;
  if (guest) {
    const access = await featureAccess({ organizationId: input.organizationId, role: "owner" });
    featureOn = Boolean(access.byKey[PAGE_CHAT_FEATURE_KEY]?.available);
  } else if (role) {
    const access = await featureAccess({ organizationId: input.organizationId, role });
    featureOn = Boolean(access.byKey[PAGE_CHAT_FEATURE_KEY]?.enabled);
  } else {
    featureOn = false;
  }
  if (!featureOn) {
    return { allowed: false, reason: "feature_unavailable", limits: PAGE_CHAT_DEFAULT_LIMITS };
  }

  const facts = await (deps.readFacts ?? readPageChatAllowanceFacts)({
    organizationId: input.organizationId,
    viewerUserId: input.viewerUserId,
    now,
  });
  const orgLimits = parsePageChatLimits(facts.entitlementValueJson);
  const limits = guest ? guestPageChatLimits(orgLimits) : orgLimits;
  const open = typeof input.openSessions === "function" ? await input.openSessions(limits) : input.openSessions;
  return evaluatePageChatAllowance({
    limits,
    orgMonthSpentUsd: facts.orgMonthSpentUsd + open.orgReservedSeconds * VOICE_USD_PER_SECOND,
    viewerDaySeconds: facts.viewerDaySeconds + open.viewerReservedSeconds,
    openOrgSessions: open.count,
  });
}

/** The entitlement value, the organization's spend this UTC month and the viewer's voice seconds today. */
export async function readPageChatAllowanceFacts(input: {
  organizationId: string;
  viewerUserId: string;
  now: Date;
}): Promise<PageChatAllowanceFacts> {
  const { now } = input;
  const [entitlement] = await db
    .select({ valueJson: schema.entitlements.valueJson })
    .from(schema.entitlements)
    .where(and(eq(schema.entitlements.organizationId, input.organizationId), eq(schema.entitlements.key, PAGE_CHAT_FEATURE_KEY)))
    .limit(1);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [[spend], [viewer]] = await Promise.all([
    db
      .select({
        usd: sql<string>`COALESCE(SUM((${schema.usageEvents.measurementsJson}->>'estimatedCostUsd')::numeric), 0)`,
      })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, input.organizationId),
          // Voice and text share the budget: text turns carry their cost on `pages.chat.text_turns`.
          inArray(schema.usageEvents.metricKey, [usageMetricKeys.pagesChatSessions, usageMetricKeys.pagesChatTextTurns]),
          gte(schema.usageEvents.occurredAt, monthStart),
        ),
      ),
    db
      .select({ seconds: sql<string>`COALESCE(SUM(${schema.usageEvents.quantity}), 0)` })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, input.organizationId),
          eq(schema.usageEvents.metricKey, usageMetricKeys.pagesChatVoiceSeconds),
          sql`${schema.usageEvents.dimensionsJson}->>'viewerUserId' = ${input.viewerUserId}`,
          gte(schema.usageEvents.occurredAt, dayStart),
        ),
      ),
  ]);

  return {
    entitlementValueJson: entitlement?.valueJson ?? null,
    orgMonthSpentUsd: Number(spend?.usd ?? 0),
    viewerDaySeconds: Number(viewer?.seconds ?? 0),
  };
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return (Math.round(value * 1000) / 1000).toString();
}

/** What the Pages Worker sends when a conversation ends; ids come from the started marker, not from here. */
export const pageChatCloseReportSchema = z
  .object({
    chatSessionId: z.string().uuid(),
    endedAt: z.string().datetime().optional(),
    endReason: z.enum(["viewer_closed", "limit_reached", "start_failed", "disconnected", "error"]),
    voiceSeconds: z.number().min(0).max(24 * 3600),
    usageComplete: z.boolean(),
    model: z.string().min(1).max(100).nullable().optional(),
    inputTokens: z.number().int().min(0).optional(),
    cachedInputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    toolCalls: z.record(z.string().max(64), z.number().int().min(0)).optional(),
  })
  .strict();

export type PageChatCloseReport = z.infer<typeof pageChatCloseReportSchema>;

/**
 * Records a conversation's close against the organization, site and viewer
 * its started marker holds, so the reporter cannot bill another org. Returns
 * false when no conversation with that id was ever authorized.
 */
export async function recordPageChatClose(input: { report: PageChatCloseReport; requestId: string }): Promise<boolean> {
  const [started] = await db
    .select({
      organizationId: schema.usageEvents.organizationId,
      projectId: schema.usageEvents.projectId,
      siteId: schema.usageEvents.siteId,
      releaseId: schema.usageEvents.releaseId,
      routeId: schema.usageEvents.routeId,
      dimensionsJson: schema.usageEvents.dimensionsJson,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.eventType, usageEventTypes.pagesChatSessionStarted),
        eq(schema.usageEvents.idempotencyKey, `${usageEventTypes.pagesChatSessionStarted}:${input.report.chatSessionId}`),
      ),
    )
    .limit(1);
  const viewerUserId = started?.dimensionsJson?.viewerUserId;
  if (!started || typeof viewerUserId !== "string") return false;

  await recordPageChatSession({
    organizationId: started.organizationId,
    projectId: started.projectId,
    siteId: started.siteId,
    releaseId: started.releaseId,
    routeId: started.routeId,
    chatSessionId: input.report.chatSessionId,
    viewerUserId,
    requestId: input.requestId,
    endedAt: input.report.endedAt ? new Date(input.report.endedAt) : new Date(),
    endReason: input.report.endReason,
    voiceSeconds: input.report.voiceSeconds,
    usageComplete: input.report.usageComplete,
    model: input.report.model ?? null,
    inputTokens: input.report.inputTokens,
    cachedInputTokens: input.report.cachedInputTokens,
    outputTokens: input.report.outputTokens,
    toolCalls: input.report.toolCalls,
  });
  return true;
}
