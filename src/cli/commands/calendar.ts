import "reflect-metadata";
import { z } from "zod";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import {
  addCalendarMember,
  calendarAccessLevel,
  cancelCalendarEvent,
  canUseCalendar,
  canUseCalendarProvider,
  createCalendar,
  createCalendarAccount,
  createCalendarEvent,
  getCalendar,
  getCalendarAccount,
  getCalendarOutbox,
  getCalendarScopeContext,
  listCalendarAccounts,
  listCalendarEvents,
  listCalendarMembers,
  listCalendarOutbox,
  listCalendars,
  readCalendarEvent,
  respondToCalendarEvent,
  retryCalendarOutbox,
  setCalendarStatus,
  updateCalendarEvent,
  type CalendarAccountStatus,
  type CalendarBusyStatus,
  type CalendarCalendar,
  type CalendarEventStatus,
  type CalendarEventVisibility,
  type CalendarEventWithAttendees,
  type CalendarMemberRelation,
  type CalendarOutboxRow,
  type CalendarOutboxStatus,
  type CalendarRole,
  type CalendarStatus,
  type CalendarVisibility,
} from "../../calendar/index.js";
import { hasContext } from "../context.js";
import { Arg, Command, Group, Option } from "../decorators.js";
import { jsonObjectSchema, stringNumberRecordSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Group({
  name: "calendar.accounts",
  description: "Manage local-first calendar provider accounts",
  scope: "open",
})
export class CalendarAccountsCommands {
  @Command({ name: "list", description: "List local calendar accounts" })
  async list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider" }) provider?: string,
    @Option({ flags: "--status <status>", description: "Filter by account status" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const accounts = listCalendarAccounts({
        provider,
        status: parseAccountStatus(status),
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      });
      const payload = { accounts };
      printPayload(payload, asJson, () => printItems("Accounts", payload, ["id", "provider", "status", "displayName"]));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create or update a local calendar provider account" })
  async create(
    @Option({ flags: "--provider <provider>", description: "Provider id, e.g. local or google-calendar" })
    provider?: string,
    @Option({ flags: "--id <id>", description: "Stable local account id" }) id?: string,
    @Option({ flags: "--name <name>", description: "Display name" }) displayName?: string,
    @Option({ flags: "--credentials-ref <ref>", description: "Reference to an existing credential store entry" })
    credentialsRef?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      requireOption(provider, "--provider");
      if (provider !== "local") requireProviderPermission("manage", provider as string);
      const account = createCalendarAccount({
        id,
        provider: provider as string,
        displayName,
        credentialsRef,
      });
      const payload = { account };
      printPayload(payload, asJson, () => printRecord("Account", payload));
      return payload;
    });
  }

  @Command({ name: "sync", description: "Run one provider sync tick for an account" })
  async sync(
    @Arg("account", { description: "Local calendar account id" }) accountId: string,
    @Option({ flags: "--once", description: "Run one foreground tick" }) _once?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const account = getCalendarAccount(accountId);
      if (!account) throw new CloudAuthError("PAYLOAD_INVALID", `Calendar account not found: ${accountId}`);
      requireProviderPermission("sync", account.provider);
      const payload =
        account.provider === "local"
          ? { ok: true, account, status: "adapter_not_required", localFirst: true }
          : {
              ok: false,
              account,
              status: "adapter_not_started",
              message: `Calendar provider sync adapter is not implemented yet: ${account.provider}`,
            };
      printPayload(payload, asJson, () => printRecord("Sync", payload));
      return payload;
    });
  }
}

