import { describe, expect, test } from "bun:test";

import { eventRecordState, guestsLine, recordModeHint, syncProblem } from "./model";
import type { CalendarEvent } from "./types";

const now = Date.parse("2026-10-20T12:00:00Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    connectionId: "c1",
    title: "Weekly",
    startAt: "2026-10-20T13:00:00Z",
    endAt: "2026-10-20T13:30:00Z",
    allDay: false,
    status: "confirmed",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    organizerEmail: null,
    selfResponse: "accepted",
    attendees: [],
    externalAttendees: false,
    recordDecision: null,
    recordDecisionProjectId: null,
    recordError: null,
    effectiveRecordMode: null,
    recording: null,
    hasBriefing: false,
    updatedAt: "2026-10-20T10:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("eventRecordState", () => {
  test("undecided meetings offer both choices", () => {
    expect(eventRecordState(event(), now)).toMatchObject({ label: "Not decided", canRecord: true, canSkip: true });
  });

  test("auto records, unless outside guests are in the call", () => {
    expect(eventRecordState(event({ effectiveRecordMode: "auto" }), now)).toMatchObject({ label: "Records automatically", canRecord: false, canSkip: true });
    expect(eventRecordState(event({ effectiveRecordMode: "auto", externalAttendees: true }), now)).toMatchObject({
      tone: "warn",
      canRecord: true,
    });
  });

  test("a decision can be undone; a linked bot and a started call cannot", () => {
    expect(eventRecordState(event({ recordDecision: "record" }), now)).toMatchObject({ label: "Ravi will join", canClear: true });
    expect(eventRecordState(event({ recordDecision: "skip" }), now)).toMatchObject({ canRecord: true, canClear: true });
    expect(
      eventRecordState(event({ recording: { meetingId: "m", status: "recording", ready: false, projectId: "p" } }), now),
    ).toMatchObject({ label: "Ravi is in the call", canRecord: false, canSkip: false });
    expect(eventRecordState(event({ startAt: "2026-10-20T11:00:00Z" }), now)).toMatchObject({ canRecord: false });
    expect(eventRecordState(event({ meetingCode: null }), now).label).toBe("No Meet link");
  });
});

describe("labels", () => {
  test("auto with the policy off says why it asks", () => {
    expect(recordModeHint("auto", false)).toContain("turns it on");
    expect(recordModeHint(null, true)).toContain("asks you once");
  });

  test("sync problems read as sentences", () => {
    expect(syncProblem(null)).toBeNull();
    expect(syncProblem("auth_required")).toContain("Reconnect");
    expect(syncProblem("provider_500")).toContain("tries again");
  });

  test("guests line names two and counts the rest", () => {
    const attendees = ["me", "ana", "bruno", "caio"].map((name, index) => ({
      email: `${name}@acme.test`,
      name: index === 1 ? "Ana" : null,
      response: null,
      organizer: false,
      self: index === 0,
    }));
    expect(guestsLine(event({ attendees }))).toBe("Ana, bruno and 1 other");
    expect(guestsLine(event())).toBeNull();
  });
});
