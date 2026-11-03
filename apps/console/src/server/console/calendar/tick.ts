// The calendar cron (every 5 minutes, `vercel.json`): for each calendar
// meeting starting within 20 minutes, decide once per organization whether a
// bot goes in, send it as the person who chose it, and link every member's
// row of the meeting to that bot (spec `console/calendar`, "Recording decision").

import { randomUUID, timingSafeEqual } from "node:crypto";

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";

import { adminJson, adminRequestId, gateAdminRequest } from "@/server/admin/http";
import { CliApiError } from "@/server/cli/errors";
import { memberActorForOrganization } from "@/server/console/access/common";
import { createMeetingBot } from "@/server/console/meetings/service";
import { canAccessProject } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

import {
  decideMeeting,
  meetingKey,
  RECORD_WINDOW_MS,
  SAME_MEETING_BOT_TOLERANCE_MS,
  type MeetingOutcome,
  type MeetingRow,
} from "./decision";
import { calendarAutoRecordAllowed } from "./service";

const MEETINGS_PER_TICK = 100;
/** A bot sent with no join time (join now) this long before the start still counts as the meeting's bot. */
const JOIN_NOW_BOT_LOOKBACK_MS = 30 * 60 * 1000;
const JOIN_LEAD_MS = 60 * 1000;
const STEP_RESERVE_MS = 5_000;
export const CALENDAR_TICK_ROUTE_BUDGET_MS = 240_000;

export type CreateCalendarBot = (input: {
  meetingUrl: string;
  title: string;
  joinAt: Date | null;
  clientRef: string;
  projectId: string;
  requestId: string;
  workspace: { user: { id: string }; organization: { id: string }; membership: { role: string } };
}) => Promise<{ meetingId: string }>;

export type CalendarTickDeps = {
  createBot?: CreateCalendarBot;
  autoRecordAllowed?: (organizationId: string) => Promise<boolean>;
};

export type MeetingTickResult = { key: string; outcome: MeetingOutcome["kind"] | "busy" | "error"; reason?: string; meetingId?: string };

export type CalendarTickResult = {
  meetings: number;
  recorded: number;
  linked: number;
  failed: number;
  budgetExhausted: boolean;
};

const defaultCreateBot: CreateCalendarBot = async (input) => {
  const result = await createMeetingBot({
    body: {
      meetingUrl: input.meetingUrl,
      title: input.title.slice(0, 200) || undefined,
      ...(input.joinAt ? { joinAt: input.joinAt.toISOString() } : {}),
      clientRef: input.clientRef,
    },
    localInstallationId: null,
    projectRef: input.projectId,
    requestId: input.requestId,
    workspace: input.workspace,
  });
  return { meetingId: result.meeting.id };
};