@Group({
  name: "calendar.calendars",
  description: "Manage local calendars",
  scope: "open",
})
export class CalendarCalendarsCommands {
  @Command({ name: "list", description: "List local calendars visible to the current requester" })
  async list(
    @Option({ flags: "--account <account>", description: "Local account id" }) accountId?: string,
    @Option({ flags: "--status <status>", description: "Filter by calendar status" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const calendars = visibleCalendars({
        accountId,
        status: parseCalendarStatus(status),
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      });
      const payload = { calendars };
      printPayload(payload, asJson, () => printItems("Calendars", payload, ["id", "name", "status", "isDefault"]));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create or update a local calendar projection" })
  async create(
    @Option({ flags: "--name <name>", description: "Calendar name" }) name?: string,
    @Option({ flags: "--account <account>", description: "Local account id" }) accountId?: string,
    @Option({ flags: "--provider-calendar-id <id>", description: "Provider calendar id as provenance" })
    providerCalendarId?: string,
    @Option({ flags: "--timezone <tz>", description: "IANA timezone" }) timezone?: string,
    @Option({ flags: "--description <text>", description: "Calendar description" }) description?: string,
    @Option({ flags: "--color <color>", description: "Display color" }) color?: string,
    @Option({ flags: "--role <role>", description: "primary, secondary, shared, resource, system, or unknown" })
    role?: string,
    @Option({ flags: "--visibility <visibility>", description: "private, shared, public, or local_only" })
    visibility?: string,
    @Option({ flags: "--owner <subject>", description: "Owner subject, e.g. agent:main or contact:<id>" })
    owner?: string,
    @Option({ flags: "--default", description: "Mark as default calendar for the account" }) isDefault?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      requireOption(name, "--name");
      const account = resolveCalendarAccount(accountId);
      const ownerRef = parseSubject(owner, defaultOwnerSubject());
      const calendar = createCalendar({
        accountId: account.id,
        name: name as string,
        providerCalendarId,
        timezone,
        description,
        color,
        role: parseCalendarRole(role),
        visibility: parseCalendarVisibility(visibility),
        ownerType: ownerRef.type,
        ownerId: ownerRef.id,
        isDefault,
      });
      const payload = { calendar };
      printPayload(payload, asJson, () => printRecord("Calendar", payload));
      return payload;
    });
  }

  @Command({ name: "show", description: "Show a local calendar" })
  async show(
    @Arg("calendar", { description: "Local calendar id, name, or provider calendar id" }) calendarRef: string,
    @Option({ flags: "--members", description: "Include membership projection rows" }) includeMembers?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const calendar = requireCalendar(calendarRef);
      requireCalendarPermission("read", calendar);
      const payload = {
        calendar,
        members: includeMembers ? listCalendarMembers(calendar.id) : undefined,
      };
      printPayload(payload, asJson, () => printRecord("Calendar", payload));
      return payload;
    });
  }

  @Command({ name: "share", description: "Grant a calendar relation to an agent/contact/system subject" })
  async share(
    @Arg("calendar", { description: "Local calendar id or name" }) calendarRef: string,
    @Option({ flags: "--with <subject>", description: "Subject, e.g. agent:main" }) subject?: string,
    @Option({ flags: "--relation <relation>", description: "owner, reader, writer, manager, or free_busy" })
    relation?: string,
    @Option({ flags: "--expires-at <time>", description: "Optional membership expiration timestamp" })
    expiresAt?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      requireOption(subject, "--with");
      const calendar = requireCalendar(calendarRef);
      requireCalendarPermission("manage", calendar);
      const target = parseSubject(subject as string);
      const member = addCalendarMember({
        calendarId: calendar.id,
        memberType: target.type,
        memberId: target.id,
        relation: parseMemberRelation(relation),
        expiresAt: expiresAt ? parseTime(expiresAt, "--expires-at") : null,
      });
      const payload = { calendar, member };
      printPayload(payload, asJson, () => printRecord("Member", { member }));
      return payload;
    });
  }

  @Command({ name: "disable", description: "Disable a local calendar projection" })
  async disable(
    @Arg("calendar", { description: "Local calendar id or name" }) calendarRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const existing = requireCalendar(calendarRef);
      requireCalendarPermission("manage", existing);
      const calendar = setCalendarStatus(existing.id, "disabled");
      const payload = { calendar };
      printPayload(payload, asJson, () => printRecord("Calendar", payload));
      return payload;
    });
  }
}

