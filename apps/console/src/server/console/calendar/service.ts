// Calendar settings, the organization's auto-record policy, and the person's
// synced events (spec `console/calendar`). Every handler acts for the signed-in
// person in the active organization; the session and CLI envelopes share them.

import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { MEETINGS_FEATURE_KEY } from "@/server/console/meetings/limits";
import {
  listAccessibleProjectRecords,
  canAccessProject,
} from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { CalendarAttendee, JsonRecord } from "@/server/db/schema";

import { CALENDAR_RECORD_MODES, effectiveRecordMode, RECORD_WINDOW_MS } from "./decision";

export type CalendarWorkspace = {
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

/** Off by default: a person's `auto` mode acts as `ask` until an owner or admin turns it on. */
export const CALENDAR_AUTO_RECORD_POLICY = "meetings.calendar_auto_record";
const POLICY_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const GOOGLE_PROVIDER = "google";
const CALENDAR_SCOPES: ReadonlySet<string> = new Set([
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
]);
const LIVE_CONNECTION_STATUSES = ["active", "degraded"] as const;
const SOURCE = "console.calendar";

export const BRIEFING_MAX_CHARS = 20_000;
const EVENTS_DEFAULT_BACK_MS = 3600 * 1000;
const EVENTS_DEFAULT_AHEAD_MS = 7 * 24 * 3600 * 1000;
const EVENTS_MAX_SPAN_MS = 31 * 24 * 3600 * 1000;
const EVENTS_MAX = 500;

type ConnectionRecord = typeof schema.providerConnections.$inferSelect;
type SettingsRecord = typeof schema.calendarSettings.$inferSelect;
type EventRecord = typeof schema.calendarEvents.$inferSelect;

const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Organization policy
// ---------------------------------------------------------------------------

export async function calendarAutoRecordAllowed(organizationId: string) {
  const [row] = await db
    .select({ valueJson: schema.organizationPolicies.valueJson })
    .from(schema.organizationPolicies)
    .where(
      and(
        eq(schema.organizationPolicies.organizationId, organizationId),
        eq(schema.organizationPolicies.key, CALENDAR_AUTO_RECORD_POLICY),
      ),
    )
    .limit(1);
  return row?.valueJson?.enabled === true;
}

export async function getCalendarPolicy(workspace: CalendarWorkspace) {
  return {
    autoRecordAllowed: await calendarAutoRecordAllowed(workspace.organization.id),
    canManage: POLICY_ROLES.has(workspace.membership.role),
  };
}

const policyBodySchema = z.object({ autoRecordAllowed: z.boolean() }).strict();

export async function updateCalendarPolicy(input: { body: unknown; requestId: string; workspace: CalendarWorkspace }) {
  if (!POLICY_ROLES.has(input.workspace.membership.role)) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Only owners and admins change the organization's recording policy.");
  }
  const parsed = policyBodySchema.safeParse(input.body);
  if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID", "Send { autoRecordAllowed: true | false }.");
  const organizationId = input.workspace.organization.id;
  const enabled = parsed.data.autoRecordAllowed;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ valueJson: schema.organizationPolicies.valueJson })
      .from(schema.organizationPolicies)
      .where(
        and(
          eq(schema.organizationPolicies.organizationId, organizationId),
          eq(schema.organizationPolicies.key, CALENDAR_AUTO_RECORD_POLICY),
        ),
      )
      .limit(1);
    const wasEnabled = before?.valueJson?.enabled === true;
    if (wasEnabled === enabled) return;
    await tx
      .insert(schema.organizationPolicies)
      .values({
        organizationId,
        key: CALENDAR_AUTO_RECORD_POLICY,
        valueJson: { enabled },
        updatedByUserId: input.workspace.user.id,
      })
      .onConflictDoUpdate({
        target: [schema.organizationPolicies.organizationId, schema.organizationPolicies.key],
        set: { valueJson: { enabled }, updatedByUserId: input.workspace.user.id, updatedAt: new Date() },
      });
    await tx.insert(schema.auditEvents).values({
      action: "organization_policy.updated",
      actorId: input.workspace.user.id,
      actorType: "user",
      afterJson: { key: CALENDAR_AUTO_RECORD_POLICY, enabled },
      beforeJson: { key: CALENDAR_AUTO_RECORD_POLICY, enabled: wasEnabled },
      metadataJson: { source: SOURCE },
      organizationId,
      requestId: input.requestId,
      targetId: organizationId,
      targetType: "organization",
    });
  });
  return getCalendarPolicy(input.workspace);
}

