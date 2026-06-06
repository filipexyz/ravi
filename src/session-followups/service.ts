import { publish } from "../nats.js";
import { getLatestExternalUserMessageAt } from "../db.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import {
  dbFindChatByRef,
  dbFindChatReadingList,
  dbGetChat,
  dbGetInstanceByInstanceId,
  dbGetSessionOutputAttachment,
  dbListChatsByRef,
  dbListChatReadingListMembers,
  getDb,
  type ChatRecord,
  type ChatReadingListRecord,
} from "../router/router-db.js";
import { findSessionByAttachedChat, findSessionByChatId, getSession, resolveSession } from "../router/sessions.js";
import { calculateNextRun, formatDurationMs } from "../cron/schedule.js";
import { resolveTemplate } from "../triggers/template.js";
import { logger } from "../utils/logger.js";
import {
  createSessionFollowupRun,
  getDueSessionFollowupCadences,
  getSessionFollowupCadence,
  leaseSessionFollowupRun,
  listRunnableSessionFollowupRuns,
  markSessionFollowupRunFailed,
  markSessionFollowupRunSent,
  markSessionFollowupRunSkipped,
  updateSessionFollowupCadenceState,
  updateSessionFollowupRunResolution,
} from "./db.js";
import type {
  SessionFollowupCadence,
  SessionFollowupRun,
  SessionFollowupStep,
  SessionFollowupTargetType,
} from "./types.js";

const log = logger.child("session-followups");
const DUE_TOPIC = "ravi.sessions.followup.due";
const SENT_TOPIC = "ravi.sessions.followup.sent";
const SKIPPED_TOPIC = "ravi.sessions.followup.skipped";
const FAILED_TOPIC = "ravi.sessions.followup.failed";
const IDLE_CATCHUP_DELAY_MS = 60_000;

type EventPublisher = (topic: string, data: Record<string, unknown>) => Promise<void>;
type PromptPublisher = (sessionName: string, payload: Record<string, unknown>) => Promise<void>;

let eventPublisher: EventPublisher = publish;
let promptPublisher: PromptPublisher = publishSessionPrompt;

export function setSessionFollowupPublishersForTests(input?: {
  eventPublisher?: EventPublisher;
  promptPublisher?: PromptPublisher;
}): void {
  eventPublisher = input?.eventPublisher ?? publish;
  promptPublisher = input?.promptPublisher ?? publishSessionPrompt;
}

export interface RunDueSessionFollowupsInput {
  now?: number;
  cadenceLimit?: number;
  runLimit?: number;
}

