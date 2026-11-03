/**
 * Calendar sync (spec `console/calendar`, "Sync"): for each Google
 * connection whose owner turned sync on, keep the primary calendar's window
 * of one day back to 30 days ahead in `calendar_events`. The access token is
 * read and refreshed here and never leaves the Worker; the Console reads
 * only the rows.
 */

import type { ConnectorAdapter } from "./adapters/adapter";
import {
  leaseCalendarSyncTargets,
  listOrganizationMemberEmails,
  markMissingCalendarEventsDeleted,
  recordCalendarSyncResult,
  upsertCalendarEvents,
  type CalendarEventUpsert,
  type CalendarSyncTarget,
  type ConnectorsDb,
  type MaintenanceScope,
} from "./db";
import { ConnectionReauthRequiredError, resolveConnectionAccessToken } from "./proxy";

export const CALENDAR_SYNC_BATCH = 50;
/** A connection is synced at most this often, so overlapping runs never repeat work. */
export const CALENDAR_SYNC_MIN_INTERVAL_SECONDS = 4 * 60;
const WINDOW_BACK_MS = 24 * 3600 * 1000;
const WINDOW_AHEAD_MS = 30 * 24 * 3600 * 1000;
const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const MAX_ATTENDEES = 100;
const MAX_TITLE = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const GCAL_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const FIELDS =
  "nextPageToken,items(id,status,summary,start,end,hangoutLink,conferenceData/entryPoints(entryPointType,uri)," +
  "organizer/email,attendees(email,displayName,responseStatus,organizer,self,resource),recurringEventId,iCalUID,updated)";
const CALENDAR_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
]);
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export interface CalendarSyncDeps {
  db: ConnectorsDb;
  rootWrapKey: CryptoKey;
  dekKeyVersion: number;
  adapters: Map<string, ConnectorAdapter>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  scope?: MaintenanceScope;
}

export interface CalendarSyncReport {
  connections: number;
  synced: number;
  failed: number;
  written: number;
  removed: number;
}

export async function runCalendarSync(deps: CalendarSyncDeps): Promise<CalendarSyncReport> {
  const report: CalendarSyncReport = { connections: 0, synced: 0, failed: 0, written: 0, removed: 0 };
  const targets = await leaseCalendarSyncTargets(deps.db, {
    limit: CALENDAR_SYNC_BATCH,
    minIntervalSeconds: CALENDAR_SYNC_MIN_INTERVAL_SECONDS,
    scope: deps.scope,
  });
  const membersByOrg = new Map<string, Set<string>>();
  for (const target of targets) {
    report.connections += 1;
    let members = membersByOrg.get(target.connection.organizationId);
    if (!members) {
      members = await listOrganizationMemberEmails(deps.db, target.connection.organizationId);
      membersByOrg.set(target.connection.organizationId, members);
    }
    let error: string | null;
    try {
      error = await syncOne(deps, target, members, report);
    } catch (thrown) {
      logError("calendar_sync_connection", thrown);
      error = "internal_error";
    }
    if (error) report.failed += 1;
    else report.synced += 1;
    await recordCalendarSyncResult(deps.db, { settingsId: target.settingsId, error });
  }
  return report;
}

/** Returns the short error code stored on the settings row, or null. */
async function syncOne(
  deps: CalendarSyncDeps,
  target: CalendarSyncTarget,
  memberEmails: ReadonlySet<string>,
  report: CalendarSyncReport,
): Promise<string | null> {
  const { connection } = target;
  if (!connection.userId || connection.provider !== "google") return "unsupported_connection";
  if (!connection.scopesJson.some((scope) => CALENDAR_SCOPES.has(scope))) return "calendar_scope_missing";
  if (connection.requiresReauth) return "auth_required";

  let accessToken: string;
  try {
    ({ accessToken } = await resolveConnectionAccessToken(deps, connection));
  } catch (error) {
    if (error instanceof ConnectionReauthRequiredError) {
      return error.reason === "refresh_failed" ? "refresh_failed" : "auth_required";
    }
    logError("calendar_sync_token", error);
    return "internal_error";
  }

  const now = (deps.now ?? (() => new Date()))();
  const timeMin = new Date(now.getTime() - WINDOW_BACK_MS);
  const timeMax = new Date(now.getTime() + WINDOW_AHEAD_MS);
  const listed = await listEvents({ accessToken, timeMin, timeMax, fetchImpl: deps.fetchImpl ?? fetch });
  if (!listed.ok) return listed.error;

  const self = connection.externalAccountLogin?.toLowerCase() ?? null;
  const events = listed.items.flatMap((item) => {
    const event = normalizeGoogleEvent(item, { ownerEmail: self, memberEmails });
    return event ? [event] : [];
  });
  report.written += await upsertCalendarEvents(deps.db, {
    connection: { id: connection.id, organizationId: connection.organizationId, userId: connection.userId },
    events,
  });
  // Removal needs the whole window: a listing cut by the page cap removes nothing.
  if (listed.complete) {
    report.removed += await markMissingCalendarEventsDeleted(deps.db, {
      connectionId: connection.id,
      timeMin,
      timeMax,
      keepProviderEventIds: events.map((event) => event.providerEventId),
    });
  }
  return null;
}

