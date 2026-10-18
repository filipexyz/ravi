// The Console calendar (provider `ravi-calendar`): the person's Google
// calendar as the Console keeps it, their recording settings, and one
// briefing per meeting. Transport only: the Console decides who may record,
// the organization rule and external attendees.
//
//   GET  /api/cli/calendar                      connections, settings, policy, projects
//   POST /api/cli/calendar/settings             change one connection's settings
//   GET  /api/cli/calendar/events?from&to       the person's events
//   GET  /api/cli/calendar/events/:id           one event with its briefing
//   POST /api/cli/calendar/events/:id/decision  record, skip or clear
//   POST /api/cli/calendar/events/:id/briefing  store the briefing (empty deletes)

import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import { requestConsoleWithRefresh, type ConsoleRefreshingSession } from "../meetings/cloud.js";

export const CALENDAR_API_ROOT = "/api/cli/calendar";
export const CALENDAR_RECORD_MODES = ["ask", "auto", "off"] as const;
export const CALENDAR_BRIEFING_MAX_CHARS = 20_000;
/** The Console answers at most this span per events request. */
export const CALENDAR_EVENTS_MAX_SPAN_MS = 31 * 24 * 3600 * 1000;

export type CalendarRecordMode = (typeof CALENDAR_RECORD_MODES)[number];
export type CalendarRecordDecision = "record" | "skip";

export interface ConsoleCalendarSettings {
  syncEnabled: boolean;
  recordMode: CalendarRecordMode | null;
  projectId: string | null;
  briefingEnabled: boolean | null;
  briefingMinutes: number;
  followupEnabled: boolean | null;
}

export interface ConsoleCalendarConnection {
  connectionId: string;
  email: string | null;
  displayName: string | null;
  hasCalendarScope: boolean;
  settings: ConsoleCalendarSettings;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface ConsoleCalendarOverview {
  connections: ConsoleCalendarConnection[];
  policy: { autoRecordAllowed: boolean; canManage: boolean };
  meetingsEnabled: boolean;
  projects: Array<{ id: string; slug: string; name: string }>;
}

export interface ConsoleCalendarAttendee {
  email: string;
  name: string | null;
  response: string | null;
  organizer: boolean;
  self: boolean;
}

export interface ConsoleCalendarEvent {
  id: string;
  connectionId: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  meetingUrl: string | null;
  meetingCode: string | null;
  organizerEmail: string | null;
  selfResponse: string | null;
  attendees: ConsoleCalendarAttendee[];
  externalAttendees: boolean;
  recurringEventId: string | null;
  recordDecision: CalendarRecordDecision | null;
  recordDecisionProjectId: string | null;
  recordError: string | null;
  /** `null` (never chosen), `off`, `ask` or `auto`; `auto` already reads `ask` while the organization rule is off. */
  effectiveRecordMode: CalendarRecordMode | null;
  briefingEnabled: boolean | null;
  briefingMinutes: number;
  followupEnabled: boolean | null;
  recording: { meetingId: string; status: string; ready: boolean; projectId: string | null } | null;
  hasBriefing: boolean;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ConsoleCalendarEventDetail extends ConsoleCalendarEvent {
  briefing: string | null;
}

export interface ConsoleCalendarSettingsPatch {
  connectionId: string;
  syncEnabled?: boolean;
  recordMode?: CalendarRecordMode | null;
  projectId?: string | null;
  briefingEnabled?: boolean | null;
  briefingMinutes?: number;
  followupEnabled?: boolean | null;
}

export interface CalendarConsoleClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

/** The person's Console calendar, with the token refreshed once when it expires. */
export class CalendarConsoleClient {
  constructor(private readonly session: ConsoleRefreshingSession) {}

  get consoleUrl(): string {
    return this.session.credentials.consoleUrl;
  }

  async overview(): Promise<ConsoleCalendarOverview> {
    const payload = await this.request<Partial<ConsoleCalendarOverview>>("GET", "");
    if (!payload || !Array.isArray(payload.connections) || !payload.policy) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected calendar overview.");
    }
    return {
      connections: payload.connections,
      policy: payload.policy,
      meetingsEnabled: payload.meetingsEnabled === true,
      projects: Array.isArray(payload.projects) ? payload.projects : [],
    };
  }

  async updateSettings(patch: ConsoleCalendarSettingsPatch): Promise<ConsoleCalendarConnection> {
    const payload = await this.request<{ connection?: ConsoleCalendarConnection }>("POST", "/settings", patch);
    if (!payload?.connection?.connectionId) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned settings without a connection.");
    }
    return payload.connection;
  }

  async events(window: { from: Date; to: Date }): Promise<{ events: ConsoleCalendarEvent[]; truncated: boolean }> {
    const query = new URLSearchParams({ from: window.from.toISOString(), to: window.to.toISOString() });
    const payload = await this.request<{ events?: unknown; truncated?: unknown }>("GET", `/events?${query}`);
    if (!payload || !Array.isArray(payload.events)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected calendar listing.");
    }
    return { events: payload.events.map(requireEvent), truncated: payload.truncated === true };
  }

  async event(eventId: string): Promise<ConsoleCalendarEventDetail> {
    const payload = await this.request<{ event?: unknown }>("GET", `/events/${encodeURIComponent(eventId)}`);
    const event = requireEvent(payload?.event) as ConsoleCalendarEventDetail;
    return { ...event, briefing: typeof event.briefing === "string" ? event.briefing : null };
  }

  async decide(
    eventId: string,
    body: { decision: CalendarRecordDecision | null; projectId?: string | null },
  ): Promise<ConsoleCalendarEvent> {
    const payload = await this.request<{ event?: unknown }>(
      "POST",
      `/events/${encodeURIComponent(eventId)}/decision`,
      body,
    );
    return requireEvent(payload?.event);
  }

  async setBriefing(eventId: string, markdown: string): Promise<ConsoleCalendarEvent> {
    const payload = await this.request<{ event?: unknown }>("POST", `/events/${encodeURIComponent(eventId)}/briefing`, {
      markdown,
    });
    return requireEvent(payload?.event);
  }

  private request<T>(method: string, relativePath: string, body?: unknown): Promise<T> {
    return requestConsoleWithRefresh<T>(this.session, method, `${CALENDAR_API_ROOT}${relativePath}`, body);
  }
}

/** A client for the `ravi login` user, or null when there is no login. */
export function openCalendarConsoleClient(deps: CalendarConsoleClientDeps = {}): CalendarConsoleClient | null {
  const credentials = (deps.readCredentials ?? readCloudCredentials)();
  if (!credentials) return null;
  return new CalendarConsoleClient({
    client: deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl }),
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
}

export function requireCalendarConsoleClient(deps: CalendarConsoleClientDeps = {}): CalendarConsoleClient {
  const client = openCalendarConsoleClient(deps);
  if (!client) throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  return client;
}

/** The Console page of a recorded meeting, for links in messages. */
export function consoleMeetingUrl(consoleUrl: string, event: Pick<ConsoleCalendarEvent, "recording">): string | null {
  const recording = event.recording;
  if (!recording?.projectId) return null;
  return `${consoleUrl}/p/${recording.projectId}/meetings/${recording.meetingId}`;
}

function requireEvent(value: unknown): ConsoleCalendarEvent {
  const event = value as Partial<ConsoleCalendarEvent> | null;
  if (!event || typeof event.id !== "string" || typeof event.startAt !== "string") {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a calendar event without an id.");
  }
  return {
    ...event,
    attendees: Array.isArray(event.attendees) ? event.attendees : [],
    recording: event.recording ?? null,
  } as ConsoleCalendarEvent;
}
