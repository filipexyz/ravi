// Metering for the text chat (K12): every agent turn records its tokens and
// cost against the organization (no billing yet). The org's monthly Page Chat
// budget is shared by voice and text; a person gets a daily number of turns.

import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { usageEventTypes, usageMetricKeys, type UsageEventRecordInput } from "@/server/console/billing/usage-metering";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { parsePageChatLimits } from "@/server/console/pages/chat/limits";
import { PAGE_CHAT_FEATURE_KEY } from "@/server/console/pages/chat/usage";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { ChatViewer } from "./access";

/** Agent turns one person may start per UTC day, across the organization; guests get fewer. */
export const TEXT_CHAT_DEFAULT_TURNS_PER_PERSON_DAY = 200;
export const TEXT_CHAT_GUEST_TURNS_PER_DAY = 40;

export type TextChatAllowance =
  | { allowed: true; monthSpentUsd: number; budgetUsd: number }
  | { allowed: false; reason: "feature_unavailable" | "org_budget_exhausted" | "person_daily_limit" };

export type TextChatFacts = {
  entitlementValueJson: Record<string, unknown> | null;
  orgMonthSpentUsd: number;
  personTurnsToday: number;
};

export type TextChatAllowanceDeps = {
  featureAccess?: typeof getConsoleFeatureAccessForOrganizationRole;
  readFacts?: (input: { organizationId: string; userId: string; now: Date }) => Promise<TextChatFacts>;
  now?: () => Date;
};

export async function resolveTextChatAllowance(
  input: { organizationId: string; viewer: Pick<ChatViewer, "userId" | "role" | "orgRole"> },
  deps: TextChatAllowanceDeps = {},
): Promise<TextChatAllowance> {
  const featureAccess = deps.featureAccess ?? getConsoleFeatureAccessForOrganizationRole;
  const access = await featureAccess({ organizationId: input.organizationId, role: input.viewer.orgRole ?? "owner" });
  const feature = access.byKey[PAGE_CHAT_FEATURE_KEY];
  const on = input.viewer.orgRole ? feature?.enabled : feature?.available;
  if (!on) return { allowed: false, reason: "feature_unavailable" };

  const now = (deps.now ?? (() => new Date()))();
  const facts = await (deps.readFacts ?? readTextChatFacts)({ organizationId: input.organizationId, userId: input.viewer.userId, now });
  return evaluateTextChatAllowance({ facts, guest: input.viewer.role === "guest" });
}

export function evaluateTextChatAllowance(input: { facts: TextChatFacts; guest: boolean }): TextChatAllowance {
  const limits = parsePageChatLimits(input.facts.entitlementValueJson);
  const rawTurns = (input.facts.entitlementValueJson?.limits as Record<string, unknown> | undefined)?.textTurnsPerPersonDay;
  const perDay = typeof rawTurns === "number" && Number.isFinite(rawTurns) && rawTurns > 0 ? Math.floor(rawTurns) : TEXT_CHAT_DEFAULT_TURNS_PER_PERSON_DAY;
  const personCap = input.guest ? Math.min(perDay, TEXT_CHAT_GUEST_TURNS_PER_DAY) : perDay;
  if (input.facts.orgMonthSpentUsd >= limits.orgMonthlyBudgetUsd) return { allowed: false, reason: "org_budget_exhausted" };
  if (input.facts.personTurnsToday >= personCap) return { allowed: false, reason: "person_daily_limit" };
  return { allowed: true, monthSpentUsd: input.facts.orgMonthSpentUsd, budgetUsd: limits.orgMonthlyBudgetUsd };
}

/** Metric keys whose `measurementsJson.estimatedCostUsd` adds up to the Page Chat spend (voice and text). */
export const PAGE_CHAT_SPEND_METRIC_KEYS = [usageMetricKeys.pagesChatSessions, usageMetricKeys.pagesChatTextTurns] as const;

