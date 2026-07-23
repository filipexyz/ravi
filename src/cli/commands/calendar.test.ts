import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { listCalendarEvents, listCalendarOutbox } from "../../calendar/index.js";
import { buildRegistry } from "../registry-snapshot.js";
import {
  CalendarAccountsCommands,
  CalendarCalendarsCommands,
  CalendarCommands,
  CalendarEventsCommands,
  CalendarOutboxCommands,
} from "./calendar.js";

let stateDir: string | null = null;
let previousAgentId: string | undefined;
let previousSessionKey: string | undefined;
let previousSessionName: string | undefined;

setDefaultTimeout(20_000);

describe("calendar CLI commands", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-cli-test-");
    previousAgentId = process.env.RAVI_AGENT_ID;
    previousSessionKey = process.env.RAVI_SESSION_KEY;
    previousSessionName = process.env.RAVI_SESSION_NAME;
    delete process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_SESSION_KEY;
    delete process.env.RAVI_SESSION_NAME;
  });

  afterEach(async () => {
    restoreEnv("RAVI_AGENT_ID", previousAgentId);
    restoreEnv("RAVI_SESSION_KEY", previousSessionKey);
    restoreEnv("RAVI_SESSION_NAME", previousSessionName);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("registers calendars as the canonical CLI surface", () => {
    const registry = buildRegistry([
      CalendarAccountsCommands,
      CalendarCalendarsCommands,
      CalendarCommands,
      CalendarEventsCommands,
      CalendarOutboxCommands,
    ]);

    expect(registry.groups.map((group) => group.name).sort()).toEqual(["calendars", "calendars.events"]);
    expect(registry.groups.find((group) => group.name === "calendars")?.aliases).toEqual(["calendar"]);
    expect(registry.commands.map((command) => command.fullName).sort()).toContain("calendars.availability");
    expect(registry.commands.map((command) => command.fullName).sort()).toContain("calendars.events.create");
    expect(registry.commands.some((command) => command.fullName.startsWith("calendars.sources."))).toBe(false);
    expect(registry.commands.some((command) => command.fullName.startsWith("calendars.outbox."))).toBe(false);
  });

  it("creates local sources and calendars with JSON output", async () => {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();

    const { output: accountOutput } = await captureConsole(() =>
      accounts.create("local", "acct_1", "Local Calendar", undefined, true),
    );
    const accountPayload = JSON.parse(accountOutput);
    const { output: calendarOutput } = await captureConsole(() =>
      calendars.create(
        "Luis",
        "acct_1",
        undefined,
        "America/Sao_Paulo",
        "Personal agenda",
        "#2563eb",
        "primary",
        "private",
        "agent:main",
        true,
        true,
      ),
    );
    const calendarPayload = JSON.parse(calendarOutput);

    expect(accountPayload.source.provider).toBe("local");
    expect(accountPayload.account.provider).toBe("local");
    expect(calendarPayload.calendar.name).toBe("Luis");
    expect(calendarPayload.calendar.ownerType).toBe("agent");
    expect(calendarPayload.calendar.ownerId).toBe("main");
    expect(calendarPayload.calendar.isDefault).toBe(true);
  });

  it("creates events locally, redacts outbox payloads, and lists within the safe window", async () => {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();
    const events = new CalendarEventsCommands();
    const outbox = new CalendarOutboxCommands();

    await captureConsole(() => accounts.create("local", "acct_1", undefined, undefined, true));
    const { output: calendarOutput } = await captureConsole(() =>
      calendars.create(
        "Luis",
        "acct_1",
        undefined,
        "America/Sao_Paulo",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );
    const calendar = JSON.parse(calendarOutput).calendar;

    const { output } = await captureConsole(() =>
      events.create(
        calendar.id,
        "Planning",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        "Private details",
        "Office",
        "America/Sao_Paulo",
        "alice@example.com",
        "event-1",
        true,
      ),
    );
    const payload = JSON.parse(output);
    const { output: listOutput } = await captureConsole(() =>
      events.list(
        calendar.id,
        "2026-06-05T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    const listPayload = JSON.parse(listOutput);
    const { output: outboxOutput } = await captureConsole(() =>
      outbox.list(undefined, calendar.id, undefined, undefined, true),
    );
    const outboxPayload = JSON.parse(outboxOutput);

    expect(payload.event.title).toBe("Planning");
    expect(payload.outbox.status).toBe("acked");
    expect(payload.outbox.payload.description).toBe("[redacted]");
    expect(payload.outbox.payload.location).toBe("[redacted]");
    expect(listPayload.events).toHaveLength(1);
    expect(outboxPayload.outbox[0].payload.attendees).toBe("[redacted]");
    expect(JSON.stringify(outboxPayload)).not.toContain("Private details");
  });

  it("returns only free/busy facts when the agent lacks calendar read access", async () => {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();
    const events = new CalendarEventsCommands();
    const calendar = new CalendarCommands();

    await captureConsole(() => accounts.create("local", "acct_1", undefined, undefined, true));
    const { output: calendarOutput } = await captureConsole(() =>
      calendars.create(
        "Private",
        "acct_1",
        undefined,
        "America/Sao_Paulo",
        undefined,
        undefined,
        undefined,
        "private",
        "agent:owner",
        true,
        true,
      ),
    );
    const calendarPayload = JSON.parse(calendarOutput);
    await captureConsole(() =>
      events.create(
        calendarPayload.calendar.id,
        "Sensitive Strategy",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        "Sensitive notes",
        "Secret room",
        undefined,
        undefined,
        "sensitive-1",
        true,
      ),
    );

    await captureConsole(() =>
      calendars.share(calendarPayload.calendar.id, "agent:agent-freebusy", "free_busy", undefined, true),
    );
    process.env.RAVI_AGENT_ID = "agent-freebusy";

    const { output: listOutput } = await captureConsole(() =>
      events.list(
        undefined,
        "2026-06-05T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    const listPayload = JSON.parse(listOutput);
    const { output: availabilityOutput } = await captureConsole(() =>
      calendar.availability(undefined, "2026-06-05T00:00:00.000Z", "2026-06-06T00:00:00.000Z", undefined, true),
    );
    const availabilityPayload = JSON.parse(availabilityOutput);

    expect(listPayload.events).toHaveLength(1);
    expect(listPayload.events[0].title).toBe("Busy");
    expect(listPayload.events[0].description).toBeUndefined();
    expect(listPayload.events[0].location).toBeUndefined();
    expect(listPayload.events[0].redacted).toBe(true);
    expect(availabilityPayload.busy[0].title).toBe("Busy");
    expect(availabilityPayload.busy[0].redacted).toBe(true);
  });

  it("shares calendars through Permission Provider Runtime and allows the grantee to read events", async () => {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();
    const events = new CalendarEventsCommands();

    await captureConsole(() => accounts.create("local", "acct_1", undefined, undefined, true));
    const { output: calendarOutput } = await captureConsole(() =>
      calendars.create(
        "Team",
        "acct_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "agent:owner",
        true,
        true,
      ),
    );
    const calendar = JSON.parse(calendarOutput).calendar;
    await captureConsole(() =>
      events.create(
        calendar.id,
        "Shared Planning",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        "Readable notes",
        undefined,
        undefined,
        undefined,
        "shared-1",
        true,
      ),
    );
    await captureConsole(() => calendars.share(calendar.id, "agent:reader", "reader", undefined, true));

    process.env.RAVI_AGENT_ID = "reader";
    const { output } = await captureConsole(() =>
      events.list(
        undefined,
        "2026-06-05T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].title).toBe("Shared Planning");
    expect(payload.events[0].description).toBe("Readable notes");
  });

  it("updates, responds, and cancels via local outbox semantics", async () => {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();
    const events = new CalendarEventsCommands();

    await captureConsole(() => accounts.create("local", "acct_1", undefined, undefined, true));
    const { output: calendarOutput } = await captureConsole(() =>
      calendars.create(
        "Ops",
        "acct_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );
    const calendar = JSON.parse(calendarOutput).calendar;
    const { output: createOutput } = await captureConsole(() =>
      events.create(
        calendar.id,
        "Ops",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        undefined,
        undefined,
        undefined,
        "bob@example.com",
        "ops-1",
        true,
      ),
    );
    const created = JSON.parse(createOutput);

    await captureConsole(() =>
      events.update(
        created.event.id,
        "Ops Updated",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "ops-update-1",
        true,
      ),
    );
    await captureConsole(() =>
      events.respond(created.event.id, "accepted", "bob@example.com", undefined, "ops-respond-1", true),
    );
    await captureConsole(() => events.cancel(created.event.id, "ops-cancel-1", true));

    const rows = listCalendarOutbox();
    const event = listCalendarEvents({
      from: Date.parse("2026-06-05T00:00:00.000Z"),
      to: Date.parse("2026-06-06T00:00:00.000Z"),
      includeCancelled: true,
      includeAttendees: true,
    })[0];

    expect(rows.map((row) => row.operation)).toEqual(["cancel", "respond", "update", "create"]);
    expect(event.status).toBe("cancelled");
    expect(
      listCalendarEvents({ from: Date.parse("2026-06-05T00:00:00.000Z"), to: Date.parse("2026-06-06T00:00:00.000Z") }),
    ).toHaveLength(0);
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
