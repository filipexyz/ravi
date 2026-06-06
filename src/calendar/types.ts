export type CalendarProvider = "local" | "ravi-calendar" | "google-calendar" | "caldav" | (string & {});

export type CalendarAccountStatus = "active" | "paused" | "auth_required" | "disabled";
export type CalendarRole = "primary" | "secondary" | "shared" | "resource" | "system" | "unknown";
export type CalendarStatus = "active" | "paused" | "disabled" | "deleted";
export type CalendarVisibility = "private" | "shared" | "public" | "local_only";
export type CalendarOwnerType = "contact" | "agent" | "system" | (string & {});
export type CalendarMemberType = "contact" | "agent" | "system" | (string & {});
export type CalendarMemberRelation = "owner" | "reader" | "writer" | "manager" | "free_busy";
export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
export type CalendarBusyStatus = "busy" | "free" | "tentative" | "out_of_office" | "unknown";
export type CalendarEventVisibility = "default" | "private" | "public" | "confidential";
export type CalendarRedactionStatus = "full_local" | "preview_only" | "redacted" | "missing";
export type CalendarAttendeeKind = "organizer" | "required" | "optional" | "resource" | "informational";
export type CalendarResponseStatus = "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
export type CalendarOutboxOperation = "create" | "update" | "cancel" | "delete" | "respond";
export type CalendarOutboxStatus = "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";