export async function runCalendarTick(
  input: { requestId: string; budgetMs: number; now?: () => Date },
  deps: CalendarTickDeps = {},
): Promise<CalendarTickResult> {
  const clock = input.now ?? (() => new Date());
  const startedAt = Date.now();
  const now = clock();
  const result: CalendarTickResult = { meetings: 0, recorded: 0, linked: 0, failed: 0, budgetExhausted: false };
  const candidates = await db
    .selectDistinct({
      organizationId: schema.calendarEvents.organizationId,
      meetingCode: schema.calendarEvents.meetingCode,
      startAt: schema.calendarEvents.startAt,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        isNull(schema.calendarEvents.deletedAt),
        isNull(schema.calendarEvents.meetingBotId),
        isNotNull(schema.calendarEvents.meetingCode),
        ne(schema.calendarEvents.status, "cancelled"),
        gt(schema.calendarEvents.startAt, now),
        lte(schema.calendarEvents.startAt, new Date(now.getTime() + RECORD_WINDOW_MS)),
      ),
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .limit(MEETINGS_PER_TICK);

  for (const candidate of candidates) {
    if (input.budgetMs - (Date.now() - startedAt) < STEP_RESERVE_MS) {
      result.budgetExhausted = true;
      break;
    }
    if (!candidate.meetingCode) continue;
    result.meetings += 1;
    const outcome = await processCalendarMeeting(
      {
        organizationId: candidate.organizationId,
        meetingCode: candidate.meetingCode,
        startAt: candidate.startAt,
        requestId: input.requestId,
        now: clock(),
      },
      deps,
    );
    if (outcome.outcome === "record") result.recorded += 1;
    else if (outcome.outcome === "link") result.linked += 1;
    else if (outcome.outcome === "error") result.failed += 1;
  }
  return result;
}

/** A person chose Record inside the window: decide that meeting now instead of on the next tick. */
export async function recordCalendarEventNow(
  input: { eventId: string; requestId: string; now: Date },
  deps: CalendarTickDeps = {},
) {
  const [event] = await db
    .select({
      organizationId: schema.calendarEvents.organizationId,
      meetingCode: schema.calendarEvents.meetingCode,
      startAt: schema.calendarEvents.startAt,
    })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.id, input.eventId))
    .limit(1);
  if (!event?.meetingCode) return null;
  return processCalendarMeeting(
    {
      organizationId: event.organizationId,
      meetingCode: event.meetingCode,
      startAt: event.startAt,
      requestId: input.requestId,
      now: input.now,
    },
    deps,
  );
}

type GroupRow = MeetingRow & { meetingUrl: string | null; title: string; startAt: Date };

/**
 * One meeting of one organization, under a transaction-scoped advisory lock
 * on its key, so a tick and a person's Record click never both send a bot.
 */