export async function readTextChatFacts(input: { organizationId: string; userId: string; now: Date }): Promise<TextChatFacts> {
  const { now } = input;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [[entitlement], [spend], [turns]] = await Promise.all([
    db
      .select({ valueJson: schema.entitlements.valueJson })
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.organizationId, input.organizationId), eq(schema.entitlements.key, PAGE_CHAT_FEATURE_KEY)))
      .limit(1),
    db
      .select({ usd: sql<string>`COALESCE(SUM((${schema.usageEvents.measurementsJson}->>'estimatedCostUsd')::numeric), 0)` })
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, input.organizationId),
          inArray(schema.usageEvents.metricKey, [...PAGE_CHAT_SPEND_METRIC_KEYS]),
          gte(schema.usageEvents.occurredAt, monthStart),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pageChatTurns)
      .where(
        and(
          eq(schema.pageChatTurns.organizationId, input.organizationId),
          eq(schema.pageChatTurns.speakerUserId, input.userId),
          gte(schema.pageChatTurns.createdAt, dayStart),
        ),
      ),
  ]);
  return {
    entitlementValueJson: entitlement?.valueJson ?? null,
    orgMonthSpentUsd: Number(spend?.usd ?? 0),
    personTurnsToday: Number(turns?.count ?? 0),
  };
}

export type TextTurnReport = {
  organizationId: string;
  projectId: string;
  siteId: string;
  roomId: string;
  turnId: string;
  speakerUserId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Provider-reported cost; null when unavailable (not an assertion of zero spend). */
  costUsd: number | null;
  toolCalls: number;
  status: "complete" | "failed";
  finishedAt: Date;
};

/**
 * Usage rows for one finished turn: a `pages.chat.text_turns` count carrying
 * the cost (so the spend sum includes it) and one row per token kind. The
 * model name stays in metadata; metric keys are Ravi's.
 */
export function buildTextTurnUsageEvents(report: TextTurnReport): UsageEventRecordInput[] {
  const base = {
    organizationId: report.organizationId,
    projectId: report.projectId,
    siteId: report.siteId,
    releaseId: null,
    routeId: null,
    artifactId: null,
    artifactVersionId: null,
    assetId: null,
    publishId: null,
    source: "pages_chat",
    eventType: usageEventTypes.pagesChatTextTurnCompleted,
    requestId: null,
    occurredAt: report.finishedAt,
  };
  const dimensionsJson: JsonRecord = {
    service: "pages",
    object: "chat_text_turn",
    roomId: report.roomId,
    turnId: report.turnId,
    viewerUserId: report.speakerUserId,
    status: report.status,
  };
  const event = (metricKey: string, quantity: number, unit: string, measurementsJson: JsonRecord = {}): UsageEventRecordInput => ({
    ...base,
    metricKey,
    quantity: decimal(quantity),
    unit,
    dimensionsJson,
    measurementsJson,
    evidenceJson: { costReported: report.costUsd !== null },
    metadataJson: { model: report.model },
    idempotencyKey: `${usageEventTypes.pagesChatTextTurnCompleted}:${report.turnId}:${metricKey}`,
  });
  const events = [
    event(usageMetricKeys.pagesChatTextTurns, 1, "count", {
      estimatedCostUsd: report.costUsd === null ? null : roundUsd(report.costUsd),
      estimatedCostComplete: report.costUsd !== null,
      toolCalls: report.toolCalls,
    }),
  ];
  const tokens: Array<[string, number]> = [
    [usageMetricKeys.pagesChatModelInputTokens, report.inputTokens],
    [usageMetricKeys.pagesChatModelCachedInputTokens, report.cachedInputTokens],
    [usageMetricKeys.pagesChatModelOutputTokens, report.outputTokens],
  ];
  for (const [metricKey, quantity] of tokens) {
    if (quantity > 0) events.push(event(metricKey, quantity, "tokens"));
  }
  if (report.toolCalls > 0) events.push(event(usageMetricKeys.pagesChatToolCalls, report.toolCalls, "count"));
  return events;
}

export async function recordTextTurnUsage(report: TextTurnReport): Promise<void> {
  await db.insert(schema.usageEvents).values(buildTextTurnUsageEvents(report)).onConflictDoNothing();
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return (Math.round(value * 1000) / 1000).toString();
}

function roundUsd(value: number) {
  return Math.round(value * 1e8) / 1e8;
}