// ---------------------------------------------------------------------------
// Settings per Google connection
// ---------------------------------------------------------------------------

export function hasCalendarScope(scopes: readonly string[]) {
  return scopes.some((scope) => CALENDAR_SCOPES.has(scope));
}

export type CalendarSettingsView = {
  syncEnabled: boolean;
  recordMode: (typeof CALENDAR_RECORD_MODES)[number] | null;
  effectiveRecordMode: (typeof CALENDAR_RECORD_MODES)[number] | null;
  projectId: string | null;
  briefingEnabled: boolean | null;
  briefingMinutes: number;
  followupEnabled: boolean | null;
};

function serializeSettings(row: SettingsRecord | null, autoRecordAllowed: boolean): CalendarSettingsView {
  const recordMode = effectiveRecordMode(row?.recordMode ?? null, true);
  return {
    syncEnabled: row?.syncEnabled ?? false,
    recordMode,
    effectiveRecordMode: effectiveRecordMode(recordMode, autoRecordAllowed),
    projectId: row?.projectId ?? null,
    briefingEnabled: row?.briefingEnabled ?? null,
    briefingMinutes: row?.briefingMinutes ?? 30,
    followupEnabled: row?.followupEnabled ?? null,
  };
}

function serializeConnection(connection: ConnectionRecord, settings: SettingsRecord | null, autoRecordAllowed: boolean) {
  return {
    connectionId: connection.id,
    email: connection.externalAccountLogin,
    displayName: connection.displayName,
    status: connection.status,
    hasCalendarScope: hasCalendarScope(connection.scopesJson ?? []),
    settings: serializeSettings(settings, autoRecordAllowed),
    lastSyncedAt: settings?.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: settings?.lastSyncError ?? null,
  };
}

async function ownGoogleConnections(workspace: CalendarWorkspace, connectionId?: string) {
  return db
    .select({ connection: schema.providerConnections, settings: schema.calendarSettings })
    .from(schema.providerConnections)
    .leftJoin(schema.calendarSettings, eq(schema.calendarSettings.providerConnectionId, schema.providerConnections.id))
    .where(
      and(
        eq(schema.providerConnections.organizationId, workspace.organization.id),
        eq(schema.providerConnections.userId, workspace.user.id),
        eq(schema.providerConnections.provider, GOOGLE_PROVIDER),
        eq(schema.providerConnections.scopeKind, "user"),
        isNull(schema.providerConnections.revokedAt),
        inArray(schema.providerConnections.status, [...LIVE_CONNECTION_STATUSES]),
        connectionId ? eq(schema.providerConnections.id, connectionId) : undefined,
      ),
    )
    .orderBy(asc(schema.providerConnections.createdAt));
}

/** The projects this person can write, where calendar recordings may go. */
export async function writableProjects(workspace: CalendarWorkspace) {
  const projects = await listAccessibleProjectRecords(workspace);
  const writable = await Promise.all(projects.map((project) => canAccessProject(workspace, project.id, "write")));
  return projects.filter((_project, index) => writable[index]);
}

async function meetingsFeatureEnabled(workspace: CalendarWorkspace) {
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: workspace.organization.id,
    role: workspace.membership.role,
  });
  const feature = access.byKey[MEETINGS_FEATURE_KEY];
  return feature.available && feature.authorized;
}

export async function getCalendarOverview(workspace: CalendarWorkspace) {
  const [rows, policy, projects] = await Promise.all([
    ownGoogleConnections(workspace),
    getCalendarPolicy(workspace),
    writableProjects(workspace),
  ]);
  return {
    connections: rows.map((row) => serializeConnection(row.connection, row.settings, policy.autoRecordAllowed)),
    policy,
    meetingsEnabled: await meetingsFeatureEnabled(workspace),
    projects: projects.map((project) => ({ id: project.id, slug: project.slug, name: project.name })),
  };
}

const settingsBodySchema = z
  .object({
    connectionId: z.string().uuid(),
    syncEnabled: z.boolean().optional(),
    recordMode: z.enum(CALENDAR_RECORD_MODES).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    briefingEnabled: z.boolean().nullable().optional(),
    briefingMinutes: z.number().int().min(5).max(240).optional(),
    followupEnabled: z.boolean().nullable().optional(),
  })
  .strict();

const SETTINGS_FIELDS = [
  "syncEnabled",
  "recordMode",
  "projectId",
  "briefingEnabled",
  "briefingMinutes",
  "followupEnabled",
] as const;

