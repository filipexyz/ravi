import { describe, expect, test } from "bun:test";

import { decideMeeting, effectiveRecordMode, meetingKey, type MeetingRow } from "./decision";

const base = new Date("2026-10-20T13:00:00.000Z");

function row(overrides: Partial<MeetingRow> & { id: string }): MeetingRow {
  return {
    userId: `user-${overrides.id}`,
    status: "confirmed",
    selfResponse: "accepted",
    deletedAt: null,
    externalAttendees: false,
    recordDecision: null,
    recordDecisionProjectId: null,
    recordDecidedAt: null,
    meetingBotId: null,
    createdAt: base,
    recordMode: null,
    projectId: null,
    ...overrides,
  };
}

describe("effectiveRecordMode", () => {
  test("auto acts as ask while the organization's policy is off", () => {
    expect(effectiveRecordMode("auto", false)).toBe("ask");
    expect(effectiveRecordMode("auto", true)).toBe("auto");
    expect(effectiveRecordMode("off", false)).toBe("off");
    expect(effectiveRecordMode(null, true)).toBeNull();
    expect(effectiveRecordMode("weird", true)).toBeNull();
  });

  test("the meeting key is the code and the start", () => {
    expect(meetingKey("abc-defg-hij", base)).toBe("abc-defg-hij@2026-10-20T13:00:00.000Z");
  });
});

describe("decideMeeting: one bot per meeting per organization", () => {
  test("a bot already linked, or sent by hand, is the meeting's bot", () => {
    expect(decideMeeting({ rows: [row({ id: "a" }), row({ id: "b", meetingBotId: "bot-1" })], autoRecordAllowed: true })).toEqual({
      kind: "link",
      meetingBotId: "bot-1",
    });
    expect(decideMeeting({ rows: [row({ id: "a", recordMode: "off" })], autoRecordAllowed: true, existingBotId: "bot-2" })).toEqual({
      kind: "link",
      meetingBotId: "bot-2",
    });
  });

  test("an explicit Record wins over someone else's 'never record', into the decision's project", () => {
    const outcome = decideMeeting({
      rows: [
        row({ id: "a", recordMode: "off" }),
        row({ id: "b", recordDecision: "record", recordDecisionProjectId: "p-decision", projectId: "p-default", recordDecidedAt: base }),
      ],
      autoRecordAllowed: false,
    });
    expect(outcome).toMatchObject({ kind: "record", projectId: "p-decision", reason: "decision", row: { id: "b" } });
  });

  test("the first person who asked records, falling back to their calendar's project", () => {
    const later = new Date(base.getTime() + 60_000);
    const outcome = decideMeeting({
      rows: [
        row({ id: "late", recordDecision: "record", recordDecidedAt: later, projectId: "p-late" }),
        row({ id: "early", recordDecision: "record", recordDecidedAt: base, projectId: "p-early" }),
      ],
      autoRecordAllowed: true,
    });
    expect(outcome).toMatchObject({ kind: "record", projectId: "p-early", row: { id: "early" } });
  });

  test("Record with no project anywhere does not record", () => {
    expect(decideMeeting({ rows: [row({ id: "a", recordDecision: "record" })], autoRecordAllowed: true })).toEqual({
      kind: "none",
      reason: "no_project",
    });
  });

  test("a skip or an 'off' calendar holds back another member's auto", () => {
    const auto = row({ id: "auto", recordMode: "auto", projectId: "p" });
    expect(decideMeeting({ rows: [auto, row({ id: "s", recordDecision: "skip" })], autoRecordAllowed: true })).toEqual({
      kind: "none",
      reason: "skip",
    });
    expect(decideMeeting({ rows: [auto, row({ id: "o", recordMode: "off" })], autoRecordAllowed: true })).toEqual({
      kind: "none",
      reason: "off",
    });
  });

  test("auto records only with the policy on and no external attendee", () => {
    const auto = row({ id: "auto", recordMode: "auto", projectId: "p" });
    expect(decideMeeting({ rows: [auto, row({ id: "ask", recordMode: "ask" })], autoRecordAllowed: true })).toMatchObject({
      kind: "record",
      reason: "auto",
      projectId: "p",
      row: { id: "auto" },
    });
    expect(decideMeeting({ rows: [auto], autoRecordAllowed: false })).toEqual({ kind: "none", reason: "ask" });
    expect(decideMeeting({ rows: [{ ...auto, externalAttendees: true }], autoRecordAllowed: true })).toEqual({
      kind: "none",
      reason: "external_attendees",
    });
  });

  test("declined, cancelled and deleted rows do not count", () => {
    const rows = [
      row({ id: "declined", recordMode: "off", selfResponse: "declined" }),
      row({ id: "cancelled", recordDecision: "skip", status: "cancelled" }),
      row({ id: "deleted", recordMode: "off", deletedAt: base }),
      row({ id: "auto", recordMode: "auto", projectId: "p" }),
    ];
    expect(decideMeeting({ rows, autoRecordAllowed: true })).toMatchObject({ kind: "record", row: { id: "auto" } });
    expect(decideMeeting({ rows: rows.slice(0, 3), autoRecordAllowed: true })).toEqual({ kind: "none", reason: "no_rows" });
  });

  test("nobody chose: nothing is recorded", () => {
    expect(decideMeeting({ rows: [row({ id: "a" }), row({ id: "b", recordMode: "ask" })], autoRecordAllowed: true })).toEqual({
      kind: "none",
      reason: "ask",
    });
  });
});