@Group({
  name: "calendar.events",
  description: "Create and inspect local calendar events",
  scope: "open",
})
export class CalendarEventsCommands {
  @Command({ name: "list", description: "List local calendar events in a bounded time window" })
  async list(
    @Option({ flags: "--calendar <calendar>", description: "Local calendar id or name" }) calendarRef?: string,
    @Option({ flags: "--from <time>", description: "Window start; default now" }) from?: string,
    @Option({ flags: "--to <time>", description: "Window end; default +30d" }) to?: string,
    @Option({ flags: "--query <query>", description: "Search title/description/location" }) query?: string,
    @Option({ flags: "--status <status>", description: "Filter by event status" }) status?: string,
    @Option({ flags: "--include-cancelled", description: "Include cancelled events" }) includeCancelled?: boolean,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const { fromMs, toMs } = parseWindow(from, to);
      const calendars = resolveReadableCalendars(calendarRef);
      const events = calendars.length
        ? (listCalendarEvents({
            calendarIds: calendars.map((calendar) => calendar.id),
            from: fromMs,
            to: toMs,
            query,
            status: parseEventStatus(status),
            includeCancelled,
            includeAttendees: true,
            limit: parseOptionalInteger(limit, "--limit"),
            offset: parseOptionalInteger(offset, "--offset"),
          }) as CalendarEventWithAttendees[])
        : [];
      const payload = {
        window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        events: safeCalendarEvents(events, calendars),
      };
      printPayload(payload, asJson, () => printItems("Events", payload, ["id", "title", "startAt", "endAt"]));
      return payload;
    });
  }

  @Command({ name: "read", description: "Read one local calendar event" })
  async read(
    @Arg("event", { description: "Local event id" }) eventId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const event = readCalendarEvent(eventId, { includeAttendees: true });
      const calendar = requireCalendar(event.calendarId);
      requireCalendarPermission("read", calendar);
      const payload = { event: safeCalendarEvent(event, "read") };
      printPayload(payload, asJson, () => printRecord("Event", payload));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a local calendar event and local outbox row" })
  async create(
    @Option({ flags: "--calendar <calendar>", description: "Local calendar id or name" }) calendarRef?: string,
    @Option({ flags: "--title <title>", description: "Event title" }) title?: string,
    @Option({ flags: "--start <time>", description: "Event start" }) start?: string,
    @Option({ flags: "--end <time>", description: "Event end" }) end?: string,
    @Option({ flags: "--description <text>", description: "Event description" }) description?: string,
    @Option({ flags: "--location <text>", description: "Event location" }) location?: string,
    @Option({ flags: "--timezone <tz>", description: "Start/end timezone" }) timezone?: string,
    @Option({ flags: "--attendee <email>", description: "Comma-separated attendee emails" }) attendees?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local write idempotency key" }) idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      requireOption(title, "--title");
      requireOption(start, "--start");
      requireOption(end, "--end");
      const calendar = resolveWriteCalendar(calendarRef);
      requireCalendarPermission("write", calendar);
      const result = createCalendarEvent({
        calendarId: calendar.id,
        title: title as string,
        description,
        location,
        startAt: parseTime(start, "--start"),
        endAt: parseTime(end, "--end"),
        startTimezone: timezone ?? calendar.timezone,
        endTimezone: timezone ?? calendar.timezone,
        attendees: parseAttendees(attendees),
        idempotencyKey,
        creatorAgentId: getCalendarScopeContext().agentId ?? null,
      });
      const payload = {
        event: safeCalendarEvent(result.event, "read"),
        outbox: result.outbox ? redactOutboxPayload(result.outbox) : null,
      };
      printPayload(payload, asJson, () => printRecord("Event", payload));
      return payload;
    });
  }

  @Command({ name: "update", description: "Update a local calendar event and enqueue provider delivery" })
  async update(
    @Arg("event", { description: "Local event id" }) eventId: string,
    @Option({ flags: "--title <title>", description: "Event title" }) title?: string,
    @Option({ flags: "--start <time>", description: "Event start" }) start?: string,
    @Option({ flags: "--end <time>", description: "Event end" }) end?: string,
    @Option({ flags: "--description <text>", description: "Event description" }) description?: string,
    @Option({ flags: "--location <text>", description: "Event location" }) location?: string,
    @Option({ flags: "--status <status>", description: "confirmed, tentative, cancelled, draft, or unknown" })
    status?: string,
    @Option({ flags: "--busy <busy>", description: "busy, free, tentative, out_of_office, or unknown" }) busy?: string,
    @Option({ flags: "--visibility <visibility>", description: "default, private, public, or confidential" })
    visibility?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local write idempotency key" }) idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const event = readCalendarEvent(eventId);
      const calendar = requireCalendar(event.calendarId);
      requireCalendarPermission("write", calendar);
      const result = updateCalendarEvent(event.id, {
        title,
        description,
        location,
        status: parseEventStatus(status),
        busyStatus: parseBusyStatus(busy),
        visibility: parseEventVisibility(visibility),
        startAt: start ? parseTime(start, "--start") : undefined,
        endAt: end ? parseTime(end, "--end") : undefined,
        idempotencyKey,
      });
      const payload = {
        event: safeCalendarEvent(result.event, "read"),
        outbox: result.outbox ? redactOutboxPayload(result.outbox) : null,
      };
      printPayload(payload, asJson, () => printRecord("Event", payload));
      return payload;
    });
  }

  @Command({ name: "cancel", description: "Cancel a local calendar event" })
  async cancel(
    @Arg("event", { description: "Local event id" }) eventId: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local write idempotency key" }) idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const event = readCalendarEvent(eventId);
      const calendar = requireCalendar(event.calendarId);
      requireCalendarPermission("write", calendar);
      const result = cancelCalendarEvent(event.id, { idempotencyKey });
      const payload = {
        event: safeCalendarEvent(result.event, "read"),
        outbox: result.outbox ? redactOutboxPayload(result.outbox) : null,
      };
      printPayload(payload, asJson, () => printRecord("Event", payload));
      return payload;
    });
  }

  @Command({ name: "respond", description: "Record an attendee response and enqueue provider delivery" })
  async respond(
    @Arg("event", { description: "Local event id" }) eventId: string,
    @Option({ flags: "--status <status>", description: "accepted, declined, tentative, needs_action, or unknown" })
    status?: string,
    @Option({ flags: "--attendee-email <email>", description: "Attendee email identity" }) attendeeEmail?: string,
    @Option({ flags: "--attendee-agent <agent>", description: "Attendee agent id" }) attendeeAgent?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Local write idempotency key" }) idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      requireOption(status, "--status");
      const event = readCalendarEvent(eventId);
      const calendar = requireCalendar(event.calendarId);
      requireCalendarPermission("respond", calendar);
      const result = respondToCalendarEvent(event.id, {
        status: parseResponseStatus(status),
        attendeeEmail,
        attendeeAgentId: attendeeAgent,
        idempotencyKey,
      });
      const payload = {
        event: safeCalendarEvent(result.event, "read"),
        outbox: redactOutboxPayload(result.outbox),
      };
      printPayload(payload, asJson, () => printRecord("Event", payload));
      return payload;
    });
  }
}

