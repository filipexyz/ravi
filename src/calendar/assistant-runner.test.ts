import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CronJob, CronJobInput } from "../cron/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { CalendarReminder } from "./assistant.js";
import {
  CALENDAR_ROUTINE_HORIZON_MS,
  CalendarAssistantRunner,
  calendarRoutineScheduled,
  reconcileCalendarRoutines,
  type CalendarRoutineStore,
} from "./assistant-runner.js";
import type { CalendarConsoleClient, ConsoleCalendarOverview } from "./console.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
let stateDir: string | null = null;

function memoryStore(): CalendarRoutineStore & { jobs: CronJob[] } {
  const jobs: CronJob[] = [];
  let next = 0;
  return {
    jobs,
    list: () => [...jobs],
    create: (input: CronJobInput) => {
      const job = {
        ...input,
        id: `job-${++next}`,
        enabled: input.enabled ?? true,
        deleteAfterRun: input.deleteAfterRun ?? false,
        sessionTarget: input.sessionTarget ?? "main",
        executionType: "agent",
        nextRunAt: input.schedule.at,
        createdAt: NOW,
        updatedAt: NOW,
      } as CronJob;
      jobs.push(job);
      return job;
    },
    delete: (id: string) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) return false;
      jobs.splice(index, 1);
      return true;
    },
  };
}

function reminder(key: string, at: number): CalendarReminder {
  return {
    key,
    kind: "briefing",
    at,
    eventId: "evt-1",
    connectionId: "conn-1",
    description: "Agenda: briefing before a meeting",
    message: "[System] Execute: meeting briefing",
  };
}

describe("reconcileCalendarRoutines", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-assistant-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("schedules each reminder once, as an operator routine on the agent's main session", () => {
    const store = memoryStore();
    const wanted = [reminder("calendar:briefing:evt-1:1", NOW + 3600_000)];
    expect(reconcileCalendarRoutines({ reminders: wanted, agentId: "main", now: NOW, routines: store })).toEqual({
      created: 1,
      removed: 0,
    });
    expect(store.jobs[0]).toMatchObject({
      name: "calendar:briefing:evt-1:1",
      agentId: "main",
      sessionTarget: "main",
      deleteAfterRun: true,
      ownerPrincipal: "operator",
      schedule: { type: "at", at: NOW + 3600_000 },
    });

    // The routine ran and deleted itself: it is not scheduled again.
    store.jobs.length = 0;
    expect(reconcileCalendarRoutines({ reminders: wanted, agentId: "main", now: NOW, routines: store }).created).toBe(
      0,
    );
    expect(store.jobs).toHaveLength(0);
  });

  it("removes a waiting routine whose reminder went away and forgets it", () => {
    const store = memoryStore();
    const key = "calendar:briefing:evt-1:1";
    reconcileCalendarRoutines({
      reminders: [reminder(key, NOW + 3600_000)],
      agentId: "main",
      now: NOW,
      routines: store,
    });
    store.create({ name: "weekly report", schedule: { type: "at", at: NOW + 3600_000 }, message: "x" });
    store.create({ name: "calendar:personal", schedule: { type: "at", at: NOW + 3600_000 }, message: "x" });

    expect(reconcileCalendarRoutines({ reminders: [], agentId: "main", now: NOW, routines: store })).toEqual({
      created: 0,
      removed: 1,
    });
    expect(store.jobs.map((job) => job.name)).toEqual(["weekly report", "calendar:personal"]);
    expect(calendarRoutineScheduled(key)).toBe(false);
  });

  it("keeps waiting routines when the events listing was cut", () => {
    const store = memoryStore();
    const key = "calendar:briefing:evt-1:2";
    reconcileCalendarRoutines({
      reminders: [reminder(key, NOW + 3600_000)],
      agentId: "main",
      now: NOW,
      routines: store,
    });

    expect(
      reconcileCalendarRoutines({ reminders: [], agentId: "main", now: NOW, routines: store, keepUnplanned: true }),
    ).toEqual({ created: 0, removed: 0 });
    expect(store.jobs.map((job) => job.name)).toEqual([key]);
  });

  it("leaves a routine about to run, and schedules nothing beyond the horizon", () => {
    const store = memoryStore();
    reconcileCalendarRoutines({
      reminders: [reminder("calendar:prep:evt-1:1", NOW + 30_000)],
      agentId: "main",
      now: NOW,
      routines: store,
    });
    expect(reconcileCalendarRoutines({ reminders: [], agentId: "main", now: NOW, routines: store }).removed).toBe(0);

    const far = reminder("calendar:briefing:evt-2:1", NOW + CALENDAR_ROUTINE_HORIZON_MS + 60_000);
    expect(reconcileCalendarRoutines({ reminders: [far], agentId: "main", now: NOW, routines: store }).created).toBe(0);
    expect(calendarRoutineScheduled(far.key)).toBe(false);
  });

  it("never schedules a routine in the past", () => {
    const store = memoryStore();
    reconcileCalendarRoutines({
      reminders: [reminder("calendar:followup:evt-1:bot", NOW - 1000)],
      agentId: "main",
      now: NOW,
      routines: store,
    });
    expect(store.jobs[0]?.schedule.at).toBe(NOW + 10_000);
  });
});

describe("CalendarAssistantRunner", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-assistant-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const overview: ConsoleCalendarOverview = {
    connections: [
      {
        connectionId: "conn-1",
        email: "luis@example.com",
        displayName: null,
        hasCalendarScope: true,
        settings: {
          syncEnabled: true,
          recordMode: null,
          projectId: null,
          briefingEnabled: null,
          briefingMinutes: 30,
          followupEnabled: null,
        },
        lastSyncedAt: null,
        lastSyncError: null,
      },
    ],
    policy: { autoRecordAllowed: false, canManage: false },
    meetingsEnabled: true,
    projects: [],
  };

  it("skips quietly without a login and schedules the setup question with one", async () => {
    const store = memoryStore();
    let refreshes = 0;
    const base = { routines: store, agentId: () => "main", now: () => NOW, emitRefresh: async () => void refreshes++ };

    const noLogin = new CalendarAssistantRunner({ ...base, openClient: () => null });
    expect(await noLogin.tickOnce()).toMatchObject({ status: "skipped", reason: "no_login" });

    const client = {
      overview: async () => overview,
      events: async () => ({ events: [], truncated: false }),
    } as unknown as CalendarConsoleClient;
    const runner = new CalendarAssistantRunner({ ...base, openClient: () => client });
    expect(await runner.tickOnce()).toEqual({ status: "ran", created: 1, removed: 0 });
    expect(store.jobs.map((job) => job.name)).toEqual(["calendar:setup:conn-1"]);
    expect(refreshes).toBe(1);

    expect(await runner.tickOnce()).toEqual({ status: "ran", created: 0, removed: 0 });
    expect(refreshes).toBe(1);
  });
});
