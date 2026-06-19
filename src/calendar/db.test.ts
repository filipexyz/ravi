import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { agentCan } from "../permissions/provider-runtime.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  addCalendarMember,
  createCalendar,
  createCalendarAccount,
  createCalendarEvent,
  listCalendarAccounts,
  listCalendarEvents,
  listCalendarMembers,
  listCalendarOutbox,
  listCalendars,
  readCalendarEvent,
} from "./index.js";

let stateDir: string | null = null;

describe("local calendar db", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("initializes local calendar schema without provider auth", () => {
    const account = createCalendarAccount({ provider: "local", displayName: "Local" });
    const calendar = createCalendar({
      accountId: account.id,
      name: "Luis",
      timezone: "America/Sao_Paulo",
      isDefault: true,
      ownerType: "agent",
      ownerId: "main",
    });

    expect(listCalendarAccounts()).toHaveLength(1);
    expect(listCalendars()).toHaveLength(1);
    expect(calendar.isDefault).toBe(true);
    expect(calendar.ownerId).toBe("main");
  });

  it("creates local events with acked local outbox rows before provider delivery", () => {
    const account = createCalendarAccount({ provider: "local" });
    const calendar = createCalendar({ accountId: account.id, name: "Local", isDefault: true });
    const startAt = Date.parse("2026-06-05T13:00:00.000Z");
    const endAt = Date.parse("2026-06-05T14:00:00.000Z");

    const first = createCalendarEvent({
      calendarId: calendar.id,
      title: "Planning",
      description: "Private notes",
      location: "Office",
      startAt,
      endAt,
      idempotencyKey: "event-create-1",
    });
    const second = createCalendarEvent({
      calendarId: calendar.id,
      title: "Planning",
      description: "Private notes",
      location: "Office",
      startAt,
      endAt,
      idempotencyKey: "event-create-1",
    });

    expect(second.event.id).toBe(first.event.id);
    expect(second.outbox?.id).toBe(first.outbox?.id);
    expect(first.outbox?.status).toBe("acked");
    expect(listCalendarOutbox()).toHaveLength(1);
    expect(listCalendarOutbox()[0].payload.description).toBe("[redacted]");
  });

  it("dedupes provider events by provider/account/calendar event identity", () => {
    const account = createCalendarAccount({ provider: "google-calendar" });
    const calendar = createCalendar({
      accountId: account.id,
      name: "Google",
      providerCalendarId: "primary",
    });
    const startAt = Date.parse("2026-06-05T13:00:00.000Z");
    const endAt = Date.parse("2026-06-05T14:00:00.000Z");
    const first = createCalendarEvent({
      calendarId: calendar.id,
      providerEventId: "remote_evt_1",
      title: "Original",
      startAt,
      endAt,
      enqueueOutbox: false,
    });
    const second = createCalendarEvent({
      calendarId: calendar.id,
      providerEventId: "remote_evt_1",
      title: "Updated",
      startAt,
      endAt,
      enqueueOutbox: false,
    });

    expect(second.event.id).toBe(first.event.id);
    expect(readCalendarEvent(first.event.id).title).toBe("Updated");
    expect(listCalendarEvents({ from: startAt - 1, to: endAt + 1 })).toHaveLength(1);
  });

  it("requires bounded event windows and returns only overlapping events", () => {
    const account = createCalendarAccount({ provider: "local" });
    const calendar = createCalendar({ accountId: account.id, name: "Local" });
    createCalendarEvent({
      calendarId: calendar.id,
      title: "Morning",
      startAt: Date.parse("2026-06-05T10:00:00.000Z"),
      endAt: Date.parse("2026-06-05T11:00:00.000Z"),
    });
    createCalendarEvent({
      calendarId: calendar.id,
      title: "Afternoon",
      startAt: Date.parse("2026-06-05T15:00:00.000Z"),
      endAt: Date.parse("2026-06-05T16:00:00.000Z"),
    });

    expect(() => listCalendarEvents({ from: 0, to: 0 })).toThrow("bounded");
    const events = listCalendarEvents({
      from: Date.parse("2026-06-05T09:30:00.000Z"),
      to: Date.parse("2026-06-05T12:00:00.000Z"),
    });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Morning");
  });

  it("stores calendar membership without making membership an authorization bypass", () => {
    const account = createCalendarAccount({ provider: "local" });
    const calendar = createCalendar({ accountId: account.id, name: "Team" });

    addCalendarMember({
      calendarId: calendar.id,
      memberType: "agent",
      memberId: "agent-a",
      relation: "reader",
    });

    expect(listCalendarMembers(calendar.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberType: "agent",
          memberId: "agent-a",
          relation: "reader",
        }),
      ]),
    );
    expect(agentCan("agent-a", "read", "calendar", calendar.id)).toBe(false);
    expect(agentCan("agent-a", "write", "calendar", calendar.id)).toBe(false);
  });
});