@Group({
  name: "calendar.outbox",
  description: "Inspect and retry local calendar provider delivery rows",
  scope: "open",
})
export class CalendarOutboxCommands {
  @Command({ name: "status", description: "Show local calendar outbox status" })
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return runCalendarCommand(asJson, async () => {
      const rows = listCalendarOutbox({ limit: 500 }).filter((row) => canUseRowCalendar("write", row.calendarId));
      const counts = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {});
      const payload = { counts, total: rows.length };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }

  @Command({ name: "list", description: "List local calendar outbox rows" })
  async list(
    @Option({ flags: "--status <status>", description: "Filter by outbox status" }) status?: string,
    @Option({ flags: "--calendar <calendar>", description: "Local calendar id or name" }) calendarRef?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      if (calendarRef) requireCalendarPermission("write", requireCalendar(calendarRef));
      const outbox = listCalendarOutbox({
        status: parseOutboxStatus(status),
        calendar: calendarRef,
        limit: parseOptionalInteger(limit, "--limit"),
        offset: parseOptionalInteger(offset, "--offset"),
      }).filter((row) => canUseRowCalendar("write", row.calendarId));
      const payload = { outbox: outbox.map(redactOutboxPayload) };
      printPayload(payload, asJson, () => printItems("Outbox", payload, ["id", "status", "operation", "eventId"]));
      return payload;
    });
  }

  @Command({ name: "inspect", description: "Inspect one local calendar outbox row" })
  async inspect(
    @Arg("outbox", { description: "Local outbox id" }) outboxId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const outbox = getCalendarOutbox(outboxId);
      if (!outbox) throw new CloudAuthError("PAYLOAD_INVALID", `Calendar outbox row not found: ${outboxId}`);
      requireCalendarPermission("write", requireCalendar(outbox.calendarId));
      const payload = { outbox: redactOutboxPayload(outbox) };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }

  @Command({ name: "retry", description: "Move a failed/dead local outbox row back to pending" })
  async retry(
    @Arg("outbox", { description: "Local outbox id" }) outboxId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const existing = getCalendarOutbox(outboxId);
      if (!existing) throw new CloudAuthError("PAYLOAD_INVALID", `Calendar outbox row not found: ${outboxId}`);
      requireCalendarPermission("write", requireCalendar(existing.calendarId));
      const outbox = retryCalendarOutbox(outboxId);
      const payload = { outbox: redactOutboxPayload(outbox) };
      printPayload(payload, asJson, () => printRecord("Outbox", payload));
      return payload;
    });
  }
}

