// Whether the organization sends a bot into one calendar meeting. Pure: the
// tick gathers every member's row of the meeting and this picks one outcome
// (spec `console/calendar`, "Recording decision").

export const CALENDAR_RECORD_MODES = ["off", "ask", "auto"] as const;
export type CalendarRecordMode = (typeof CALENDAR_RECORD_MODES)[number];
export type CalendarRecordDecision = "record" | "skip";

/** How far ahead of the start the tick acts on a meeting. */
export const RECORD_WINDOW_MS = 20 * 60 * 1000;
/** A bot of the organization with the same code that joins this close to the start is the meeting's bot. */
export const SAME_MEETING_BOT_TOLERANCE_MS = 10 * 60 * 1000;

export type MeetingRow = {
  id: string;
  userId: string;
  status: string;
  selfResponse: string | null;
  deletedAt: Date | null;
  externalAttendees: boolean;
  recordDecision: string | null;
  recordDecisionProjectId: string | null;
  recordDecidedAt: Date | null;
  meetingBotId: string | null;
  createdAt: Date;
  /** The owner's settings for the calendar this row came from. */
  recordMode: string | null;
  projectId: string | null;
};

export type MeetingOutcome =
  | { kind: "link"; meetingBotId: string }
  | { kind: "record"; row: MeetingRow; projectId: string; reason: "decision" | "auto" }
  | { kind: "none"; reason: "no_rows" | "skip" | "off" | "ask" | "external_attendees" | "no_project" };

/** `auto` acts as `ask` while the organization's policy is off; `null` is never chosen. */
export function effectiveRecordMode(mode: string | null, autoRecordAllowed: boolean): CalendarRecordMode | null {
  if (mode !== "off" && mode !== "ask" && mode !== "auto") return null;
  if (mode === "auto" && !autoRecordAllowed) return "ask";
  return mode;
}

export function meetingKey(meetingCode: string, startAt: Date) {
  return `${meetingCode}@${startAt.toISOString()}`;
}

/** Rows that count: still in the calendar, not cancelled, and not declined by their owner. */
export function liveMeetingRows<T extends MeetingRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.deletedAt && row.status !== "cancelled" && row.selfResponse !== "declined");
}

export function decideMeeting(input: {
  rows: readonly MeetingRow[];
  autoRecordAllowed: boolean;
  /** A bot of the organization already sent to this meeting, outside these rows. */
  existingBotId?: string | null;
}): MeetingOutcome {
  const linked = input.rows.find((row) => row.meetingBotId)?.meetingBotId ?? input.existingBotId ?? null;
  if (linked) return { kind: "link", meetingBotId: linked };

  const rows = liveMeetingRows(input.rows);
  if (rows.length === 0) return { kind: "none", reason: "no_rows" };

  // An explicit Record wins: the first person who asked records into their project.
  const asked = rows
    .filter((row) => row.recordDecision === "record")
    .sort((a, b) => time(a.recordDecidedAt ?? a.createdAt) - time(b.recordDecidedAt ?? b.createdAt) || a.id.localeCompare(b.id));
  for (const row of asked) {
    const projectId = row.recordDecisionProjectId ?? row.projectId;
    if (projectId) return { kind: "record", row, projectId, reason: "decision" };
  }
  if (asked.length > 0) return { kind: "none", reason: "no_project" };

  // Anyone who said no to this meeting, or to recording at all, holds it back.
  if (rows.some((row) => row.recordDecision === "skip")) return { kind: "none", reason: "skip" };
  const modes = rows.map((row) => effectiveRecordMode(row.recordMode, input.autoRecordAllowed));
  if (modes.includes("off")) return { kind: "none", reason: "off" };

  const autos = rows
    .filter((row) => effectiveRecordMode(row.recordMode, input.autoRecordAllowed) === "auto")
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id));
  if (autos.length === 0) return { kind: "none", reason: "ask" };
  if (rows.some((row) => row.externalAttendees)) return { kind: "none", reason: "external_attendees" };
  const owner = autos.find((row) => row.projectId);
  if (!owner?.projectId) return { kind: "none", reason: "no_project" };
  return { kind: "record", row: owner, projectId: owner.projectId, reason: "auto" };
}

function time(date: Date) {
  return date.getTime();
}