export async function updateCalendarSettings(input: { body: unknown; requestId: string; workspace: CalendarWorkspace }) {
  const parsed = settingsBodySchema.safeParse(input.body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid calendar settings: ${fields.join(", ")}.`);
  }
  const body = parsed.data;
  const { workspace } = input;
  const [found] = await ownGoogleConnections(workspace, body.connectionId);
  if (!found) throw cliApiError(404, "NOT_FOUND", "No Google connection of yours with that id in this organization.");
  const { connection } = found;
  const before = serializeSettings(found.settings, true);

  const next = {
    syncEnabled: body.syncEnabled ?? before.syncEnabled,
    recordMode: body.recordMode === undefined ? before.recordMode : body.recordMode,
    projectId: body.projectId === undefined ? before.projectId : body.projectId,
    briefingEnabled: body.briefingEnabled === undefined ? before.briefingEnabled : body.briefingEnabled,
    briefingMinutes: body.briefingMinutes ?? before.briefingMinutes,
    followupEnabled: body.followupEnabled === undefined ? before.followupEnabled : body.followupEnabled,
  };

  if (next.syncEnabled && !hasCalendarScope(connection.scopesJson ?? [])) {
    throw cliApiError(409, "CALENDAR_SCOPE_MISSING");
  }
  const autoRecordAllowed = await calendarAutoRecordAllowed(workspace.organization.id);
  if (body.recordMode === "auto" && !autoRecordAllowed) {
    throw cliApiError(403, "POLICY_DISABLED", "Automatic recording is off in this organization. An owner or admin turns it on.");
  }
  if (body.projectId) {
    const writable = await writableProjects(workspace);
    if (!writable.some((project) => project.id === body.projectId)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", "You cannot write to that project.");
    }
  }
  if (next.recordMode === "ask" || next.recordMode === "auto") {
    if (!next.projectId) {
      throw cliApiError(400, "PAYLOAD_INVALID", "Choose the project where recordings of this calendar go.");
    }
    if (body.recordMode !== undefined && !(await meetingsFeatureEnabled(workspace))) {
      throw cliApiError(400, "PAYLOAD_INVALID", "Meetings are not enabled in this organization.");
    }
  }

  const changed: JsonRecord = {};
  const previous: JsonRecord = {};
  for (const field of SETTINGS_FIELDS) {
    if (next[field] !== before[field]) {
      changed[field] = next[field];
      previous[field] = before[field];
    }
  }

  if (Object.keys(changed).length > 0 || !found.settings) {
    await db.transaction(async (tx) => {
      const values = { ...next, updatedAt: new Date() };
      await tx
        .insert(schema.calendarSettings)
        .values({
          organizationId: workspace.organization.id,
          userId: workspace.user.id,
          providerConnectionId: connection.id,
          ...next,
        })
        .onConflictDoUpdate({ target: schema.calendarSettings.providerConnectionId, set: values });
      if (Object.keys(changed).length === 0) return;
      await tx.insert(schema.auditEvents).values({
        action: "calendar.settings.updated",
        actorId: workspace.user.id,
        actorType: "user",
        afterJson: changed,
        beforeJson: previous,
        metadataJson: { source: SOURCE },
        organizationId: workspace.organization.id,
        requestId: input.requestId,
        targetId: connection.id,
        targetType: "provider_connection",
      });
    });
  }

  const [saved] = await ownGoogleConnections(workspace, connection.id);
  if (!saved) throw cliApiError(404, "NOT_FOUND");
  return serializeConnection(saved.connection, saved.settings, autoRecordAllowed);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type EventWithContext = {
  event: EventRecord;
  settings: SettingsRecord | null;
  bot: typeof schema.meetingBots.$inferSelect | null;
};

export function serializeCalendarEvent(row: EventWithContext, autoRecordAllowed: boolean) {
  const { event, bot } = row;
  return {
    id: event.id,
    connectionId: event.providerConnectionId,
    title: event.title,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    allDay: event.allDay,
    status: event.status,
    meetingUrl: event.meetingUrl,
    meetingCode: event.meetingCode,
    organizerEmail: event.organizerEmail,
    selfResponse: event.selfResponse,
    attendees: (event.attendeesJson ?? []) as CalendarAttendee[],
    externalAttendees: event.externalAttendees,
    recurringEventId: event.recurringEventId,
    recordDecision: event.recordDecision as "record" | "skip" | null,
    recordDecisionProjectId: event.recordDecisionProjectId,
    recordError: event.recordError,
    effectiveRecordMode: effectiveRecordMode(row.settings?.recordMode ?? null, autoRecordAllowed),
    briefingEnabled: row.settings?.briefingEnabled ?? null,
    briefingMinutes: row.settings?.briefingMinutes ?? 30,
    followupEnabled: row.settings?.followupEnabled ?? null,
    recording: bot
      ? {
          meetingId: bot.id,
          status: bot.status,
          ready: bot.status === "done" && bot.readyNotifiedAt !== null,
          projectId: bot.projectId,
        }
      : null,
    hasBriefing: Boolean(event.briefingMarkdown),
    updatedAt: event.updatedAt.toISOString(),
    deletedAt: event.deletedAt?.toISOString() ?? null,
  };
}

export type CalendarEventView = ReturnType<typeof serializeCalendarEvent>;

function eventsQuery() {
  return db
    .select({ event: schema.calendarEvents, settings: schema.calendarSettings, bot: schema.meetingBots })
    .from(schema.calendarEvents)
    .leftJoin(schema.calendarSettings, eq(schema.calendarSettings.providerConnectionId, schema.calendarEvents.providerConnectionId))
    .leftJoin(schema.meetingBots, eq(schema.meetingBots.id, schema.calendarEvents.meetingBotId));
}

function parseInstant(value: string | null, name: string) {
  if (value === null || value === "") return null;
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID", `${name} must be an ISO 8601 date-time.`);
  return new Date(parsed.data);
}

export async function listCalendarEvents(input: { searchParams: URLSearchParams; workspace: CalendarWorkspace; now?: Date }) {
  const now = input.now ?? new Date();
  const from = parseInstant(input.searchParams.get("from"), "from") ?? new Date(now.getTime() - EVENTS_DEFAULT_BACK_MS);
  const to = parseInstant(input.searchParams.get("to"), "to") ?? new Date(from.getTime() + EVENTS_DEFAULT_BACK_MS + EVENTS_DEFAULT_AHEAD_MS);
  const updatedSince = parseInstant(input.searchParams.get("updatedSince"), "updatedSince");
  if (to.getTime() <= from.getTime()) throw cliApiError(400, "PAYLOAD_INVALID", "to must be after from.");
  if (to.getTime() - from.getTime() > EVENTS_MAX_SPAN_MS) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Ask for at most 31 days at a time.");
  }
  const { workspace } = input;
  const rows = await eventsQuery()
    .where(
      and(
        eq(schema.calendarEvents.organizationId, workspace.organization.id),
        eq(schema.calendarEvents.userId, workspace.user.id),
        gte(schema.calendarEvents.endAt, from),
        lte(schema.calendarEvents.startAt, to),
        updatedSince
          ? gte(schema.calendarEvents.updatedAt, updatedSince)
          : isNull(schema.calendarEvents.deletedAt),
      ),
    )
    .orderBy(asc(schema.calendarEvents.startAt), asc(schema.calendarEvents.id))
    .limit(EVENTS_MAX + 1);
  const autoRecordAllowed = await calendarAutoRecordAllowed(workspace.organization.id);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    events: rows.slice(0, EVENTS_MAX).map((row) => serializeCalendarEvent(row, autoRecordAllowed)),
    truncated: rows.length > EVENTS_MAX,
  };
}

async function ownEvent(workspace: CalendarWorkspace, eventId: string) {
  if (!uuidSchema.safeParse(eventId).success) throw cliApiError(404, "NOT_FOUND", "Calendar event not found.");
  const [row] = await eventsQuery()
    .where(
      and(
        eq(schema.calendarEvents.id, eventId),
        eq(schema.calendarEvents.organizationId, workspace.organization.id),
        eq(schema.calendarEvents.userId, workspace.user.id),
      ),
    )
    .limit(1);
  if (!row) throw cliApiError(404, "NOT_FOUND", "Calendar event not found.");
  return row;
}

export async function getCalendarEvent(input: { eventId: string; workspace: CalendarWorkspace }) {
  const row = await ownEvent(input.workspace, input.eventId);
  const autoRecordAllowed = await calendarAutoRecordAllowed(input.workspace.organization.id);
  return { event: { ...serializeCalendarEvent(row, autoRecordAllowed), briefing: row.event.briefingMarkdown ?? null } };
}

const decisionBodySchema = z
  .object({
    decision: z.enum(["record", "skip"]).nullable(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type RecordNow = (input: { eventId: string; requestId: string; now: Date }) => Promise<unknown>;

export async function setCalendarEventDecision(
  input: { body: unknown; eventId: string; requestId: string; workspace: CalendarWorkspace; now?: Date },
  deps: { recordNow?: RecordNow } = {},
) {
  const parsed = decisionBodySchema.safeParse(input.body);
  if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID", 'Send { decision: "record" | "skip" | null, projectId? }.');
  const body = parsed.data;
  const now = input.now ?? new Date();
  const { workspace } = input;
  const row = await ownEvent(workspace, input.eventId);
  const { event } = row;
  if (event.deletedAt || event.status === "cancelled") throw cliApiError(409, "CONFLICT", "This event was cancelled.");
  if (event.startAt.getTime() <= now.getTime()) throw cliApiError(409, "CONFLICT", "This meeting already started.");

  let projectId: string | null = null;
  if (body.decision === "record") {
    if (!event.meetingCode) throw cliApiError(400, "PAYLOAD_INVALID", "This event has no Google Meet link.");
    if (!(await meetingsFeatureEnabled(workspace))) {
      throw cliApiError(400, "PAYLOAD_INVALID", "Meetings are not enabled in this organization.");
    }
    projectId = body.projectId ?? row.settings?.projectId ?? null;
    if (!projectId) throw cliApiError(400, "PAYLOAD_INVALID", "Choose the project where this recording goes.");
    const writable = await writableProjects(workspace);
    if (!writable.some((project) => project.id === projectId)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", "You cannot write to that project.");
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.calendarEvents)
      .set({
        recordDecision: body.decision,
        recordDecisionProjectId: body.decision === "record" ? projectId : null,
        recordDecidedAt: body.decision ? now : null,
        recordError: null,
        updatedAt: now,
      })
      .where(eq(schema.calendarEvents.id, event.id));
    await tx.insert(schema.auditEvents).values({
      action: "calendar.event.decision",
      actorId: workspace.user.id,
      actorType: "user",
      afterJson: { decision: body.decision, projectId },
      beforeJson: { decision: event.recordDecision, projectId: event.recordDecisionProjectId },
      metadataJson: { source: SOURCE, meetingCode: event.meetingCode },
      organizationId: workspace.organization.id,
      projectId,
      requestId: input.requestId,
      targetId: event.id,
      targetType: "calendar_event",
    });
  });

  if (
    body.decision === "record" &&
    !event.meetingBotId &&
    event.startAt.getTime() - now.getTime() <= RECORD_WINDOW_MS &&
    deps.recordNow
  ) {
    await deps.recordNow({ eventId: event.id, requestId: input.requestId, now });
  }
  return getCalendarEvent({ eventId: event.id, workspace });
}

const briefingBodySchema = z.object({ markdown: z.string().max(BRIEFING_MAX_CHARS) }).strict();

export async function setCalendarEventBriefing(input: { body: unknown; eventId: string; workspace: CalendarWorkspace }) {
  const parsed = briefingBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Send { markdown } with at most ${BRIEFING_MAX_CHARS} characters.`);
  }
  const row = await ownEvent(input.workspace, input.eventId);
  const markdown = parsed.data.markdown.trim();
  const now = new Date();
  await db
    .update(schema.calendarEvents)
    .set({ briefingMarkdown: markdown || null, briefingUpdatedAt: markdown ? now : null, updatedAt: now })
    .where(eq(schema.calendarEvents.id, row.event.id));
  return getCalendarEvent({ eventId: row.event.id, workspace: input.workspace });
}

/** The owner's briefing for a meeting bot, for the meeting page; null for anyone else. */
export async function getOwnBriefingForMeeting(input: { meetingBotId: string; userId: string; organizationId: string }) {
  const [row] = await db
    .select({
      eventId: schema.calendarEvents.id,
      markdown: schema.calendarEvents.briefingMarkdown,
      updatedAt: schema.calendarEvents.briefingUpdatedAt,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.meetingBotId, input.meetingBotId),
        eq(schema.calendarEvents.userId, input.userId),
        eq(schema.calendarEvents.organizationId, input.organizationId),
        isNotNull(schema.calendarEvents.briefingMarkdown),
      ),
    )
    .limit(1);
  if (!row?.markdown) return null;
  return { eventId: row.eventId, markdown: row.markdown, updatedAt: row.updatedAt?.toISOString() ?? null };
}