@Group({
  name: "calendar",
  description: "Use local-first Ravi calendar",
  scope: "open",
})
export class CalendarCommands {
  @Command({ name: "availability", description: "Return free/busy availability in a bounded time window" })
  async availability(
    @Option({ flags: "--calendar <calendar>", description: "Local calendar id or name" }) calendarRef?: string,
    @Option({ flags: "--from <time>", description: "Window start; default now" }) from?: string,
    @Option({ flags: "--to <time>", description: "Window end; default +30d" }) to?: string,
    @Option({ flags: "--limit <n>", description: "Maximum records" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCalendarCommand(asJson, async () => {
      const { fromMs, toMs } = parseWindow(from, to);
      const calendars = resolveAvailabilityCalendars(calendarRef);
      const events = calendars.length
        ? (listCalendarEvents({
            calendarIds: calendars.map((calendar) => calendar.id),
            from: fromMs,
            to: toMs,
            includeAttendees: false,
            limit: parseOptionalInteger(limit, "--limit"),
          }) as CalendarEventWithAttendees[])
        : [];
      const byCalendar = new Map(calendars.map((calendar) => [calendar.id, calendar]));
      const busy = events.map((event) => {
        const calendar = byCalendar.get(event.calendarId);
        const access = calendar ? calendarAccessLevel(getCalendarScopeContext(), calendar) : "none";
        return {
          eventId: access === "read" ? event.id : undefined,
          calendarId: event.calendarId,
          startAt: event.startAt,
          endAt: event.endAt,
          busyStatus: event.busyStatus,
          title: access === "read" ? event.title : "Busy",
          redacted: access !== "read",
        };
      });
      const payload = {
        window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        busy,
      };
      printPayload(payload, asJson, () =>
        printItems("Busy blocks", { busy }, ["calendarId", "title", "startAt", "endAt"]),
      );
      return payload;
    });
  }
}

const nullableStringSchema = z.string().nullable();
const nullableNumberSchema = z.number().nullable();

const calendarAccountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["active", "paused", "auth_required", "disabled"]),
  defaultCalendarId: nullableStringSchema,
  credentialsRef: nullableStringSchema,
  capabilities: jsonObjectSchema,
  settings: jsonObjectSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const calendarCalendarSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  providerCalendarId: nullableStringSchema,
  name: z.string(),
  description: nullableStringSchema,
  color: nullableStringSchema,
  timezone: nullableStringSchema,
  role: z.string(),
  status: z.enum(["active", "paused", "disabled", "deleted"]),
  visibility: z.enum(["private", "shared", "public", "local_only"]),
  ownerType: z.string(),
  ownerId: z.string(),
  isDefault: z.boolean(),
  lastSyncedAt: nullableNumberSchema,
  metadata: jsonObjectSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const calendarMemberSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  memberType: z.string(),
  memberId: z.string(),
  relation: z.enum(["owner", "reader", "writer", "manager", "free_busy"]),
  expiresAt: nullableNumberSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const calendarAttendeeSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  kind: z.enum(["organizer", "required", "optional", "resource", "informational"]),
  responseStatus: z.enum(["accepted", "declined", "tentative", "needs_action", "unknown"]),
  email: nullableStringSchema,
  normalizedEmail: nullableStringSchema,
  displayName: nullableStringSchema,
  contactId: nullableStringSchema,
  agentId: nullableStringSchema,
  platformIdentityId: nullableStringSchema,
  providerAttendeeId: nullableStringSchema,
  raw: jsonObjectSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const calendarEventSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  accountId: z.string(),
  uid: z.string(),
  providerEventId: nullableStringSchema,
  providerRecurringEventId: nullableStringSchema,
  icalUid: nullableStringSchema,
  seriesId: nullableStringSchema,
  originalStartAt: nullableNumberSchema,
  title: z.string(),
  description: nullableStringSchema,
  descriptionRedactionStatus: z.enum(["full_local", "preview_only", "redacted", "missing"]),
  location: nullableStringSchema,
  locationRedactionStatus: z.enum(["full_local", "preview_only", "redacted", "missing"]),
  status: z.enum(["confirmed", "tentative", "cancelled", "draft", "unknown"]),
  busyStatus: z.enum(["busy", "free", "tentative", "out_of_office", "unknown"]),
  visibility: z.enum(["default", "private", "public", "confidential"]),
  startAt: z.number(),
  endAt: z.number(),
  startTimezone: nullableStringSchema,
  endTimezone: nullableStringSchema,
  allDay: z.boolean(),
  recurrenceRule: nullableStringSchema,
  recurrence: jsonObjectSchema,
  sequence: z.number(),
  etag: nullableStringSchema,
  organizerContactId: nullableStringSchema,
  organizerAgentId: nullableStringSchema,
  organizerPlatformIdentityId: nullableStringSchema,
  creatorContactId: nullableStringSchema,
  creatorAgentId: nullableStringSchema,
  creatorPlatformIdentityId: nullableStringSchema,
  safePayload: jsonObjectSchema,
  providerProvenance: jsonObjectSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: nullableNumberSchema,
});

const calendarEventWithAttendeesSchema = calendarEventSchema.extend({
  attendees: z.array(calendarAttendeeSchema),
});

const redactedCalendarEventSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  accountId: z.string(),
  title: z.literal("Busy"),
  status: z.enum(["confirmed", "tentative", "cancelled", "draft", "unknown"]),
  busyStatus: z.enum(["busy", "free", "tentative", "out_of_office", "unknown"]),
  startAt: z.number(),
  endAt: z.number(),
  redacted: z.literal(true),
});