export async function processCalendarMeeting(
  input: { organizationId: string; meetingCode: string; startAt: Date; requestId: string; now: Date },
  deps: CalendarTickDeps = {},
): Promise<MeetingTickResult> {
  const key = meetingKey(input.meetingCode, input.startAt);
  try {
    return await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${`calendar:${input.organizationId}:${key}`}::text)) as locked`,
      );
      if (!lock?.locked) return { key, outcome: "busy" as const };

      const rows = await loadMeetingRows(input);
      const existingBotId = await findExistingBot(input);
      const autoRecordAllowed = await (deps.autoRecordAllowed ?? calendarAutoRecordAllowed)(input.organizationId);
      const outcome = decideMeeting({ rows, autoRecordAllowed, existingBotId });

      if (outcome.kind === "none") return { key, outcome: "none" as const, reason: outcome.reason };
      if (outcome.kind === "link") {
        await linkMeeting({ rows, meetingBotId: outcome.meetingBotId, now: input.now });
        return { key, outcome: "link" as const, meetingId: outcome.meetingBotId };
      }

      const owner = rows.find((row) => row.id === outcome.row.id);
      if (!owner?.meetingUrl) return { key, outcome: "none" as const, reason: "no_meeting_url" };
      const member = await memberActorForOrganization({ organizationId: input.organizationId, userId: owner.userId });
      if (!member) {
        await markError(owner.id, "not_member", input.now);
        return { key, outcome: "error" as const, reason: "not_member" };
      }
      const joinAt = new Date(input.startAt.getTime() - JOIN_LEAD_MS);
      try {
        const created = await (deps.createBot ?? defaultCreateBot)({
          meetingUrl: owner.meetingUrl,
          title: owner.title,
          joinAt: joinAt.getTime() > input.now.getTime() ? joinAt : null,
          clientRef: `calendar:${owner.id}`,
          projectId: outcome.projectId,
          requestId: input.requestId,
          workspace: {
            user: { id: owner.userId },
            organization: { id: input.organizationId },
            membership: { role: member.role },
          },
        });
        await linkMeeting({ rows, meetingBotId: created.meetingId, now: input.now });
        return { key, outcome: "record" as const, reason: outcome.reason, meetingId: created.meetingId };
      } catch (error) {
        const reason = error instanceof CliApiError ? `${error.code}: ${error.message}`.slice(0, 300) : "bot_failed";
        console.error("calendar_record_failed", { key, organizationId: input.organizationId, eventId: owner.id, reason });
        await markError(owner.id, reason, input.now);
        return { key, outcome: "error" as const, reason };
      }
    });
  } catch (error) {
    console.error("calendar_meeting_failed", {
      key,
      organizationId: input.organizationId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return { key, outcome: "error", reason: "internal" };
  }
}

async function loadMeetingRows(input: { organizationId: string; meetingCode: string; startAt: Date }): Promise<GroupRow[]> {
  const rows = await db
    .select({ event: schema.calendarEvents, settings: schema.calendarSettings })
    .from(schema.calendarEvents)
    .leftJoin(schema.calendarSettings, eq(schema.calendarSettings.providerConnectionId, schema.calendarEvents.providerConnectionId))
    .where(
      and(
        eq(schema.calendarEvents.organizationId, input.organizationId),
        eq(schema.calendarEvents.meetingCode, input.meetingCode),
        eq(schema.calendarEvents.startAt, input.startAt),
        isNull(schema.calendarEvents.deletedAt),
      ),
    )
    .orderBy(asc(schema.calendarEvents.createdAt));
  return rows.map(({ event, settings }) => ({
    id: event.id,
    userId: event.userId,
    status: event.status,
    selfResponse: event.selfResponse,
    deletedAt: event.deletedAt,
    externalAttendees: event.externalAttendees,
    recordDecision: event.recordDecision,
    recordDecisionProjectId: event.recordDecisionProjectId,
    recordDecidedAt: event.recordDecidedAt,
    meetingBotId: event.meetingBotId,
    createdAt: event.createdAt,
    recordMode: settings?.recordMode ?? null,
    projectId: settings?.projectId ?? null,
    meetingUrl: event.meetingUrl,
    title: event.title,
    startAt: event.startAt,
  }));
}

/** A bot the organization already sent to this Meet code around this start, from the calendar or by hand. */
async function findExistingBot(input: { organizationId: string; meetingCode: string; startAt: Date }) {
  const start = input.startAt.getTime();
  const [bot] = await db
    .select({ id: schema.meetingBots.id })
    .from(schema.meetingBots)
    .where(
      and(
        eq(schema.meetingBots.organizationId, input.organizationId),
        eq(schema.meetingBots.meetingCode, input.meetingCode),
        ne(schema.meetingBots.status, "failed"),
        or(
          and(
            gte(schema.meetingBots.joinAt, new Date(start - SAME_MEETING_BOT_TOLERANCE_MS)),
            lte(schema.meetingBots.joinAt, new Date(start + SAME_MEETING_BOT_TOLERANCE_MS)),
          ),
          and(
            isNull(schema.meetingBots.joinAt),
            gte(schema.meetingBots.createdAt, new Date(start - JOIN_NOW_BOT_LOOKBACK_MS)),
            lte(schema.meetingBots.createdAt, new Date(start + SAME_MEETING_BOT_TOLERANCE_MS)),
          ),
        ),
      ),
    )
    .orderBy(asc(schema.meetingBots.createdAt))
    .limit(1);
  return bot?.id ?? null;
}

/**
 * Every row of the meeting points at the bot, and every owner who cannot read
 * the bot's project gets a viewer grant on the meeting, so each person who had
 * it in their calendar opens the same page.
 */
async function linkMeeting(input: { rows: readonly GroupRow[]; meetingBotId: string; now: Date }) {
  const unlinked = input.rows.filter((row) => row.meetingBotId !== input.meetingBotId).map((row) => row.id);
  if (unlinked.length > 0) {
    await db
      .update(schema.calendarEvents)
      .set({ meetingBotId: input.meetingBotId, recordError: null, updatedAt: input.now })
      .where(inArray(schema.calendarEvents.id, unlinked));
  }
  const [bot] = await db
    .select({
      id: schema.meetingBots.id,
      organizationId: schema.meetingBots.organizationId,
      projectId: schema.meetingBots.projectId,
      requestedByUserId: schema.meetingBots.requestedByUserId,
    })
    .from(schema.meetingBots)
    .where(eq(schema.meetingBots.id, input.meetingBotId))
    .limit(1);
  if (!bot?.projectId) return;
  const projectId = bot.projectId;
  const owners = [...new Set(input.rows.map((row) => row.userId))].filter((userId) => userId !== bot.requestedByUserId);
  for (const userId of owners) {
    const member = await memberActorForOrganization({ organizationId: bot.organizationId, userId });
    if (!member) continue;
    const canRead = await canAccessProject(
      { user: { id: userId }, organization: { id: bot.organizationId }, membership: { role: member.role } },
      projectId,
      "read",
    );
    if (canRead) continue;
    const [grant] = await db
      .insert(schema.accessGrants)
      .values({
        organizationId: bot.organizationId,
        projectId,
        meetingBotId: bot.id,
        objectType: "meeting",
        objectId: bot.id,
        relation: "viewer",
        subjectType: "user",
        subjectId: userId,
        reason: "calendar attendee",
        createdByActorType: "system",
        createdByActorId: "calendar",
      })
      .onConflictDoNothing()
      .returning({ id: schema.accessGrants.id });
    if (!grant) continue;
    await db.insert(schema.auditEvents).values({
      action: "access_grant.created",
      actorType: "system",
      actorId: "calendar",
      afterJson: { objectType: "meeting", objectId: bot.id, relation: "viewer", subjectId: userId, reason: "calendar attendee" },
      metadataJson: { source: "console.calendar" },
      organizationId: bot.organizationId,
      projectId,
      targetId: grant.id,
      targetType: "access_grant",
    });
  }
}

async function markError(eventId: string, reason: string, now: Date) {
  await db
    .update(schema.calendarEvents)
    .set({ recordError: reason, updatedAt: now })
    .where(eq(schema.calendarEvents.id, eventId));
}

// ---------------------------------------------------------------------------
// HTTP: Vercel Cron (GET with CRON_SECRET) or an operator (POST with the admin token)
// ---------------------------------------------------------------------------

export type CalendarTickHttpDeps = {
  cronSecret?: () => string | undefined;
  runTick?: typeof runCalendarTick;
};

export async function handleCalendarTickHttp(request: Request, deps: CalendarTickHttpDeps = {}): Promise<Response> {
  let requestId: string;
  if (request.method === "GET") {
    requestId = adminRequestId(request);
    const secret = (deps.cronSecret ?? (() => process.env.CRON_SECRET))()?.trim();
    if (!secret) {
      console.error("calendar_tick_cron_secret_missing", { requestId });
      return adminJson({ status: "error", code: "cron_secret_not_configured", requestId }, 503, requestId);
    }
    if (!bearerMatches(request, secret)) {
      if (isRateLimited({ key: rateLimitKey(request, "calendar-tick"), limit: 10, windowMs: 60_000 })) {
        return adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId);
      }
      return adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId);
    }
  } else {
    const gate = gateAdminRequest(request, { rateLimitName: "calendar-tick", missingTokenLog: "calendar_tick_admin_token_missing" });
    if (!gate.ok) return gate.response;
    requestId = gate.requestId;
  }

  try {
    const result = await (deps.runTick ?? runCalendarTick)({
      requestId: requestId || `calendar-tick-${randomUUID()}`,
      budgetMs: CALENDAR_TICK_ROUTE_BUDGET_MS,
    });
    return adminJson({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    console.error("calendar_tick_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "calendar_tick_failed", requestId }, 500, requestId);
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  const expected = Buffer.from(secret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
