// What the calendar routes answer (`/api/console/calendar/...`, spec `console/calendar`).

export type CalendarRecordMode = "off" | "ask" | "auto";

export type CalendarSettings = {
  syncEnabled: boolean;
  recordMode: CalendarRecordMode | null;
  /** `auto` reads as `ask` while the organization's policy is off. */
  effectiveRecordMode: CalendarRecordMode | null;
  projectId: string | null;
  briefingEnabled: boolean | null;
  briefingMinutes: number;
  followupEnabled: boolean | null;
};

export type CalendarConnection = {
  connectionId: string;
  email: string | null;
  displayName: string;
  status: string;
  hasCalendarScope: boolean;
  settings: CalendarSettings;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};

export type CalendarOverview = {
  connections: CalendarConnection[];
  policy: CalendarPolicy;
  meetingsEnabled: boolean;
  projects: { id: string; slug: string; name: string }[];
};

export type CalendarPolicy = { autoRecordAllowed: boolean; canManage: boolean };

export type CalendarSettingsInput = { connectionId: string } & Partial<Omit<CalendarSettings, "effectiveRecordMode">>;

export type CalendarAttendee = { email: string; name: string | null; response: string | null; organizer: boolean; self: boolean };

export type CalendarEvent = {
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
  attendees: CalendarAttendee[];
  externalAttendees: boolean;
  recordDecision: "record" | "skip" | null;
  recordDecisionProjectId: string | null;
  recordError: string | null;
  effectiveRecordMode: CalendarRecordMode | null;
  recording: { meetingId: string; status: string; ready: boolean; projectId: string | null } | null;
  hasBriefing: boolean;
  updatedAt: string;
  deletedAt: string | null;
};

export type CalendarBriefing = { eventId: string; markdown: string; updatedAt: string | null };