const safeCalendarEventSchema = z.union([calendarEventWithAttendeesSchema, redactedCalendarEventSchema]);

const calendarOutboxSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  calendarId: z.string(),
  eventId: z.string(),
  operation: z.enum(["create", "update", "cancel", "delete", "respond"]),
  idempotencyKey: z.string(),
  payload: jsonObjectSchema,
  status: z.enum(["pending", "leased", "sending", "sent", "acked", "failed", "dead"]),
  attemptCount: z.number(),
  nextAttemptAt: z.number(),
  lastErrorCode: nullableStringSchema,
  providerResult: jsonObjectSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const calendarWindowSchema = z.object({
  from: z.string(),
  to: z.string(),
});

const calendarEventMutationReturnSchema = z.object({
  event: safeCalendarEventSchema,
  outbox: calendarOutboxSchema.nullable(),
});

declareCommandReturns(CalendarAccountsCommands, {
  list: z.object({ accounts: z.array(calendarAccountSchema) }),
  create: z.object({ account: calendarAccountSchema }),
  sync: z.union([
    z.object({
      ok: z.literal(true),
      account: calendarAccountSchema,
      status: z.literal("adapter_not_required"),
      localFirst: z.literal(true),
    }),
    z.object({
      ok: z.literal(false),
      account: calendarAccountSchema,
      status: z.literal("adapter_not_started"),
      message: z.string(),
    }),
  ]),
});

declareCommandReturns(CalendarCalendarsCommands, {
  list: z.object({ calendars: z.array(calendarCalendarSchema) }),
  create: z.object({ calendar: calendarCalendarSchema }),
  show: z.object({ calendar: calendarCalendarSchema, members: z.array(calendarMemberSchema).optional() }),
  share: z.object({ calendar: calendarCalendarSchema, member: calendarMemberSchema }),
  disable: z.object({ calendar: calendarCalendarSchema }),
});

declareCommandReturns(CalendarEventsCommands, {
  list: z.object({ window: calendarWindowSchema, events: z.array(safeCalendarEventSchema) }),
  read: z.object({ event: safeCalendarEventSchema }),
  create: calendarEventMutationReturnSchema,
  update: calendarEventMutationReturnSchema,
  cancel: calendarEventMutationReturnSchema,
  respond: z.object({ event: safeCalendarEventSchema, outbox: calendarOutboxSchema }),
});

declareCommandReturns(CalendarOutboxCommands, {
  status: z.object({ counts: stringNumberRecordSchema, total: z.number() }),
  list: z.object({ outbox: z.array(calendarOutboxSchema) }),
  inspect: z.object({ outbox: calendarOutboxSchema }),
  retry: z.object({ outbox: calendarOutboxSchema }),
});

declareCommandReturns(CalendarCommands, {
  availability: z.object({
    window: calendarWindowSchema,
    busy: z.array(
      z.object({
        eventId: z.string().optional(),
        calendarId: z.string(),
        startAt: z.number(),
        endAt: z.number(),
        busyStatus: z.enum(["busy", "free", "tentative", "out_of_office", "unknown"]),
        title: z.string(),
        redacted: z.boolean(),
      }),
    ),
  }),
});

async function runCalendarCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const cloudError =
      error instanceof CloudAuthError
        ? error
        : new CloudAuthError("PAYLOAD_INVALID", error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    const formatted = cloudAuthErrorFromUnknown(cloudError);
    if (asJson) {
      printJson(formatCloudAuthError(formatted));
    } else {
      console.error(`${formatted.code}: ${formatted.message}`);
    }
    if (hasContext()) throw formatted;
    process.exit(formatted.exitCode);
  }
}

function visibleCalendars(options: Parameters<typeof listCalendars>[0] = {}): CalendarCalendar[] {
  const ctx = getCalendarScopeContext();
  return listCalendars({ ...options, status: options.status ?? "active", limit: options.limit ?? 500 }).filter(
    (calendar) => calendarAccessLevel(ctx, calendar) !== "none",
  );
}

function resolveReadableCalendars(calendarRef?: string): CalendarCalendar[] {
  if (calendarRef?.trim()) {
    const calendar = requireCalendar(calendarRef);
    const access = calendarAccessLevel(getCalendarScopeContext(), calendar);
    if (access === "none") requireCalendarPermission("search", calendar);
    return [calendar];
  }
  return visibleCalendars();
}

function resolveAvailabilityCalendars(calendarRef?: string): CalendarCalendar[] {
  if (calendarRef?.trim()) {
    const calendar = requireCalendar(calendarRef);
    requireCalendarPermission("free-busy", calendar);
    return [calendar];
  }
  return visibleCalendars().filter((calendar) => canUseCalendar(getCalendarScopeContext(), "free-busy", calendar));
}