export interface RunDueSessionFollowupsResult {
  cadencesScanned: number;
  runsCreated: number;
  runsProcessed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runDueSessionFollowups(
  input: RunDueSessionFollowupsInput = {},
): Promise<RunDueSessionFollowupsResult> {
  const now = input.now ?? Date.now();
  const result: RunDueSessionFollowupsResult = {
    cadencesScanned: 0,
    runsCreated: 0,
    runsProcessed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  const dueCadences = getDueSessionFollowupCadences(now, input.cadenceLimit ?? 50);
  result.cadencesScanned = dueCadences.length;
  for (const cadence of dueCadences) {
    const dueAt = cadence.nextRunAt ?? now;
    const plan = createRunsForCadence(cadence, dueAt, now, "scheduled");
    result.runsCreated += plan.created;

    const nextRunAt = plan.nextRunAt ?? calculateNextRun(cadence.schedule, now);
    updateSessionFollowupCadenceState(cadence.id, {
      enabled: nextRunAt !== undefined,
      nextRunAt: nextRunAt ?? null,
      lastRunAt: now,
      lastStatus: plan.created > 0 ? "ok" : plan.targetsResolved > 0 ? "ok" : "skipped",
      lastError: plan.targetsResolved > 0 ? null : "No targets resolved for cadence",
      now,
    });
  }

  const runnable = listRunnableSessionFollowupRuns(now, input.runLimit ?? 50);
  for (const run of runnable) {
    const leased = leaseSessionFollowupRun(run.id, now);
    if (!leased) continue;
    result.runsProcessed += 1;
    const outcome = await executeSessionFollowupRun(leased, now);
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else result.failed += 1;
  }

  return result;
}

export async function runSessionFollowupNow(id: string, now = Date.now()): Promise<RunDueSessionFollowupsResult> {
  const cadence = requireCadence(id);
  const plan = createRunsForCadence(cadence, now, now, "manual");
  const runnable = listRunnableSessionFollowupRuns(now, 100).filter((run) => run.cadenceId === cadence.id);
  const result: RunDueSessionFollowupsResult = {
    cadencesScanned: 1,
    runsCreated: plan.created,
    runsProcessed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  for (const run of runnable) {
    const leased = leaseSessionFollowupRun(run.id, now);
    if (!leased) continue;
    result.runsProcessed += 1;
    const outcome = await executeSessionFollowupRun(leased, now);
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else result.failed += 1;
  }
  updateSessionFollowupCadenceState(cadence.id, {
    lastRunAt: now,
    lastStatus: result.failed > 0 ? "failed" : result.sent > 0 ? "ok" : "skipped",
    lastError: result.failed > 0 ? "One or more manual followup runs failed" : null,
    now,
  });
  return result;
}

function createRunsForCadence(
  cadence: SessionFollowupCadence,
  dueAt: number,
  now: number,
  mode: "scheduled" | "manual",
): { created: number; targetsResolved: number; nextRunAt?: number } {
  if (cadence.schedule.type === "every" && mode === "scheduled") {
    return createIdleRunsForCadence(cadence, now);
  }

  const targets = resolveCadenceTargets(cadence);
  let created = 0;
  const step = cadence.schedule.type === "every" ? getCadenceSteps(cadence)[0] : undefined;
  for (const target of targets) {
    const idempotencyKey = [
      "session-followup",
      cadence.id,
      mode === "manual" ? `manual:${now}` : `due:${dueAt}`,
      target.type,
      target.ref,
    ].join(":");
    const run = createSessionFollowupRun({
      cadenceId: cadence.id,
      targetType: target.type,
      targetRef: target.ref,
      sessionName: target.sessionName,
      sessionKey: target.sessionKey,
      chatId: target.chat?.id,
      dueAt,
      idempotencyKey,
      eventPayload: buildEventPayload(cadence, {
        runId: null,
        dueAt,
        target,
        mode,
        step,
      }),
      now,
    });
    if (run.created) created += 1;
  }
  return { created, targetsResolved: targets.length };
}

function createIdleRunsForCadence(
  cadence: SessionFollowupCadence,
  now: number,
): { created: number; targetsResolved: number; nextRunAt?: number } {
  const targets = resolveCadenceTargets(cadence);
  const steps = getCadenceSteps(cadence);
  const nextRunCandidates: number[] = [];
  let created = 0;

  for (const target of targets) {
    const anchorAt = resolveActivityAnchorAt(cadence, target);
    const targetPlan = createNextIdleRunForTarget(cadence, target, steps, anchorAt, now);
    created += targetPlan.created;
    if (targetPlan.nextRunAt !== undefined) nextRunCandidates.push(targetPlan.nextRunAt);
  }

  if (nextRunCandidates.length === 0 && steps[0]) {
    nextRunCandidates.push(now + steps[0].afterMs);
  }

  return {
    created,
    targetsResolved: targets.length,
    nextRunAt: nextRunCandidates.length > 0 ? Math.min(...nextRunCandidates) : undefined,
  };
}

type IndexedFollowupStep = SessionFollowupStep & { index: number; total: number };

function createNextIdleRunForTarget(
  cadence: SessionFollowupCadence,
  target: ResolvedFollowupTarget,
  steps: IndexedFollowupStep[],
  anchorAt: number,
  now: number,
): { created: number; nextRunAt?: number } {
  if (steps.length === 0) return { created: 0 };

  for (const step of steps) {
    const dueAt = anchorAt + step.afterMs;
    if (dueAt > now) return { created: 0, nextRunAt: dueAt };

    const idempotencyKey = [
      "session-followup",
      cadence.id,
      `anchor:${anchorAt}`,
      `step:${step.index}`,
      target.type,
      target.ref,
    ].join(":");
    const run = createSessionFollowupRun({
      cadenceId: cadence.id,
      targetType: target.type,
      targetRef: target.ref,
      sessionName: target.sessionName,
      sessionKey: target.sessionKey,
      chatId: target.chat?.id,
      dueAt,
      idempotencyKey,
      eventPayload: buildEventPayload(cadence, {
        runId: null,
        dueAt,
        target,
        mode: "scheduled",
        step,
        anchorAt,
      }),
      now,
    });

    if (run.created) {
      const nextStep = steps.find((candidate) => candidate.index > step.index);
      if (!nextStep) return { created: 1, nextRunAt: now + steps[0].afterMs };
      const nextStepDueAt = anchorAt + nextStep.afterMs;
      return { created: 1, nextRunAt: nextStepDueAt <= now ? now + IDLE_CATCHUP_DELAY_MS : nextStepDueAt };
    }

    if (run.run.status === "sent" || run.run.status === "skipped") continue;
    return { created: 0, nextRunAt: run.run.nextAttemptAt ?? now + IDLE_CATCHUP_DELAY_MS };
  }

  return { created: 0, nextRunAt: now + steps[0].afterMs };
}

type ResolvedFollowupTarget = {
  type: SessionFollowupTargetType;
  ref: string;
  label: string;
  sessionName?: string;
  sessionKey?: string;
  chat?: ChatRecord;
  list?: ChatReadingListRecord;
};

function resolveCadenceTargets(cadence: SessionFollowupCadence): ResolvedFollowupTarget[] {
  if (cadence.targetType === "session") {
    const session = resolveSession(cadence.targetRef);
    return [
      {
        type: "session",
        ref: cadence.targetRef,
        label: `session:${session?.name ?? cadence.targetRef}`,
        sessionName: session?.name ?? cadence.targetRef,
        sessionKey: session?.sessionKey,
      },
    ];
  }

  if (cadence.targetType === "chat") {
    const chat = resolveChat(cadence.targetRef);
    return [
      {
        type: "chat",
        ref: chat?.id ?? cadence.targetRef,
        label: `chat:${chat?.title ?? chat?.id ?? cadence.targetRef}`,
        chat: chat ?? undefined,
      },
    ];
  }

  const list = dbFindChatReadingList({ ref: cadence.targetRef });
  if (!list) return [];
  const page = dbListChatReadingListMembers({ listId: list.id, limit: 500, offset: 0 });
  return page.items.map((item) => ({
    type: "chat",
    ref: item.chat.id,
    label: `list:${list.name}/chat:${item.chat.title ?? item.chat.id}`,
    chat: item.chat,
    list,
  }));
}

async function executeSessionFollowupRun(run: SessionFollowupRun, now: number): Promise<"sent" | "skipped" | "failed"> {
  const cadence = getSessionFollowupCadence(run.cadenceId);
  if (!cadence) {
    markSessionFollowupRunSkipped(run.id, "Cadence no longer exists", now);
    await publishFollowupEvent(SKIPPED_TOPIC, { runId: run.id, reason: "cadence_missing" });
    return "skipped";
  }

  try {
    const target = resolveRunTarget(run);
    if (!target.sessionName) {
      const reason = target.skipReason ?? "No session resolved for followup target";
      const skipped = markSessionFollowupRunSkipped(run.id, reason, now);
      await publishFollowupEvent(
        SKIPPED_TOPIC,
        buildEventPayload(cadence, { runId: run.id, dueAt: run.dueAt, target, reason }),
      );
      updateSessionFollowupCadenceState(cadence.id, { lastRunAt: now, lastStatus: "skipped", lastError: reason, now });
      log.warn("Skipped session followup run", { runId: run.id, cadenceId: cadence.id, reason });
      return skipped ? "skipped" : "failed";
    }

    const eventPayload = buildEventPayload(cadence, {
      runId: run.id,
      dueAt: run.dueAt,
      target,
      mode: "delivery",
      step: resolveRunStep(cadence, run),
      anchorAt: resolveRunAnchorAt(run),
    });
    const step = resolveRunStep(cadence, run);
    const rendered = resolveTemplate(step?.messageTemplate ?? cadence.messageTemplate, {
      topic: DUE_TOPIC,
      data: eventPayload,
    });
    const prompt = formatFollowupPrompt(cadence, target, rendered, step);

    updateSessionFollowupRunResolution(run.id, {
      sessionName: target.sessionName,
      sessionKey: target.sessionKey,
      chatId: target.chat?.id,
      eventPayload,
      now,
    });

    await publishFollowupEvent(DUE_TOPIC, eventPayload);
    await promptPublisher(target.sessionName, {
      prompt,
      source: target.chat ? sourceFromChat(target.chat) : undefined,
      deliveryBarrier: cadence.deliveryBarrier,
      deliveryBarrierSource: "default",
      _sessionFollowup: true,
      _sessionFollowupCadenceId: cadence.id,
      _sessionFollowupRunId: run.id,
    });
    markSessionFollowupRunSent(run.id, prompt, now);
    await publishFollowupEvent(SENT_TOPIC, { ...eventPayload, promptDelivered: true });
    updateSessionFollowupCadenceState(cadence.id, { lastRunAt: now, lastStatus: "ok", lastError: null, now });
    return "sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markSessionFollowupRunFailed(run.id, message, now);
    updateSessionFollowupCadenceState(cadence.id, { lastRunAt: now, lastStatus: "failed", lastError: message, now });
    await publishFollowupEvent(FAILED_TOPIC, {
      runId: run.id,
      cadenceId: run.cadenceId,
      error: message.slice(0, 500),
    });
    log.error("Failed to execute session followup run", { runId: run.id, cadenceId: run.cadenceId, error });
    return "failed";
  }
}

type ResolvedRunTarget = ResolvedFollowupTarget & { skipReason?: string };

function resolveRunTarget(run: SessionFollowupRun): ResolvedRunTarget {
  if (run.targetType === "session") {
    const session = resolveSession(run.targetRef);
    if (!session) {
      return {
        type: "session",
        ref: run.targetRef,
        label: `session:${run.targetRef}`,
        skipReason: "Session not found",
      };
    }
    return {
      type: "session",
      ref: run.targetRef,
      label: `session:${session.name ?? session.sessionKey}`,
      sessionName: session.name ?? session.sessionKey,
      sessionKey: session.sessionKey,
    };
  }

  const chat = resolveChat(run.chatId ?? run.targetRef);
  if (!chat) {
    return { type: "chat", ref: run.targetRef, label: `chat:${run.targetRef}`, skipReason: "Chat not found" };
  }
  const session = resolveSessionForChat(chat);
  if (!session) {
    return {
      type: "chat",
      ref: chat.id,
      label: `chat:${chat.title ?? chat.id}`,
      chat,
      skipReason: "Chat has no active attached or recent routed session",
    };
  }
  return {
    type: "chat",
    ref: chat.id,
    label: `chat:${chat.title ?? chat.id}`,
    sessionName: session.name ?? session.sessionKey,
    sessionKey: session.sessionKey,
    chat,
  };
}

function resolveSessionForChat(chat: ChatRecord) {
  const owner = findSessionByAttachedChat(chat.id);
  if (owner) {
    const attached = getSession(owner.sessionKey);
    if (attached) return attached;
  }

  const refs = [chat.platformChatId, chat.normalizedChatId, chat.id]
    .map((ref) => ref?.trim())
    .filter(Boolean) as string[];
  const instance = dbGetInstanceByInstanceId(chat.instanceId);
  const instanceName = instance?.name ?? chat.instanceId;
  for (const ref of new Set(refs)) {
    const routed = findSessionByChatId(ref);
    if (!routed) continue;
    if (routed.lastAccountId && routed.lastAccountId !== instanceName && routed.lastAccountId !== chat.instanceId) {
      continue;
    }
    return routed;
  }

  return null;
}

function resolveChat(ref: string): ChatRecord | null {
  const exact = dbGetChat(ref);
  const directMatches = dbListChatsByRef({ ref });
  const candidates = [...directMatches];
  if (exact) {
    candidates.unshift(exact);
    if (exact.platformChatId) candidates.push(...dbListChatsByRef({ ref: exact.platformChatId }));
    if (exact.normalizedChatId) candidates.push(...dbListChatsByRef({ ref: exact.normalizedChatId }));
  }
  const best = chooseBestFollowupChat(ref, candidates);
  if (best) return best;
  return exact ?? dbFindChatByRef({ ref });
}

function chooseBestFollowupChat(ref: string, candidates: ChatRecord[]): ChatRecord | null {
  const seen = new Set<string>();
  let best: { chat: ChatRecord; score: number } | null = null;

  for (const chat of candidates) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    const session = resolveSessionForChat(chat);
    let score = 0;
    if (chat.id === ref) score += 100;
    if (chat.channel !== "unknown") score += 25;
    if (findSessionByAttachedChat(chat.id)) score += 10_000;
    else if (session) score += 5_000;
    score += Math.min(chat.lastSeenAt ?? chat.updatedAt ?? 0, 9_999_999_999_999) / 100_000_000_000_000;

    if (!best || score > best.score) {
      best = { chat, score };
    }
  }

  return best?.chat ?? null;
}

function formatFollowupPrompt(
  cadence: SessionFollowupCadence,
  target: ResolvedFollowupTarget,
  rendered: string,
  step?: IndexedFollowupStep,
): string {
  const headerParts = [`Session Followup: ${cadence.name}`, `Event: ${DUE_TOPIC}`, `Target: ${target.label}`];
  if (step) {
    headerParts.push(`Step: ${step.index}/${step.total} after ${formatDurationMs(step.afterMs)}`);
  }
  return [`[${headerParts.join(" | ")}]`, rendered.trim()].join("\n");
}

function buildEventPayload(
  cadence: SessionFollowupCadence,
  input: {
    runId: string | null;
    dueAt: number;
    target?: ResolvedFollowupTarget;
    mode?: string;
    reason?: string;
    step?: IndexedFollowupStep;
    anchorAt?: number;
  },
): Record<string, unknown> {
  const target = input.target;
  return {
    version: 1,
    eventType: "session.followup.due",
    cadence: {
      id: cadence.id,
      name: cadence.name,
      ownerType: cadence.ownerType,
      ownerId: cadence.ownerId,
      targetType: cadence.targetType,
      targetRef: cadence.targetRef,
    },
    run: {
      id: input.runId,
      dueAt: new Date(input.dueAt).toISOString(),
      dueAtMs: input.dueAt,
      mode: input.mode ?? "scheduled",
    },
    schedule: {
      type: cadence.schedule.type,
      every: cadence.schedule.every,
      steps: getCadenceSteps(cadence).map((step) => ({
        index: step.index,
        afterMs: step.afterMs,
        after: formatDurationMs(step.afterMs),
        label: step.label,
      })),
      cron: cadence.schedule.cron,
      at: cadence.schedule.at,
      timezone: cadence.schedule.timezone,
    },
    activity: input.anchorAt
      ? {
          anchor: "last_external_activity",
          anchorAt: new Date(input.anchorAt).toISOString(),
          anchorAtMs: input.anchorAt,
        }
      : undefined,
    step: input.step
      ? {
          index: input.step.index,
          total: input.step.total,
          afterMs: input.step.afterMs,
          after: formatDurationMs(input.step.afterMs),
          label: input.step.label,
        }
      : undefined,
    target: target
      ? {
          type: target.type,
          ref: target.ref,
          label: target.label,
          sessionName: target.sessionName,
          sessionKey: target.sessionKey,
        }
      : undefined,
    chat: target?.chat
      ? {
          id: target.chat.id,
          title: target.chat.title,
          channel: target.chat.channel,
          chatType: target.chat.chatType,
          instanceId: target.chat.instanceId,
        }
      : undefined,
    list: target?.list ? { id: target.list.id, name: target.list.name } : undefined,
    reason: input.reason,
  };
}

function getCadenceSteps(cadence: SessionFollowupCadence): IndexedFollowupStep[] {
  const steps =
    cadence.schedule.type === "every" && cadence.schedule.steps && cadence.schedule.steps.length > 0
      ? cadence.schedule.steps
      : cadence.schedule.type === "every" && cadence.schedule.every
        ? [{ afterMs: cadence.schedule.every, messageTemplate: cadence.messageTemplate }]
        : [];
  return steps
    .filter((step) => Number.isFinite(step.afterMs) && step.afterMs >= 0)
    .sort((a, b) => a.afterMs - b.afterMs)
    .map((step, index, all) => ({ ...step, index: index + 1, total: all.length }));
}

function resolveRunStep(cadence: SessionFollowupCadence, run: SessionFollowupRun): IndexedFollowupStep | undefined {
  const rawStep = run.eventPayload?.step;
  const index =
    rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)
      ? Number((rawStep as Record<string, unknown>).index)
      : undefined;
  if (!Number.isFinite(index) || !index) return getCadenceSteps(cadence)[0];
  const steps = getCadenceSteps(cadence);
  return steps.find((step) => step.index === index) ?? steps[0];
}

function resolveRunAnchorAt(run: SessionFollowupRun): number | undefined {
  const activity = run.eventPayload?.activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return undefined;
  const value = Number((activity as Record<string, unknown>).anchorAtMs);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveActivityAnchorAt(cadence: SessionFollowupCadence, target: ResolvedFollowupTarget): number {
  if (target.chat) {
    return (
      getLatestExternalChatActivityAt(target.chat.id) ??
      target.chat.lastSeenAt ??
      target.chat.updatedAt ??
      cadence.createdAt
    );
  }
  if (target.sessionKey) {
    const output = dbGetSessionOutputAttachment(target.sessionKey);
    if (output) {
      const chat = dbGetChat(output.chatId);
      if (chat)
        return getLatestExternalChatActivityAt(chat.id) ?? chat.lastSeenAt ?? chat.updatedAt ?? cadence.createdAt;
    }
    const session = getSession(target.sessionKey);
    return getLatestExternalSessionActivityAt(target, session?.name) ?? cadence.createdAt;
  }
  return cadence.createdAt;
}

function getLatestExternalSessionActivityAt(target: ResolvedFollowupTarget, sessionName?: string): number | undefined {
  const refs = [target.sessionName, sessionName, target.sessionKey, target.ref]
    .map((ref) => ref?.trim())
    .filter(Boolean) as string[];
  let latest: number | undefined;
  for (const ref of new Set(refs)) {
    const candidate = getLatestExternalUserMessageAt(ref);
    if (candidate !== undefined && (latest === undefined || candidate > latest)) latest = candidate;
  }
  return latest;
}

function getLatestExternalChatActivityAt(chatId: string): number | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT MAX(COALESCE(provider_timestamp, ingested_at, created_at)) AS value
      FROM chat_messages
      WHERE chat_id = ?
        AND deleted_at IS NULL
        AND actor_type != 'agent'
      `,
    )
    .get(chatId) as { value?: number | null } | undefined;
  const value = row?.value ?? undefined;
  return Number.isFinite(value) && value ? value : undefined;
}

function sourceFromChat(chat: ChatRecord): Record<string, unknown> {
  const instance = dbGetInstanceByInstanceId(chat.instanceId);
  return {
    channel: chat.channel,
    accountId: instance?.name ?? chat.instanceId,
    chatId: chat.platformChatId ?? chat.normalizedChatId ?? chat.id,
  };
}

async function publishFollowupEvent(topic: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await eventPublisher(topic, payload);
  } catch (error) {
    log.warn("Failed to publish session followup event", { topic, error });
  }
}

function requireCadence(id: string): SessionFollowupCadence {
  const cadence = getSessionFollowupCadence(id);
  if (!cadence) throw new Error(`Session followup cadence not found: ${id}`);
  return cadence;
}
