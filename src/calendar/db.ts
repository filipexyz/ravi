import { createHash, randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { grantRelation } from "../permissions/relations.js";
import { getDb } from "../router/router-db.js";
import type {
  AddCalendarMemberInput,
  CalendarAccount,
  CalendarAccountStatus,
  CalendarAttendeeKind,
  CalendarBusyStatus,
  CalendarCalendar,
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventAttendeeInput,
  CalendarEventStatus,
  CalendarEventVisibility,
  CalendarEventWithAttendees,
  CalendarMember,
  CalendarMemberRelation,
  CalendarOutboxOperation,
  CalendarOutboxRow,
  CalendarOutboxStatus,
  CalendarProvider,
  CalendarRedactionStatus,
  CalendarRole,
  CalendarStatus,
  CalendarVisibility,
  CreateCalendarAccountInput,
  CreateCalendarEventInput,
  CreateCalendarInput,
  EnqueueCalendarOutboxInput,
  ListCalendarEventsInput,
  RespondToCalendarEventInput,
  UpdateCalendarEventInput,
} from "./types.js";

interface CalendarAccountRow {
  id: string;
  provider: string;
  display_name: string;
  status: CalendarAccountStatus;
  default_calendar_id: string | null;
  credentials_ref: string | null;
  capabilities_json: string | null;
  settings_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CalendarRow {
  id: string;
  account_id: string;
  provider_calendar_id: string | null;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  role: CalendarRole;
  status: CalendarStatus;
  visibility: CalendarVisibility;
  owner_type: string;
  owner_id: string;
  is_default: number;
  last_synced_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CalendarMemberRow {
  id: string;
  calendar_id: string;
  member_type: string;
  member_id: string;
  relation: CalendarMemberRelation;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CalendarEventRow {
  id: string;
  calendar_id: string;
  account_id: string;
  uid: string;
  provider_event_id: string | null;
  provider_recurring_event_id: string | null;
  ical_uid: string | null;
  series_id: string | null;
  original_start_at: number | null;
  title: string;
  description: string | null;
  description_redaction_status: CalendarRedactionStatus;
  location: string | null;
  location_redaction_status: CalendarRedactionStatus;
  status: CalendarEventStatus;
  busy_status: CalendarBusyStatus;
  visibility: CalendarEventVisibility;
  start_at: number;
  end_at: number;
  start_timezone: string | null;
  end_timezone: string | null;
  all_day: number;
  recurrence_rule: string | null;
  recurrence_json: string | null;
  sequence: number;
  etag: string | null;
  organizer_contact_id: string | null;
  organizer_agent_id: string | null;
  organizer_platform_identity_id: string | null;
  creator_contact_id: string | null;
  creator_agent_id: string | null;
  creator_platform_identity_id: string | null;
  safe_payload_json: string | null;
  provider_provenance_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface CalendarAttendeeRow {
  id: string;
  event_id: string;
  kind: CalendarAttendeeKind;
  response_status: string;
  email: string | null;
  normalized_email: string | null;
  display_name: string | null;
  contact_id: string | null;
  agent_id: string | null;
  platform_identity_id: string | null;
  provider_attendee_id: string | null;
  raw_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CalendarOutboxDbRow {
  id: string;
  account_id: string;
  calendar_id: string;
  event_id: string;
  operation: CalendarOutboxOperation;
  idempotency_key: string;
  payload_json: string;
  status: CalendarOutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  provider_result_json: string | null;
  created_at: number;
  updated_at: number;
}

export function ensureCalendarSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS calendar_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','paused','auth_required','disabled')),
      default_calendar_id TEXT,
      credentials_ref TEXT,
      capabilities_json TEXT,
      settings_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_accounts_provider_status
      ON calendar_accounts(provider, status);

    CREATE TABLE IF NOT EXISTS calendar_calendars (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      provider_calendar_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      timezone TEXT,
      role TEXT NOT NULL CHECK(role IN ('primary','secondary','shared','resource','system','unknown')),
      status TEXT NOT NULL CHECK(status IN ('active','paused','disabled','deleted')),
      visibility TEXT NOT NULL CHECK(visibility IN ('private','shared','public','local_only')),
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      last_synced_at INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, name)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_calendars_provider_id
      ON calendar_calendars(account_id, provider_calendar_id)
      WHERE provider_calendar_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_calendar_calendars_owner
      ON calendar_calendars(owner_type, owner_id, status);
    CREATE INDEX IF NOT EXISTS idx_calendar_calendars_account_status
      ON calendar_calendars(account_id, status);

    CREATE TABLE IF NOT EXISTS calendar_members (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(id) ON DELETE CASCADE,
      member_type TEXT NOT NULL,
      member_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK(relation IN ('owner','reader','writer','manager','free_busy')),
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(calendar_id, member_type, member_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_members_member
      ON calendar_members(member_type, member_id, relation);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      provider_event_id TEXT,
      provider_recurring_event_id TEXT,
      ical_uid TEXT,
      series_id TEXT,
      original_start_at INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      description_redaction_status TEXT NOT NULL CHECK(description_redaction_status IN ('full_local','preview_only','redacted','missing')),
      location TEXT,
      location_redaction_status TEXT NOT NULL CHECK(location_redaction_status IN ('full_local','preview_only','redacted','missing')),
      status TEXT NOT NULL CHECK(status IN ('confirmed','tentative','cancelled','draft','unknown')),
      busy_status TEXT NOT NULL CHECK(busy_status IN ('busy','free','tentative','out_of_office','unknown')),
      visibility TEXT NOT NULL CHECK(visibility IN ('default','private','public','confidential')),
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      start_timezone TEXT,
      end_timezone TEXT,
      all_day INTEGER NOT NULL DEFAULT 0 CHECK(all_day IN (0,1)),
      recurrence_rule TEXT,
      recurrence_json TEXT,
      sequence INTEGER NOT NULL DEFAULT 1,
      etag TEXT,
      organizer_contact_id TEXT,
      organizer_agent_id TEXT,
      organizer_platform_identity_id TEXT,
      creator_contact_id TEXT,
      creator_agent_id TEXT,
      creator_platform_identity_id TEXT,
      safe_payload_json TEXT,
      provider_provenance_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      CHECK(end_at > start_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_provider_event
      ON calendar_events(account_id, calendar_id, provider_event_id, COALESCE(original_start_at, 0))
      WHERE provider_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_uid
      ON calendar_events(calendar_id, uid, COALESCE(original_start_at, 0));
    CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar_range
      ON calendar_events(calendar_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_account_range
      ON calendar_events(account_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_status_range
      ON calendar_events(status, start_at, end_at);

    CREATE TABLE IF NOT EXISTS calendar_event_attendees (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('organizer','required','optional','resource','informational')),
      response_status TEXT NOT NULL CHECK(response_status IN ('accepted','declined','tentative','needs_action','unknown')),
      email TEXT,
      normalized_email TEXT,
      display_name TEXT,
      contact_id TEXT,
      agent_id TEXT,
      platform_identity_id TEXT,
      provider_attendee_id TEXT,
      raw_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_event_attendees_event
      ON calendar_event_attendees(event_id, kind);
    CREATE INDEX IF NOT EXISTS idx_calendar_event_attendees_email
      ON calendar_event_attendees(normalized_email);

    CREATE TABLE IF NOT EXISTS calendar_event_reminders (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      trigger_offset_ms INTEGER,
      trigger_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_due
      ON calendar_event_reminders(status, trigger_at);

    CREATE TABLE IF NOT EXISTS calendar_sync_cursors (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT REFERENCES calendar_calendars(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      cursor_type TEXT NOT NULL,
      cursor_value TEXT,
      watermark_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      last_success_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, calendar_id, provider, cursor_type)
    );

    CREATE TABLE IF NOT EXISTS calendar_sync_conflicts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES calendar_events(id) ON DELETE SET NULL,
      outbox_id TEXT,
      provider TEXT NOT NULL,
      conflict_type TEXT NOT NULL,
      local_version TEXT,
      remote_version TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','resolved','ignored','dead')),
      resolution TEXT,
      safe_local_snapshot_json TEXT,
      safe_remote_snapshot_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_sync_conflicts_status
      ON calendar_sync_conflicts(status, created_at);

    CREATE TABLE IF NOT EXISTS calendar_outbox (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('create','update','cancel','delete','respond')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','leased','sending','sent','acked','failed','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      provider_result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_outbox_status_next
      ON calendar_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_calendar_outbox_calendar
      ON calendar_outbox(calendar_id, status, created_at);

    CREATE TABLE IF NOT EXISTS calendar_event_audit (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_event_audit_event
      ON calendar_event_audit(event_id, created_at);
  `);
}

export function createCalendarAccount(input: CreateCalendarAccountInput): CalendarAccount {
  ensureCalendarSchema();
  const now = input.now ?? Date.now();
  const provider = requireText(input.provider, "provider") as CalendarProvider;
  const id = input.id?.trim() || semanticId("cal_acct", [provider, input.displayName ?? provider]);
  const displayName = input.displayName?.trim() || provider;

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT INTO calendar_accounts (
          id, provider, display_name, status, default_calendar_id, credentials_ref,
          capabilities_json, settings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          display_name = excluded.display_name,
          status = excluded.status,
          credentials_ref = excluded.credentials_ref,
          capabilities_json = excluded.capabilities_json,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        provider,
        displayName,
        input.status ?? "active",
        nullableText(input.credentialsRef),
        stableJson(input.capabilities ?? {}),
        stableJson(input.settings ?? {}),
        now,
        now,
      );
      const row = getAccountRow(id);
      if (!row) throw new Error("Failed to create calendar account.");
      return rowToAccount(row);
    },
    { label: "calendar_account_create" },
  );
}

export function listCalendarAccounts(
  options: { provider?: string; status?: CalendarAccountStatus; limit?: number; offset?: number } = {},
): CalendarAccount[] {
  ensureCalendarSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = clampInt(options.limit, 100, 1, 500);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM calendar_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as CalendarAccountRow[];
  return rows.map(rowToAccount);
}

export function getCalendarAccount(id: string): CalendarAccount | null {
  ensureCalendarSchema();
  const row = getAccountRow(id);
  return row ? rowToAccount(row) : null;
}

export function createCalendar(input: CreateCalendarInput): CalendarCalendar {
  ensureCalendarSchema();
  const account = getCalendarAccount(input.accountId);
  if (!account) throw new Error(`Calendar account not found: ${input.accountId}`);
  const now = input.now ?? Date.now();
  const name = requireText(input.name, "name");
  const providerCalendarId = nullableText(input.providerCalendarId);
  const id = input.id?.trim() || semanticId("cal", [input.accountId, providerCalendarId ?? name]);
  const ownerType = input.ownerType ?? "system";
  const ownerId = requireText(input.ownerId ?? "ravi", "ownerId");

  return executeWrite(
    getDb(),
    (db) => {
      if (input.isDefault) {
        db.prepare(`UPDATE calendar_calendars SET is_default = 0, updated_at = ? WHERE account_id = ?`).run(
          now,
          input.accountId,
        );
      }
      db.prepare(
        `
        INSERT INTO calendar_calendars (
          id, account_id, provider_calendar_id, name, description, color, timezone,
          role, status, visibility, owner_type, owner_id, is_default,
          last_synced_at, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          account_id = excluded.account_id,
          provider_calendar_id = excluded.provider_calendar_id,
          name = excluded.name,
          description = excluded.description,
          color = excluded.color,
          timezone = excluded.timezone,
          role = excluded.role,
          status = excluded.status,
          visibility = excluded.visibility,
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          is_default = excluded.is_default,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        input.accountId,
        providerCalendarId,
        name,
        nullableText(input.description),
        nullableText(input.color),
        nullableText(input.timezone),
        input.role ?? "primary",
        input.status ?? "active",
        input.visibility ?? "private",
        ownerType,
        ownerId,
        input.isDefault ? 1 : 0,
        stableJson(input.metadata ?? {}),
        now,
        now,
      );
      const calendar = getCalendarByRef(id);
      if (!calendar) throw new Error("Failed to create calendar.");
      if (input.isDefault || !account.defaultCalendarId) {
        db.prepare(`UPDATE calendar_accounts SET default_calendar_id = ?, updated_at = ? WHERE id = ?`).run(
          calendar.id,
          now,
          input.accountId,
        );
      }
      upsertOwnerMember(calendar, now);
      return calendar;
    },
    { label: "calendar_create" },
  );
}

export function listCalendars(
  options: {
    accountId?: string;
    status?: CalendarStatus;
    ownerType?: string;
    ownerId?: string;
    limit?: number;
    offset?: number;
  } = {},
): CalendarCalendar[] {
  ensureCalendarSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.accountId) {
    where.push("account_id = ?");
    params.push(options.accountId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  if (options.ownerType) {
    where.push("owner_type = ?");
    params.push(options.ownerType);
  }
  if (options.ownerId) {
    where.push("owner_id = ?");
    params.push(options.ownerId);
  }
  const limit = clampInt(options.limit, 100, 1, 500);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM calendar_calendars
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY is_default DESC, name ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as CalendarRow[];
  return rows.map(rowToCalendar);
}

export function getCalendar(ref: string, accountId?: string): CalendarCalendar | null {
  ensureCalendarSchema();
  return getCalendarByRef(ref, accountId);
}

export function setCalendarStatus(ref: string, status: CalendarStatus): CalendarCalendar {
  ensureCalendarSchema();
  const calendar = requireCalendar(ref);
  const now = Date.now();
  getDb()
    .prepare(`UPDATE calendar_calendars SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, calendar.id);
  return requireCalendar(calendar.id);
}

export function addCalendarMember(input: AddCalendarMemberInput): CalendarMember {
  ensureCalendarSchema();
  const calendar = requireCalendar(input.calendarId);
  const now = input.now ?? Date.now();
  const id = input.id?.trim() || semanticId("cal_mem", [calendar.id, input.memberType, input.memberId, input.relation]);

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT INTO calendar_members (
          id, calendar_id, member_type, member_id, relation, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(calendar_id, member_type, member_id, relation) DO UPDATE SET
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        calendar.id,
        requireText(input.memberType, "memberType"),
        requireText(input.memberId, "memberId"),
        input.relation,
        input.expiresAt ?? null,
        now,
        now,
      );
      if (input.mirrorToRebac !== false) {
        mirrorMemberToRebac(input.memberType, input.memberId, input.relation, calendar.id);
      }
      const row = getMemberRow(id) ?? getMemberByTuple(calendar.id, input.memberType, input.memberId, input.relation);
      if (!row) throw new Error("Failed to add calendar member.");
      return rowToMember(row);
    },
    { label: "calendar_member_add" },
  );
}

export function listCalendarMembers(calendarId: string): CalendarMember[] {
  ensureCalendarSchema();
  const calendar = requireCalendar(calendarId);
  const rows = getDb()
    .prepare(`SELECT * FROM calendar_members WHERE calendar_id = ? ORDER BY relation ASC, created_at ASC`)
    .all(calendar.id) as CalendarMemberRow[];
  return rows.map(rowToMember);
}

export function createCalendarEvent(input: CreateCalendarEventInput): {
  event: CalendarEventWithAttendees;
  outbox: CalendarOutboxRow | null;
} {
  ensureCalendarSchema();
  const calendar = requireCalendar(input.calendarId);
  const account = getCalendarAccount(calendar.accountId);
  if (!account) throw new Error(`Calendar account not found: ${calendar.accountId}`);
  const now = input.now ?? Date.now();
  validateEventRange(input.startAt, input.endAt);
  const idempotencyKey = nullableText(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = getOutboxByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        event: readCalendarEvent(existing.eventId, { includeAttendees: true }),
        outbox: existing,
      };
    }
  }

  const eventId = resolveEventId(input, account.id, calendar.id);
  const uid =
    nullableText(input.uid) || nullableText(input.icalUid) || nullableText(input.providerEventId) || `local:${eventId}`;
  const shouldEnqueue = input.enqueueOutbox !== false;
  const outboxStatus = input.outboxStatus ?? (account.provider === "local" ? "acked" : "pending");

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT INTO calendar_events (
          id, calendar_id, account_id, uid, provider_event_id, provider_recurring_event_id,
          ical_uid, series_id, original_start_at, title, description, description_redaction_status,
          location, location_redaction_status, status, busy_status, visibility, start_at, end_at,
          start_timezone, end_timezone, all_day, recurrence_rule, recurrence_json, sequence, etag,
          organizer_contact_id, organizer_agent_id, organizer_platform_identity_id,
          creator_contact_id, creator_agent_id, creator_platform_identity_id,
          safe_payload_json, provider_provenance_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          uid = excluded.uid,
          provider_event_id = excluded.provider_event_id,
          provider_recurring_event_id = excluded.provider_recurring_event_id,
          ical_uid = excluded.ical_uid,
          series_id = excluded.series_id,
          original_start_at = excluded.original_start_at,
          title = excluded.title,
          description = excluded.description,
          description_redaction_status = excluded.description_redaction_status,
          location = excluded.location,
          location_redaction_status = excluded.location_redaction_status,
          status = excluded.status,
          busy_status = excluded.busy_status,
          visibility = excluded.visibility,
          start_at = excluded.start_at,
          end_at = excluded.end_at,
          start_timezone = excluded.start_timezone,
          end_timezone = excluded.end_timezone,
          all_day = excluded.all_day,
          recurrence_rule = excluded.recurrence_rule,
          recurrence_json = excluded.recurrence_json,
          sequence = excluded.sequence,
          etag = excluded.etag,
          organizer_contact_id = excluded.organizer_contact_id,
          organizer_agent_id = excluded.organizer_agent_id,
          organizer_platform_identity_id = excluded.organizer_platform_identity_id,
          creator_contact_id = excluded.creator_contact_id,
          creator_agent_id = excluded.creator_agent_id,
          creator_platform_identity_id = excluded.creator_platform_identity_id,
          safe_payload_json = excluded.safe_payload_json,
          provider_provenance_json = excluded.provider_provenance_json,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `,
      ).run(
        eventId,
        calendar.id,
        account.id,
        uid,
        nullableText(input.providerEventId),
        nullableText(input.providerRecurringEventId),
        nullableText(input.icalUid),
        nullableText(input.seriesId),
        nullableInteger(input.originalStartAt),
        requireText(input.title, "title"),
        nullableText(input.description),
        input.descriptionRedactionStatus ?? (input.description ? "full_local" : "missing"),
        nullableText(input.location),
        input.locationRedactionStatus ?? (input.location ? "full_local" : "missing"),
        input.status ?? "confirmed",
        input.busyStatus ?? "busy",
        input.visibility ?? "default",
        input.startAt,
        input.endAt,
        nullableText(input.startTimezone),
        nullableText(input.endTimezone),
        input.allDay ? 1 : 0,
        nullableText(input.recurrenceRule),
        stableJson(input.recurrence ?? {}),
        clampInt(input.sequence, 1, 1, Number.MAX_SAFE_INTEGER),
        nullableText(input.etag),
        nullableText(input.organizerContactId),
        nullableText(input.organizerAgentId),
        nullableText(input.organizerPlatformIdentityId),
        nullableText(input.creatorContactId),
        nullableText(input.creatorAgentId),
        nullableText(input.creatorPlatformIdentityId),
        stableJson(input.safePayload ?? {}),
        stableJson({
          provider: account.provider,
          providerCalendarId: calendar.providerCalendarId,
          providerEventId: input.providerEventId ?? null,
          providerRecurringEventId: input.providerRecurringEventId ?? null,
          ...(input.providerProvenance ?? {}),
        }),
        now,
        now,
      );

      if (input.attendees !== undefined) replaceEventAttendees(eventId, input.attendees, now);
      recordCalendarAudit(eventId, "created", input.creatorAgentId ? "agent" : "system", input.creatorAgentId ?? null, {
        calendarId: calendar.id,
        accountId: account.id,
      });

      const outbox = shouldEnqueue
        ? insertCalendarOutbox({
            accountId: account.id,
            calendarId: calendar.id,
            eventId,
            operation: "create",
            idempotencyKey:
              idempotencyKey || semanticId("cal_out_key", ["create", account.id, calendar.id, eventId, String(now)]),
            status: outboxStatus,
            payload: safeOutboxPayload({
              title: input.title,
              description: input.description ?? null,
              location: input.location ?? null,
              startAt: input.startAt,
              endAt: input.endAt,
              attendees: input.attendees ?? [],
            }),
            now,
          })
        : null;
      return {
        event: readCalendarEvent(eventId, { includeAttendees: true }),
        outbox,
      };
    },
    { label: "calendar_event_create" },
  );
}

export function updateCalendarEvent(
  eventId: string,
  input: UpdateCalendarEventInput,
): { event: CalendarEventWithAttendees; outbox: CalendarOutboxRow | null } {
  ensureCalendarSchema();
  const existing = readCalendarEvent(eventId, { includeAttendees: true });
  const now = input.now ?? Date.now();
  const nextStart = input.startAt ?? existing.startAt;
  const nextEnd = input.endAt ?? existing.endAt;
  validateEventRange(nextStart, nextEnd);
  const shouldEnqueue = input.enqueueOutbox !== false;

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        UPDATE calendar_events SET
          title = ?,
          description = ?,
          description_redaction_status = ?,
          location = ?,
          location_redaction_status = ?,
          status = ?,
          busy_status = ?,
          visibility = ?,
          start_at = ?,
          end_at = ?,
          start_timezone = ?,
          end_timezone = ?,
          all_day = ?,
          recurrence_rule = ?,
          recurrence_json = ?,
          sequence = ?,
          etag = ?,
          safe_payload_json = ?,
          provider_provenance_json = ?,
          updated_at = ?
        WHERE id = ?
      `,
      ).run(
        input.title ?? existing.title,
        input.description !== undefined ? nullableText(input.description) : existing.description,
        input.descriptionRedactionStatus ??
          (input.description !== undefined
            ? input.description
              ? "full_local"
              : "missing"
            : existing.descriptionRedactionStatus),
        input.location !== undefined ? nullableText(input.location) : existing.location,
        input.locationRedactionStatus ??
          (input.location !== undefined
            ? input.location
              ? "full_local"
              : "missing"
            : existing.locationRedactionStatus),
        input.status ?? existing.status,
        input.busyStatus ?? existing.busyStatus,
        input.visibility ?? existing.visibility,
        nextStart,
        nextEnd,
        input.startTimezone !== undefined ? nullableText(input.startTimezone) : existing.startTimezone,
        input.endTimezone !== undefined ? nullableText(input.endTimezone) : existing.endTimezone,
        input.allDay !== undefined ? (input.allDay ? 1 : 0) : existing.allDay ? 1 : 0,
        input.recurrenceRule !== undefined ? nullableText(input.recurrenceRule) : existing.recurrenceRule,
        input.recurrence !== undefined ? stableJson(input.recurrence) : stableJson(existing.recurrence),
        input.sequence ?? existing.sequence + 1,
        input.etag !== undefined ? nullableText(input.etag) : existing.etag,
        input.safePayload !== undefined ? stableJson(input.safePayload) : stableJson(existing.safePayload),
        input.providerProvenance !== undefined
          ? stableJson({ ...existing.providerProvenance, ...input.providerProvenance })
          : stableJson(existing.providerProvenance),
        now,
        existing.id,
      );
      if (input.attendees !== undefined) replaceEventAttendees(existing.id, input.attendees, now);
      recordCalendarAudit(existing.id, "updated", "system", null, { changedAt: now });
      const outbox = shouldEnqueue
        ? insertCalendarOutbox({
            accountId: existing.accountId,
            calendarId: existing.calendarId,
            eventId: existing.id,
            operation: "update",
            idempotencyKey: input.idempotencyKey || semanticId("cal_out_key", ["update", existing.id, String(now)]),
            status: input.outboxStatus ?? outboxStatusForAccount(existing.accountId),
            payload: safeOutboxPayload({
              title: input.title,
              description: input.description,
              location: input.location,
              startAt: input.startAt,
              endAt: input.endAt,
              attendees: input.attendees,
            }),
            now,
          })
        : null;
      return {
        event: readCalendarEvent(existing.id, { includeAttendees: true }),
        outbox,
      };
    },
    { label: "calendar_event_update" },
  );
}

export function cancelCalendarEvent(
  eventId: string,
  input: { idempotencyKey?: string | null; outboxStatus?: CalendarOutboxStatus; now?: number } = {},
): { event: CalendarEventWithAttendees; outbox: CalendarOutboxRow | null } {
  ensureCalendarSchema();
  const existing = readCalendarEvent(eventId, { includeAttendees: true });
  const now = input.now ?? Date.now();

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `UPDATE calendar_events SET status = 'cancelled', sequence = sequence + 1, updated_at = ? WHERE id = ?`,
      ).run(now, existing.id);
      recordCalendarAudit(existing.id, "cancelled", "system", null, { cancelledAt: now });
      const outbox = insertCalendarOutbox({
        accountId: existing.accountId,
        calendarId: existing.calendarId,
        eventId: existing.id,
        operation: "cancel",
        idempotencyKey: input.idempotencyKey || semanticId("cal_out_key", ["cancel", existing.id, String(now)]),
        status: input.outboxStatus ?? outboxStatusForAccount(existing.accountId),
        payload: { status: "cancelled" },
        now,
      });
      return {
        event: readCalendarEvent(existing.id, { includeAttendees: true }),
        outbox,
      };
    },
    { label: "calendar_event_cancel" },
  );
}

export function respondToCalendarEvent(
  eventId: string,
  input: RespondToCalendarEventInput,
): { event: CalendarEventWithAttendees; outbox: CalendarOutboxRow } {
  ensureCalendarSchema();
  const event = readCalendarEvent(eventId, { includeAttendees: true });
  const now = input.now ?? Date.now();
  const attendeeEmail = nullableText(input.attendeeEmail);
  const attendeeAgentId = nullableText(input.attendeeAgentId);
  if (!attendeeEmail && !attendeeAgentId) {
    throw new Error("Calendar response requires --attendee-email or --attendee-agent.");
  }

  return executeWrite(
    getDb(),
    () => {
      upsertResponseAttendee(event.id, input.status, attendeeEmail, attendeeAgentId, now);
      recordCalendarAudit(event.id, "response.updated", attendeeAgentId ? "agent" : "system", attendeeAgentId, {
        status: input.status,
      });
      const outbox = insertCalendarOutbox({
        accountId: event.accountId,
        calendarId: event.calendarId,
        eventId: event.id,
        operation: "respond",
        idempotencyKey:
          input.idempotencyKey ||
          semanticId("cal_out_key", ["respond", event.id, attendeeEmail, attendeeAgentId, input.status]),
        status: input.outboxStatus ?? outboxStatusForAccount(event.accountId),
        payload: {
          responseStatus: input.status,
          attendeeEmail,
          attendeeAgentId,
        },
        now,
      });
      return {
        event: readCalendarEvent(event.id, { includeAttendees: true }),
        outbox,
      };
    },
    { label: "calendar_event_respond" },
  );
}

export function listCalendarEvents(input: ListCalendarEventsInput): CalendarEventWithAttendees[] | CalendarEvent[] {
  ensureCalendarSchema();
  validateBoundedWindow(input.from, input.to);
  const where: string[] = ["deleted_at IS NULL", "start_at < ?", "end_at > ?"];
  const params: Array<string | number> = [input.to, input.from];
  const calendarIds = input.calendarIds?.length ? input.calendarIds : input.calendarId ? [input.calendarId] : [];
  if (calendarIds.length) {
    where.push(`calendar_id IN (${calendarIds.map(() => "?").join(",")})`);
    params.push(...calendarIds);
  }
  if (input.accountId) {
    where.push("account_id = ?");
    params.push(input.accountId);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  } else if (!input.includeCancelled) {
    where.push("status != 'cancelled'");
  }
  if (input.query?.trim()) {
    const pattern = `%${input.query.trim()}%`;
    where.push("(title LIKE ? OR description LIKE ? OR location LIKE ?)");
    params.push(pattern, pattern, pattern);
  }
  const limit = clampInt(input.limit, 50, 1, 500);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM calendar_events
      WHERE ${where.join(" AND ")}
      ORDER BY start_at ASC, end_at ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as CalendarEventRow[];
  const events = rows.map(rowToEvent);
  return input.includeAttendees ? events.map(eventWithAttendees) : events;
}

export function readCalendarEvent(
  id: string,
  options: { includeAttendees?: boolean } = {},
): CalendarEventWithAttendees {
  ensureCalendarSchema();
  const row = getEventRow(id);
  if (!row) throw new Error(`Calendar event not found: ${id}`);
  const event = rowToEvent(row);
  return options.includeAttendees ? eventWithAttendees(event) : { ...event, attendees: [] };
}

export function enqueueCalendarOutbox(input: EnqueueCalendarOutboxInput): CalendarOutboxRow {
  ensureCalendarSchema();
  requireCalendar(input.calendarId);
  readCalendarEvent(input.eventId);
  return executeWrite(getDb(), () => insertCalendarOutbox(input), { label: "calendar_outbox_enqueue" });
}

export function listCalendarOutbox(
  input: { status?: CalendarOutboxStatus; calendar?: string; limit?: number; offset?: number } = {},
): CalendarOutboxRow[] {
  ensureCalendarSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.calendar) {
    const calendar = requireCalendar(input.calendar);
    where.push("calendar_id = ?");
    params.push(calendar.id);
  }
  const limit = clampInt(input.limit, 50, 1, 500);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM calendar_outbox
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as CalendarOutboxDbRow[];
  return rows.map(rowToOutbox);
}

export function getCalendarOutbox(id: string): CalendarOutboxRow | null {
  ensureCalendarSchema();
  return getOutboxById(id);
}

export function retryCalendarOutbox(id: string): CalendarOutboxRow {
  ensureCalendarSchema();
  const existing = getOutboxById(id);
  if (!existing) throw new Error(`Calendar outbox row not found: ${id}`);
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE calendar_outbox
       SET status = 'pending', next_attempt_at = 0, last_error_code = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, id);
  return getOutboxById(id)!;
}

function insertCalendarOutbox(input: EnqueueCalendarOutboxInput): CalendarOutboxRow {
  const now = input.now ?? Date.now();
  const idempotencyKey =
    nullableText(input.idempotencyKey) ||
    semanticId("cal_out_key", [input.operation, input.accountId, input.calendarId, input.eventId, String(now)]);
  const outboxId = semanticId("cal_out", [idempotencyKey]);
  getDb()
    .prepare(
      `
      INSERT INTO calendar_outbox (
        id, account_id, calendar_id, event_id, operation, idempotency_key, payload_json,
        status, attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        status = excluded.status,
        next_attempt_at = excluded.next_attempt_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      outboxId,
      input.accountId,
      input.calendarId,
      input.eventId,
      input.operation,
      idempotencyKey,
      stableJson(input.payload),
      input.status ?? "pending",
      input.nextAttemptAt ?? 0,
      now,
      now,
    );
  const row = getOutboxByIdempotencyKey(idempotencyKey);
  if (!row) throw new Error("Failed to create calendar outbox row.");
  return row;
}

function replaceEventAttendees(eventId: string, attendees: CalendarEventAttendeeInput[], now: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM calendar_event_attendees WHERE event_id = ?`).run(eventId);
  const insert = db.prepare(
    `
    INSERT INTO calendar_event_attendees (
      id, event_id, kind, response_status, email, normalized_email, display_name,
      contact_id, agent_id, platform_identity_id, provider_attendee_id, raw_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  for (const input of attendees) {
    const email = nullableText(input.email);
    insert.run(
      input.id?.trim() ||
        semanticId("cal_att", [
          eventId,
          input.kind ?? "required",
          email,
          input.agentId,
          input.platformIdentityId,
          input.providerAttendeeId,
        ]),
      eventId,
      input.kind ?? "required",
      input.responseStatus ?? "needs_action",
      email,
      email ? normalizeEmail(email) : null,
      nullableText(input.displayName),
      nullableText(input.contactId),
      nullableText(input.agentId),
      nullableText(input.platformIdentityId),
      nullableText(input.providerAttendeeId),
      stableJson(input.raw ?? {}),
      now,
      now,
    );
  }
}

function upsertResponseAttendee(
  eventId: string,
  responseStatus: string,
  attendeeEmail: string | null,
  attendeeAgentId: string | null,
  now: number,
): void {
  const normalizedEmail = attendeeEmail ? normalizeEmail(attendeeEmail) : null;
  const existing = getDb()
    .prepare(
      `
      SELECT * FROM calendar_event_attendees
      WHERE event_id = ?
        AND (
          (? IS NOT NULL AND normalized_email = ?)
          OR (? IS NOT NULL AND agent_id = ?)
        )
      LIMIT 1
    `,
    )
    .get(eventId, normalizedEmail, normalizedEmail, attendeeAgentId, attendeeAgentId) as
    | CalendarAttendeeRow
    | undefined;
  if (existing) {
    getDb()
      .prepare(`UPDATE calendar_event_attendees SET response_status = ?, updated_at = ? WHERE id = ?`)
      .run(responseStatus, now, existing.id);
    return;
  }
  replaceEventAttendees(
    eventId,
    [
      ...listEventAttendees(eventId).map((attendee) => ({
        id: attendee.id,
        kind: attendee.kind,
        responseStatus: attendee.responseStatus,
        email: attendee.email,
        displayName: attendee.displayName,
        contactId: attendee.contactId,
        agentId: attendee.agentId,
        platformIdentityId: attendee.platformIdentityId,
        providerAttendeeId: attendee.providerAttendeeId,
        raw: attendee.raw,
      })),
      {
        kind: "required",
        responseStatus: responseStatus as CalendarEventAttendee["responseStatus"],
        email: attendeeEmail,
        agentId: attendeeAgentId,
      },
    ],
    now,
  );
}

function recordCalendarAudit(
  eventId: string,
  eventType: string,
  actorType: string,
  actorId: string | null,
  payload: Record<string, unknown>,
): void {
  getDb()
    .prepare(
      `
      INSERT INTO calendar_event_audit (id, event_id, event_type, actor_type, actor_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(uniqueId("cal_audit"), eventId, eventType, actorType, actorId, stableJson(payload), Date.now());
}

function upsertOwnerMember(calendar: CalendarCalendar, now: number): void {
  const id = semanticId("cal_mem", [calendar.id, calendar.ownerType, calendar.ownerId, "owner"]);
  getDb()
    .prepare(
      `
      INSERT INTO calendar_members (
        id, calendar_id, member_type, member_id, relation, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'owner', NULL, ?, ?)
      ON CONFLICT(calendar_id, member_type, member_id, relation) DO UPDATE SET updated_at = excluded.updated_at
    `,
    )
    .run(id, calendar.id, calendar.ownerType, calendar.ownerId, now, now);
  mirrorMemberToRebac(calendar.ownerType, calendar.ownerId, "owner", calendar.id);
}

function mirrorMemberToRebac(
  memberType: string,
  memberId: string,
  relation: CalendarMemberRelation,
  calendarId: string,
): void {
  if (memberType !== "agent") return;
  for (const permission of permissionsForRelation(relation)) {
    grantRelation("agent", memberId, permission, "calendar", calendarId, "calendar");
  }
}

function permissionsForRelation(relation: CalendarMemberRelation): string[] {
  switch (relation) {
    case "owner":
    case "manager":
      return ["read", "search", "free-busy", "write", "respond", "manage"];
    case "writer":
      return ["read", "search", "free-busy", "write", "respond"];
    case "reader":
      return ["read", "search", "free-busy"];
    case "free_busy":
      return ["free-busy"];
  }
}

function outboxStatusForAccount(accountId: string): CalendarOutboxStatus {
  const account = getCalendarAccount(accountId);
  return account?.provider === "local" ? "acked" : "pending";
}

function getAccountRow(id: string): CalendarAccountRow | null {
  return (
    (getDb().prepare(`SELECT * FROM calendar_accounts WHERE id = ?`).get(id) as CalendarAccountRow | undefined) ?? null
  );
}

function getCalendarByRef(ref: string, accountId?: string): CalendarCalendar | null {
  const trimmed = requireText(ref, "calendar");
  const params: string[] = [trimmed, trimmed, trimmed];
  let accountClause = "";
  if (accountId) {
    accountClause = "AND account_id = ?";
    params.push(accountId);
  }
  const row = getDb()
    .prepare(
      `
      SELECT * FROM calendar_calendars
      WHERE (id = ? OR name = ? OR provider_calendar_id = ?)
      ${accountClause}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `,
    )
    .get(...params) as CalendarRow | undefined;
  return row ? rowToCalendar(row) : null;
}

function requireCalendar(ref: string): CalendarCalendar {
  const calendar = getCalendarByRef(ref);
  if (!calendar) throw new Error(`Calendar not found: ${ref}`);
  return calendar;
}

function getMemberRow(id: string): CalendarMemberRow | null {
  return (
    (getDb().prepare(`SELECT * FROM calendar_members WHERE id = ?`).get(id) as CalendarMemberRow | undefined) ?? null
  );
}

function getMemberByTuple(
  calendarId: string,
  memberType: string,
  memberId: string,
  relation: CalendarMemberRelation,
): CalendarMemberRow | null {
  return (
    (getDb()
      .prepare(
        `
        SELECT * FROM calendar_members
        WHERE calendar_id = ? AND member_type = ? AND member_id = ? AND relation = ?
        LIMIT 1
      `,
      )
      .get(calendarId, memberType, memberId, relation) as CalendarMemberRow | undefined) ?? null
  );
}

function getEventRow(id: string): CalendarEventRow | null {
  return (
    (getDb().prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as CalendarEventRow | undefined) ?? null
  );
}

function getOutboxById(id: string): CalendarOutboxRow | null {
  const row = getDb().prepare(`SELECT * FROM calendar_outbox WHERE id = ?`).get(id) as CalendarOutboxDbRow | undefined;
  return row ? rowToOutbox(row) : null;
}

function getOutboxByIdempotencyKey(key: string): CalendarOutboxRow | null {
  const row = getDb().prepare(`SELECT * FROM calendar_outbox WHERE idempotency_key = ?`).get(key) as
    | CalendarOutboxDbRow
    | undefined;
  return row ? rowToOutbox(row) : null;
}

function listEventAttendees(eventId: string): CalendarEventAttendee[] {
  const rows = getDb()
    .prepare(`SELECT * FROM calendar_event_attendees WHERE event_id = ? ORDER BY kind ASC, created_at ASC, id ASC`)
    .all(eventId) as CalendarAttendeeRow[];
  return rows.map(rowToAttendee);
}

function eventWithAttendees(event: CalendarEvent): CalendarEventWithAttendees {
  return { ...event, attendees: listEventAttendees(event.id) };
}

function rowToAccount(row: CalendarAccountRow): CalendarAccount {
  return {
    id: row.id,
    provider: row.provider as CalendarProvider,
    displayName: row.display_name,
    status: row.status,
    defaultCalendarId: row.default_calendar_id,
    credentialsRef: row.credentials_ref,
    capabilities: parseJsonRecord(row.capabilities_json),
    settings: parseJsonRecord(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCalendar(row: CalendarRow): CalendarCalendar {
  return {
    id: row.id,
    accountId: row.account_id,
    providerCalendarId: row.provider_calendar_id,
    name: row.name,
    description: row.description,
    color: row.color,
    timezone: row.timezone,
    role: row.role,
    status: row.status,
    visibility: row.visibility,
    ownerType: row.owner_type as CalendarCalendar["ownerType"],
    ownerId: row.owner_id,
    isDefault: row.is_default === 1,
    lastSyncedAt: row.last_synced_at,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMember(row: CalendarMemberRow): CalendarMember {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    memberType: row.member_type as CalendarMember["memberType"],
    memberId: row.member_id,
    relation: row.relation,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    accountId: row.account_id,
    uid: row.uid,
    providerEventId: row.provider_event_id,
    providerRecurringEventId: row.provider_recurring_event_id,
    icalUid: row.ical_uid,
    seriesId: row.series_id,
    originalStartAt: row.original_start_at,
    title: row.title,
    description: row.description,
    descriptionRedactionStatus: row.description_redaction_status,
    location: row.location,
    locationRedactionStatus: row.location_redaction_status,
    status: row.status,
    busyStatus: row.busy_status,
    visibility: row.visibility,
    startAt: row.start_at,
    endAt: row.end_at,
    startTimezone: row.start_timezone,
    endTimezone: row.end_timezone,
    allDay: row.all_day === 1,
    recurrenceRule: row.recurrence_rule,
    recurrence: parseJsonRecord(row.recurrence_json),
    sequence: row.sequence,
    etag: row.etag,
    organizerContactId: row.organizer_contact_id,
    organizerAgentId: row.organizer_agent_id,
    organizerPlatformIdentityId: row.organizer_platform_identity_id,
    creatorContactId: row.creator_contact_id,
    creatorAgentId: row.creator_agent_id,
    creatorPlatformIdentityId: row.creator_platform_identity_id,
    safePayload: parseJsonRecord(row.safe_payload_json),
    providerProvenance: parseJsonRecord(row.provider_provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function rowToAttendee(row: CalendarAttendeeRow): CalendarEventAttendee {
  return {
    id: row.id,
    eventId: row.event_id,
    kind: row.kind,
    responseStatus: row.response_status as CalendarEventAttendee["responseStatus"],
    email: row.email,
    normalizedEmail: row.normalized_email,
    displayName: row.display_name,
    contactId: row.contact_id,
    agentId: row.agent_id,
    platformIdentityId: row.platform_identity_id,
    providerAttendeeId: row.provider_attendee_id,
    raw: parseJsonRecord(row.raw_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOutbox(row: CalendarOutboxDbRow): CalendarOutboxRow {
  return {
    id: row.id,
    accountId: row.account_id,
    calendarId: row.calendar_id,
    eventId: row.event_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    payload: parseJsonRecord(row.payload_json),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    providerResult: row.provider_result_json ? parseJsonRecord(row.provider_result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveEventId(input: CreateCalendarEventInput, accountId: string, calendarId: string): string {
  if (input.id?.trim()) return input.id.trim();
  if (input.providerEventId?.trim()) {
    return semanticId("cal_evt", [
      accountId,
      calendarId,
      "provider",
      input.providerEventId,
      input.originalStartAt ?? null,
    ]);
  }
  if (input.icalUid?.trim()) {
    return semanticId("cal_evt", [calendarId, "ical", input.icalUid, input.originalStartAt ?? null]);
  }
  if (input.idempotencyKey?.trim()) return semanticId("cal_evt", [calendarId, "local", input.idempotencyKey]);
  return uniqueId("cal_evt");
}

function safeOutboxPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    ...(typeof payload.description === "string" ? { description: "[redacted]" } : {}),
    ...(typeof payload.location === "string" ? { location: "[redacted]" } : {}),
    ...(Array.isArray(payload.attendees) ? { attendees: "[redacted]" } : {}),
  };
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function semanticId(prefix: string, parts: unknown[]): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => (part === undefined || part === null ? "" : String(part))).join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize("NFKC");
}

function validateEventRange(startAt: number, endAt: number): void {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    throw new Error("Calendar event requires a valid start/end range.");
  }
}

function validateBoundedWindow(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error("Calendar list requires a valid bounded --from/--to range.");
  }
  const maxWindowMs = 366 * 24 * 60 * 60 * 1000;
  if (to - from > maxWindowMs) {
    throw new Error("Calendar list window is too large; use at most 366 days.");
  }
}