function resolveWriteCalendar(calendarRef?: string): CalendarCalendar {
  if (calendarRef?.trim()) return requireCalendar(calendarRef);
  const calendars = visibleCalendars().filter((calendar) =>
    canUseCalendar(getCalendarScopeContext(), "write", calendar),
  );
  const calendar = calendars.find((item) => item.isDefault) ?? calendars[0];
  if (!calendar) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "No writable local calendar. Create one with `ravi calendar calendars create`.",
    );
  }
  return calendar;
}

function resolveCalendarAccount(accountId?: string) {
  if (accountId?.trim()) {
    const account = getCalendarAccount(accountId);
    if (!account) throw new CloudAuthError("PAYLOAD_INVALID", `Calendar account not found: ${accountId}`);
    return account;
  }
  const active = listCalendarAccounts({ status: "active", limit: 500 });
  const account =
    active.find((item) => item.provider === "local") ?? active[0] ?? createCalendarAccount({ provider: "local" });
  return account;
}

function requireCalendar(calendarRef: string): CalendarCalendar {
  const calendar = getCalendar(calendarRef);
  if (!calendar) throw new CloudAuthError("PAYLOAD_INVALID", `Calendar not found: ${calendarRef}`);
  return calendar;
}

function requireCalendarPermission(
  permission: "read" | "search" | "free-busy" | "write" | "respond" | "manage",
  calendar: CalendarCalendar,
): void {
  const ctx = getCalendarScopeContext();
  if (canUseCalendar(ctx, permission, calendar)) return;
  throw new CloudAuthError(
    "ORG_ACCESS_DENIED",
    `Permission denied: agent:${ctx.agentId} requires ${permission} on calendar:${calendar.id}`,
  );
}

function requireProviderPermission(permission: "sync" | "manage", provider: string): void {
  const ctx = getCalendarScopeContext();
  if (canUseCalendarProvider(ctx, permission, provider)) return;
  throw new CloudAuthError(
    "ORG_ACCESS_DENIED",
    `Permission denied: agent:${ctx.agentId} requires ${permission} on calendar-provider:${provider}`,
  );
}

function canUseRowCalendar(
  permission: "read" | "search" | "free-busy" | "write" | "respond" | "manage",
  calendarId: string,
): boolean {
  const calendar = getCalendar(calendarId);
  return Boolean(calendar && canUseCalendar(getCalendarScopeContext(), permission, calendar));
}

function safeCalendarEvents(
  events: CalendarEventWithAttendees[],
  calendars: CalendarCalendar[],
): Record<string, unknown>[] {
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  return events.map((event) => {
    const calendar = byId.get(event.calendarId);
    const access = calendar ? calendarAccessLevel(getCalendarScopeContext(), calendar) : "none";
    return safeCalendarEvent(event, access);
  });
}

function safeCalendarEvent(
  event: CalendarEventWithAttendees,
  access: "read" | "free-busy" | "none",
): Record<string, unknown> {
  if (access !== "read") {
    return {
      id: event.id,
      calendarId: event.calendarId,
      accountId: event.accountId,
      title: "Busy",
      status: event.status,
      busyStatus: event.busyStatus,
      startAt: event.startAt,
      endAt: event.endAt,
      redacted: true,
    };
  }
  return {
    ...event,
    providerProvenance: sanitizeProviderProvenance(event.providerProvenance),
  };
}

function sanitizeProviderProvenance(value: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|credential|password/i.test(key)) continue;
    safe[key] = item;
  }
  return safe;
}

function redactOutboxPayload<T extends CalendarOutboxRow>(outbox: T): T {
  return {
    ...outbox,
    payload: {
      ...outbox.payload,
      ...(typeof outbox.payload.description === "string" ? { description: "[redacted]" } : {}),
      ...(typeof outbox.payload.location === "string" ? { location: "[redacted]" } : {}),
      ...(outbox.payload.attendees ? { attendees: "[redacted]" } : {}),
    },
  };
}

function parseAttendees(value: string | undefined) {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ kind: "required" as const, responseStatus: "needs_action" as const, email }));
}

function parseWindow(from: string | undefined, to: string | undefined): { fromMs: number; toMs: number } {
  const now = Date.now();
  const fromMs = from?.trim() ? parseTime(from, "--from", now) : now;
  const toMs = to?.trim() ? parseTime(to, "--to", fromMs) : fromMs + DEFAULT_WINDOW_MS;
  if (toMs <= fromMs) throw new CloudAuthError("PAYLOAD_INVALID", "--to must be after --from.");
  return { fromMs, toMs };
}

