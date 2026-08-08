import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { listCalendarEvents, listCalendarMembers, listCalendarOutbox } from "../../calendar/index.js";
import { ContractError } from "../agent-contract.js";
import { hashForAudit } from "../provenance.js";
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
      calendars.share(calendarPayload.calendar.id, "agent:agent-freebusy", "free_busy", undefined, true, true),
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
    await captureConsole(() => calendars.share(calendar.id, "agent:reader", "reader", undefined, true, true));

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
      events.respond(created.event.id, "accepted", "bob@example.com", undefined, "ops-respond-1", true, true),
    );
    await captureConsole(() => events.cancel(created.event.id, "ops-cancel-1", true, true));

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

describe("calendar agent-first contract", () => {
  // RAVI_AGENT_ID makes hasContext() true, so the contract helpers throw
  // ContractError (with the envelope + exit code) instead of process.exit.
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-contract-test-");
    previousAgentId = process.env.RAVI_AGENT_ID;
    previousSessionKey = process.env.RAVI_SESSION_KEY;
    previousSessionName = process.env.RAVI_SESSION_NAME;
    process.env.RAVI_AGENT_ID = "main";
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

  async function setupCalendar() {
    const accounts = new CalendarAccountsCommands();
    const calendars = new CalendarCalendarsCommands();
    await captureConsole(() => accounts.create("local", "acct_1", undefined, undefined, true));
    const { output } = await captureConsole(() =>
      calendars.create(
        "Luis",
        "acct_1",
        undefined,
        "America/Sao_Paulo",
        undefined,
        undefined,
        undefined,
        undefined,
        "agent:main",
        true,
        true,
      ),
    );
    return JSON.parse(output).calendar as { id: string; name: string };
  }

  async function expectContractError(run: () => Promise<unknown>): Promise<InstanceType<typeof ContractError>> {
    let thrown: unknown;
    try {
      await captureConsole(run);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as InstanceType<typeof ContractError>;
  }

  it("blocks calendars share without --execute (dry-run, exit 3, no membership write)", async () => {
    const calendars = new CalendarCalendarsCommands();
    const calendar = await setupCalendar();

    const error = await expectContractError(() =>
      calendars.share(calendar.id, "agent:reader", "reader", undefined, true),
    );
    expect(error.exitCode).toBe(3);
    const envelope = error.envelope();
    expect(envelope.op).toBe("calendars share");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect(envelope.error.plan).toEqual({
      calendarId: calendar.id,
      memberType: "agent",
      memberRef: `sha256:${hashForAudit("agent:reader")}`,
      relation: "reader",
      expiresAtPresent: false,
    });
    const serializedPlan = JSON.stringify(envelope.error.plan);
    expect(serializedPlan).not.toContain(calendar.name);
    expect(serializedPlan).not.toContain("agent:reader");
    expect(listCalendarMembers(calendar.id).some((member) => member.memberId === "reader")).toBe(false);

    await captureConsole(() => calendars.share(calendar.id, "agent:reader", "reader", undefined, true, true));
    expect(listCalendarMembers(calendar.id).some((member) => member.memberId === "reader")).toBe(true);
  });

  it("blocks events respond and cancel without --execute (dry-run, exit 3, no local write)", async () => {
    const events = new CalendarEventsCommands();
    const calendar = await setupCalendar();
    const { output } = await captureConsole(() =>
      events.create(
        calendar.id,
        "Contract Sync",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        undefined,
        undefined,
        undefined,
        "bob@example.com",
        "contract-1",
        true,
      ),
    );
    const created = JSON.parse(output);

    const respondError = await expectContractError(() =>
      events.respond(created.event.id, "accepted", "bob@example.com", undefined, undefined, true),
    );
    expect(respondError.exitCode).toBe(3);
    const respondEnvelope = respondError.envelope();
    expect(respondEnvelope.op).toBe("calendars events respond");
    expect(respondEnvelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(respondEnvelope.error.plan).toEqual({
      eventId: created.event.id,
      calendarId: calendar.id,
      status: "accepted",
      attendeeEmailPresent: true,
      attendeeAgentId: null,
    });
    const serializedRespondPlan = JSON.stringify(respondEnvelope.error.plan);
    expect(serializedRespondPlan).not.toContain("Contract Sync");
    expect(serializedRespondPlan).not.toContain("bob@example.com");
    expect(listCalendarOutbox().some((row) => row.operation === "respond")).toBe(false);

    const cancelError = await expectContractError(() => events.cancel(created.event.id, undefined, true));
    expect(cancelError.exitCode).toBe(3);
    expect(cancelError.envelope().op).toBe("calendars events cancel");
    expect(cancelError.envelope().error.plan).toEqual({
      eventId: created.event.id,
      calendarId: calendar.id,
      attendeeCount: 1,
    });
    const serializedCancelPlan = JSON.stringify(cancelError.envelope().error.plan);
    expect(serializedCancelPlan).not.toContain("Contract Sync");
    expect(serializedCancelPlan).not.toContain("2026-06-05T13:00:00.000Z");
    expect(listCalendarOutbox().some((row) => row.operation === "cancel")).toBe(false);
    const window = { from: Date.parse("2026-06-05T00:00:00.000Z"), to: Date.parse("2026-06-06T00:00:00.000Z") };
    expect(listCalendarEvents(window)[0]?.status).toBe("confirmed");

    await captureConsole(() => events.cancel(created.event.id, undefined, true, true));
    expect(listCalendarOutbox().some((row) => row.operation === "cancel")).toBe(true);
    expect(listCalendarEvents({ ...window, includeCancelled: true })[0]?.status).toBe("cancelled");
  });

  it("emits EVENT_NOT_FOUND envelope with exit 1 on --json", async () => {
    await setupCalendar();
    const events = new CalendarEventsCommands();
    const error = await expectContractError(() => events.read("evt-nope", true));
    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.op).toBe("calendars events read");
    expect(envelope.error.code).toBe("EVENT_NOT_FOUND");
    expect(envelope.error.suggestedAction).toContain("calendars events list");
  });

  it("emits CALENDAR_NOT_FOUND and SOURCE_NOT_FOUND with cheap local suggestions", async () => {
    const calendars = new CalendarCalendarsCommands();
    const accounts = new CalendarAccountsCommands();
    await setupCalendar();

    const calendarError = await expectContractError(() => calendars.show("Luiz", undefined, true));
    expect(calendarError.exitCode).toBe(1);
    const calendarEnvelope = calendarError.envelope();
    expect(calendarEnvelope.error.code).toBe("CALENDAR_NOT_FOUND");
    expect(calendarEnvelope.error.suggestions).toContain("Luis");

    const sourceError = await expectContractError(() => accounts.sync("acct_9", undefined, true));
    expect(sourceError.exitCode).toBe(1);
    const sourceEnvelope = sourceError.envelope();
    expect(sourceEnvelope.op).toBe("calendars sources sync");
    expect(sourceEnvelope.error.code).toBe("SOURCE_NOT_FOUND");
    expect(sourceEnvelope.error.suggestions).toContain("acct_1");
  });

  it("supports --fields compact mode on events list", async () => {
    const events = new CalendarEventsCommands();
    const calendar = await setupCalendar();
    await captureConsole(() =>
      events.create(
        calendar.id,
        "Compact",
        "2026-06-05T13:00:00.000Z",
        "2026-06-05T14:00:00.000Z",
        undefined,
        undefined,
        undefined,
        undefined,
        "compact-1",
        true,
      ),
    );

    const { output } = await captureConsole(() =>
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
        "id,title",
      ),
    );
    const payload = JSON.parse(output);
    expect(payload.events).toHaveLength(1);
    expect(Object.keys(payload.events[0]).sort()).toEqual(["id", "title"]);
    expect(payload.events[0].title).toBe("Compact");
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