type ListResult = { ok: true; items: GoogleEvent[]; complete: boolean } | { ok: false; error: string };

async function listEvents(input: {
  accessToken: string;
  timeMin: Date;
  timeMax: Date;
  fetchImpl: typeof fetch;
}): Promise<ListResult> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(GCAL_EVENTS_URL);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", input.timeMin.toISOString());
    url.searchParams.set("timeMax", input.timeMax.toISOString());
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("fields", FIELDS);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await input.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: abort.signal,
      });
    } catch {
      return { ok: false, error: "provider_unreachable" };
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) return { ok: false, error: "auth_required" };
    if (response.status === 429) return { ok: false, error: "rate_limited" };
    if (!response.ok) return { ok: false, error: `provider_${response.status}` };
    const body = (await response.json().catch(() => null)) as { items?: unknown; nextPageToken?: unknown } | null;
    if (!body || !Array.isArray(body.items)) return { ok: false, error: "provider_response_invalid" };
    items.push(...(body.items as GoogleEvent[]));
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) return { ok: true, items, complete: true };
  }
  return { ok: true, items, complete: false };
}

export interface GoogleEvent {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
  hangoutLink?: unknown;
  conferenceData?: { entryPoints?: { entryPointType?: unknown; uri?: unknown }[] };
  organizer?: { email?: unknown };
  attendees?: { email?: unknown; displayName?: unknown; responseStatus?: unknown; organizer?: unknown; self?: unknown; resource?: unknown }[];
  recurringEventId?: unknown;
  iCalUID?: unknown;
  updated?: unknown;
}

/**
 * What the table keeps of one Google event: no description, no location.
 * Returns null for an event without an id or a readable start and end.
 */
export function normalizeGoogleEvent(
  item: GoogleEvent,
  context: { ownerEmail: string | null; memberEmails: ReadonlySet<string> },
): CalendarEventUpsert | null {
  const id = text(item.id);
  const start = eventTime(item.start);
  const end = eventTime(item.end);
  if (!id || !start || !end) return null;

  const attendees = (Array.isArray(item.attendees) ? item.attendees : [])
    .filter((attendee) => attendee && attendee.resource !== true && text(attendee.email))
    .slice(0, MAX_ATTENDEES)
    .map((attendee) => ({
      email: text(attendee.email)!.toLowerCase(),
      name: text(attendee.displayName)?.slice(0, 200) ?? null,
      response: text(attendee.responseStatus),
      organizer: attendee.organizer === true,
      self: attendee.self === true,
    }));
  const owner = context.ownerEmail;
  const selfAttendee = attendees.find((attendee) => attendee.self) ?? attendees.find((attendee) => owner && attendee.email === owner);
  const externalAttendees = attendees.some(
    (attendee) => !attendee.self && attendee.email !== owner && !context.memberEmails.has(attendee.email),
  );
  const meeting = meetLink(item);
  const updated = text(item.updated);
  const updatedAt = updated ? new Date(updated) : null;

  return {
    providerEventId: id.slice(0, 1024),
    icalUid: text(item.iCalUID)?.slice(0, 1024) ?? null,
    recurringEventId: text(item.recurringEventId)?.slice(0, 1024) ?? null,
    title: (text(item.summary) ?? "").slice(0, MAX_TITLE),
    startAt: start.at,
    endAt: end.at,
    allDay: start.allDay,
    status: text(item.status) ?? "confirmed",
    meetingUrl: meeting?.url ?? null,
    meetingCode: meeting?.code ?? null,
    organizerEmail: text(item.organizer?.email)?.toLowerCase() ?? null,
    // An event with no attendee list is the owner's own: they are going.
    selfResponse: selfAttendee?.response ?? (attendees.length === 0 ? "accepted" : null),
    attendees,
    externalAttendees,
    providerUpdatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
  };
}

function meetLink(item: GoogleEvent): { url: string; code: string } | null {
  const candidates = [
    text(item.hangoutLink),
    ...(item.conferenceData?.entryPoints ?? [])
      .filter((entry) => entry?.entryPointType === "video")
      .map((entry) => text(entry.uri)),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.hostname.toLowerCase() !== "meet.google.com") continue;
    const code = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (MEET_CODE.test(code)) return { url: `https://meet.google.com/${code}`, code };
  }
  return null;
}

function eventTime(value: { dateTime?: unknown; date?: unknown } | undefined): { at: Date; allDay: boolean } | null {
  const dateTime = text(value?.dateTime);
  if (dateTime) {
    const at = new Date(dateTime);
    return Number.isNaN(at.getTime()) ? null : { at, allDay: false };
  }
  const date = text(value?.date);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return { at: new Date(`${date}T00:00:00Z`), allDay: true };
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function logError(task: string, error: unknown): void {
  console.error("ravi-connectors calendar sync failed", {
    task,
    name: error instanceof Error ? error.name : "unknown",
  });
}