function parseTime(value: string | undefined, label: string, base = Date.now()): number {
  if (!value?.trim()) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  const raw = value.trim();
  if (raw === "now") return Date.now();
  const relative = raw.match(/^([+-]?\d+)(m|h|d)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return base + amount * factor;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new CloudAuthError("PAYLOAD_INVALID", `${label} must be ISO, Unix ms, now, or relative like +2h.`);
}

function defaultOwnerSubject(): { type: string; id: string } {
  const ctx = getCalendarScopeContext();
  return ctx.agentId ? { type: "agent", id: ctx.agentId } : { type: "system", id: "ravi" };
}

function parseSubject(
  value: string | undefined,
  fallback?: { type: string; id: string },
): { type: string; id: string } {
  if (!value?.trim()) {
    if (fallback) return fallback;
    throw new CloudAuthError("PAYLOAD_INVALID", "Subject must use <type:id>, e.g. agent:main.");
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Subject must use <type:id>, e.g. agent:main.");
  }
  return { type: value.slice(0, separator), id: value.slice(separator + 1) };
}

function parseAccountStatus(value: string | undefined): CalendarAccountStatus | undefined {
  if (!value?.trim()) return undefined;
  if (value === "active" || value === "paused" || value === "auth_required" || value === "disabled") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseCalendarRole(value: string | undefined): CalendarRole {
  if (!value?.trim()) return "primary";
  if (
    value === "primary" ||
    value === "secondary" ||
    value === "shared" ||
    value === "resource" ||
    value === "system" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --role value.");
}

function parseCalendarStatus(value: string | undefined): CalendarStatus | undefined {
  if (!value?.trim()) return undefined;
  if (value === "active" || value === "paused" || value === "disabled" || value === "deleted") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseCalendarVisibility(value: string | undefined): CalendarVisibility {
  if (!value?.trim()) return "private";
  if (value === "private" || value === "shared" || value === "public" || value === "local_only") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --visibility value.");
}

function parseEventStatus(value: string | undefined): CalendarEventStatus | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "confirmed" ||
    value === "tentative" ||
    value === "cancelled" ||
    value === "draft" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseBusyStatus(value: string | undefined): CalendarBusyStatus | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "busy" ||
    value === "free" ||
    value === "tentative" ||
    value === "out_of_office" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --busy value.");
}

function parseEventVisibility(value: string | undefined): CalendarEventVisibility | undefined {
  if (!value?.trim()) return undefined;
  if (value === "default" || value === "private" || value === "public" || value === "confidential") return value;
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --visibility value.");
}

function parseResponseStatus(
  value: string | undefined,
): "accepted" | "declined" | "tentative" | "needs_action" | "unknown" {
  if (
    value === "accepted" ||
    value === "declined" ||
    value === "tentative" ||
    value === "needs_action" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function parseMemberRelation(value: string | undefined): CalendarMemberRelation {
  if (!value?.trim()) return "reader";
  if (value === "owner" || value === "reader" || value === "writer" || value === "manager" || value === "free_busy") {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --relation value.");
}

function parseOutboxStatus(value: string | undefined): CalendarOutboxStatus | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "pending" ||
    value === "leased" ||
    value === "sending" ||
    value === "sent" ||
    value === "acked" ||
    value === "failed" ||
    value === "dead"
  ) {
    return value;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "Invalid --status value.");
}

function requireOption(value: string | undefined, label: string): void {
  if (!value?.trim()) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${label} must be a non-negative integer.`);
  }
  return parsed;
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printItems(title: string, payload: Record<string, unknown>, preferredFields: string[]): void {
  const items = extractItems(payload);
  if (!items.length) {
    console.log(`No ${title.toLowerCase()} found.`);
    return;
  }
  console.log(`${title}: ${items.length}`);
  for (const item of items) console.log(`- ${formatSummary(item, preferredFields)}`);
}

function printRecord(title: string, payload: Record<string, unknown>): void {
  const record = extractRecord(payload);
  console.log(`${title}: ${formatSummary(record, ["id", "name", "title", "status", "provider", "total"])}`);
}

function extractItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["accounts", "calendars", "events", "outbox", "busy"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function extractRecord(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["account", "calendar", "event", "member", "outbox", "sync"]) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return payload;
}

function formatSummary(record: Record<string, unknown>, preferredFields: string[]): string {
  const parts: string[] = [];
  for (const field of preferredFields) {
    const value = record[field];
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${field}=${formatValue(value)}`);
  }
  if (parts.length) return parts.join(" ");
  return (
    Object.entries(record)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, 4)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ") || JSON.stringify(record)
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