export interface CalendarAccount {
  id: string;
  provider: CalendarProvider;
  displayName: string;
  status: CalendarAccountStatus;
  defaultCalendarId: string | null;
  credentialsRef: string | null;
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarCalendar {
  id: string;
  accountId: string;
  providerCalendarId: string | null;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  role: CalendarRole;
  status: CalendarStatus;
  visibility: CalendarVisibility;
  ownerType: CalendarOwnerType;
  ownerId: string;
  isDefault: boolean;
  lastSyncedAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarMember {
  id: string;
  calendarId: string;
  memberType: CalendarMemberType;
  memberId: string;
  relation: CalendarMemberRelation;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  uid: string;
  providerEventId: string | null;
  providerRecurringEventId: string | null;
  icalUid: string | null;
  seriesId: string | null;
  originalStartAt: number | null;
  title: string;
  description: string | null;
  descriptionRedactionStatus: CalendarRedactionStatus;
  location: string | null;
  locationRedactionStatus: CalendarRedactionStatus;
  status: CalendarEventStatus;
  busyStatus: CalendarBusyStatus;
  visibility: CalendarEventVisibility;
  startAt: number;
  endAt: number;
  startTimezone: string | null;
  endTimezone: string | null;
  allDay: boolean;
  recurrenceRule: string | null;
  recurrence: Record<string, unknown>;
  sequence: number;
  etag: string | null;
  organizerContactId: string | null;
  organizerAgentId: string | null;
  organizerPlatformIdentityId: string | null;
  creatorContactId: string | null;
  creatorAgentId: string | null;
  creatorPlatformIdentityId: string | null;
  safePayload: Record<string, unknown>;
  providerProvenance: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CalendarEventAttendee {
  id: string;
  eventId: string;
  kind: CalendarAttendeeKind;
  responseStatus: CalendarResponseStatus;
  email: string | null;
  normalizedEmail: string | null;
  displayName: string | null;
  contactId: string | null;
  agentId: string | null;
  platformIdentityId: string | null;
  providerAttendeeId: string | null;
  raw: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventWithAttendees extends CalendarEvent {
  attendees: CalendarEventAttendee[];
}

export interface CalendarOutboxRow {
  id: string;
  accountId: string;
  calendarId: string;
  eventId: string;
  operation: CalendarOutboxOperation;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: CalendarOutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  providerResult: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarSyncConflict {
  id: string;
  accountId: string;
  calendarId: string;
  eventId: string | null;
  outboxId: string | null;
  provider: CalendarProvider;
  conflictType: string;
  localVersion: string | null;
  remoteVersion: string | null;
  status: "open" | "resolved" | "ignored" | "dead";
  resolution: string | null;
  safeLocalSnapshot: Record<string, unknown>;
  safeRemoteSnapshot: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventAttendeeInput {
  id?: string;
  kind?: CalendarAttendeeKind;
  responseStatus?: CalendarResponseStatus;
  email?: string | null;
  displayName?: string | null;
  contactId?: string | null;
  agentId?: string | null;
  platformIdentityId?: string | null;
  providerAttendeeId?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface CreateCalendarAccountInput {
  id?: string;
  provider: CalendarProvider;
  displayName?: string;
  status?: CalendarAccountStatus;
  credentialsRef?: string | null;
  capabilities?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  now?: number;
}

export interface CreateCalendarInput {
  id?: string;
  accountId: string;
  providerCalendarId?: string | null;
  name: string;
  description?: string | null;
  color?: string | null;
  timezone?: string | null;
  role?: CalendarRole;
  status?: CalendarStatus;
  visibility?: CalendarVisibility;
  ownerType?: CalendarOwnerType;
  ownerId?: string | null;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface AddCalendarMemberInput {
  id?: string;
  calendarId: string;
  memberType: CalendarMemberType;
  memberId: string;
  relation: CalendarMemberRelation;
  expiresAt?: number | null;
  mirrorToRebac?: boolean;
  now?: number;
}

export interface CreateCalendarEventInput {
  id?: string;
  calendarId: string;
  uid?: string | null;
  providerEventId?: string | null;
  providerRecurringEventId?: string | null;
  icalUid?: string | null;
  seriesId?: string | null;
  originalStartAt?: number | null;
  title: string;
  description?: string | null;
  descriptionRedactionStatus?: CalendarRedactionStatus;
  location?: string | null;
  locationRedactionStatus?: CalendarRedactionStatus;
  status?: CalendarEventStatus;
  busyStatus?: CalendarBusyStatus;
  visibility?: CalendarEventVisibility;
  startAt: number;
  endAt: number;
  startTimezone?: string | null;
  endTimezone?: string | null;
  allDay?: boolean;
  recurrenceRule?: string | null;
  recurrence?: Record<string, unknown>;
  sequence?: number;
  etag?: string | null;
  organizerContactId?: string | null;
  organizerAgentId?: string | null;
  organizerPlatformIdentityId?: string | null;
  creatorContactId?: string | null;
  creatorAgentId?: string | null;
  creatorPlatformIdentityId?: string | null;
  safePayload?: Record<string, unknown>;
  providerProvenance?: Record<string, unknown>;
  attendees?: CalendarEventAttendeeInput[];
  idempotencyKey?: string | null;
  enqueueOutbox?: boolean;
  outboxStatus?: CalendarOutboxStatus;
  now?: number;
}

export interface UpdateCalendarEventInput {
  title?: string;
  description?: string | null;
  descriptionRedactionStatus?: CalendarRedactionStatus;
  location?: string | null;
  locationRedactionStatus?: CalendarRedactionStatus;
  status?: CalendarEventStatus;
  busyStatus?: CalendarBusyStatus;
  visibility?: CalendarEventVisibility;
  startAt?: number;
  endAt?: number;
  startTimezone?: string | null;
  endTimezone?: string | null;
  allDay?: boolean;
  recurrenceRule?: string | null;
  recurrence?: Record<string, unknown>;
  sequence?: number;
  etag?: string | null;
  safePayload?: Record<string, unknown>;
  providerProvenance?: Record<string, unknown>;
  attendees?: CalendarEventAttendeeInput[];
  idempotencyKey?: string | null;
  enqueueOutbox?: boolean;
  outboxStatus?: CalendarOutboxStatus;
  now?: number;
}

export interface ListCalendarEventsInput {
  calendarId?: string;
  calendarIds?: string[];
  accountId?: string;
  query?: string;
  status?: CalendarEventStatus;
  from: number;
  to: number;
  includeAttendees?: boolean;
  includeCancelled?: boolean;
  limit?: number;
  offset?: number;
}

export interface RespondToCalendarEventInput {
  status: CalendarResponseStatus;
  attendeeEmail?: string | null;
  attendeeAgentId?: string | null;
  idempotencyKey?: string | null;
  outboxStatus?: CalendarOutboxStatus;
  now?: number;
}

export interface EnqueueCalendarOutboxInput {
  accountId: string;
  calendarId: string;
  eventId: string;
  operation: CalendarOutboxOperation;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  status?: CalendarOutboxStatus;
  nextAttemptAt?: number;
  now?: number;
}
