// Words for meeting bot states, durations and failures. No vendor names: the
// bot is Ravi's own to the person reading.

import type { Tone } from "@/ui/badge";

import type { Meeting, MeetingStatus } from "./types";

export const OPEN_STATUSES: readonly MeetingStatus[] = ["requested", "joining", "waiting_room", "in_call", "recording"];

/** Still moving: in a call, on its way, or processing the recording. */
export function isActive(meeting: Pick<Meeting, "status" | "ready">) {
  return OPEN_STATUSES.includes(meeting.status) || meeting.status === "ended" || (meeting.status === "done" && !meeting.ready);
}

export const ACTIVE_REFRESH_MS = 10_000;
// A bot scheduled for later only needs an occasional look until its time nears.
const SCHEDULED_REFRESH_MS = 60_000;
const SCHEDULED_SOON_MS = 2 * 60_000;

/** How often to look again at a meeting, or false once it stopped moving. */
export function refreshInterval(meeting: Pick<Meeting, "status" | "ready" | "joinAt">, now = Date.now()): number | false {
  if (!isActive(meeting)) return false;
  const joinAt = meeting.status === "requested" && meeting.joinAt ? Date.parse(meeting.joinAt) : NaN;
  return Number.isFinite(joinAt) && joinAt - now > SCHEDULED_SOON_MS ? SCHEDULED_REFRESH_MS : ACTIVE_REFRESH_MS;
}

/** Whether the bot can still be asked to leave. */
export function canLeave(meeting: Pick<Meeting, "status">) {
  return OPEN_STATUSES.includes(meeting.status);
}

export type MeetingState = { label: string; tone: Tone; hint: string };

export function meetingState(meeting: Pick<Meeting, "status" | "ready" | "joinAt" | "failureReason" | "statusSubCode">): MeetingState {
  switch (meeting.status) {
    case "requested":
      return meeting.joinAt
        ? { label: "Scheduled", tone: "neutral", hint: "Ravi joins the call at the scheduled time." }
        : { label: "Starting", tone: "info", hint: "Ravi is on its way to the call." };
    case "joining":
      return { label: "Joining", tone: "info", hint: "Ravi is entering the call." };
    case "waiting_room":
      return {
        label: "Waiting to be let in",
        tone: "warn",
        hint: "Someone in the call has to admit Ravi. It gives up after 10 minutes.",
      };
    case "in_call":
      return { label: "In the call", tone: "info", hint: "Ravi is in the call and starts recording in a moment." };
    case "recording":
      return { label: "Recording", tone: "err", hint: "Ravi is recording. It leaves when everyone else does." };
    case "ended":
      return { label: "Processing", tone: "info", hint: "The call ended. The recording and transcript are being prepared." };
    case "done":
      return meeting.ready
        ? { label: "Ready", tone: "ok", hint: "The recording and transcript are ready." }
        : { label: "Processing", tone: "info", hint: "The recording is ready; the transcript is still being prepared." };
    case "failed":
      return { label: "No recording", tone: "err", hint: failureText(meeting.failureReason ?? meeting.statusSubCode) };
  }
}

const FAILURES: Array<[RegExp, string]> = [
  [/limit_exceeded/, "The organization's meeting limits were reached, so Ravi did not join."],
  // Before the admission rule: "recording_permission_denied" also says "denied".
  [/recording_permission/, "The call's host didn't let Ravi record."],
  [/waiting_room|not_admitted|nobody_admitted|denied/, "Nobody let Ravi into the call."],
  [/kicked|removed/, "Someone removed Ravi from the call."],
  [/no_recording|not_recording/, "Ravi was in the call but nothing was recorded."],
  [/meeting_not_found|invalid_meeting|meeting_link/, "The Meet link didn't open a call. Check the link and try again."],
  [/sign_in|login|auth/, "This call only admits signed-in Google accounts."],
  [/ended|call_ended/, "The call ended before Ravi could record."],
  [/timeout/, "Ravi waited too long and left."],
];

/** One sentence about why a bot ended without a recording. */
export function failureText(reason: string | null | undefined) {
  if (!reason) return "Ravi couldn't record this call.";
  const code = reason.toLowerCase();
  for (const [pattern, text] of FAILURES) if (pattern.test(code)) return text;
  return "Ravi couldn't record this call.";
}

/** "1 h 05 min", "12 min", "45 s". */
export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "03:07" or "1:02:09", for timestamps inside a recording. */
export function formatClock(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function meetingTitle(meeting: Pick<Meeting, "title" | "meetingCode">) {
  return meeting.title ?? (meeting.meetingCode ? `Meet ${meeting.meetingCode}` : "Google Meet call");
}

export type MeetingStep = {
  key: "sent" | "scheduled" | "join" | "recording" | "processing" | "failed";
  label: string;
  detail: string | null;
  state: "done" | "current" | "upcoming" | "failed";
  /** When the step began, for a live counter on the current step. */
  since: string | null;
};

const JOIN_LABELS: Partial<Record<MeetingStatus, string>> = {
  requested: "Joining the call",
  joining: "Joining the call",
  waiting_room: "Waiting to be let in",
  in_call: "In the call",
};

/** The path from sending Ravi to a ready recording, and where this bot is on it. */
export function meetingSteps(
  meeting: Pick<
    Meeting,
    "status" | "ready" | "joinAt" | "createdAt" | "recordingStartedAt" | "endedAt" | "maxRecordingSeconds" | "failureReason" | "statusSubCode"
  >,
): MeetingStep[] {
  const steps: MeetingStep[] = [{ key: "sent", label: "Sent", detail: null, state: "done", since: meeting.createdAt }];
  const scheduled = meeting.status === "requested" && meeting.joinAt !== null;

  if (meeting.status === "failed") {
    if (meeting.recordingStartedAt) {
      steps.push({ key: "recording", label: "Recorded", detail: null, state: "done", since: meeting.recordingStartedAt });
    }
    steps.push({
      key: "failed",
      label: "No recording",
      detail: failureText(meeting.failureReason ?? meeting.statusSubCode),
      state: "failed",
      since: meeting.endedAt,
    });
    return steps;
  }

  if (meeting.joinAt) {
    steps.push({
      key: "scheduled",
      label: scheduled ? "Joins at the scheduled time" : "Scheduled",
      detail: null,
      state: scheduled ? "current" : "done",
      since: meeting.joinAt,
    });
  }

  const order: MeetingStatus[] = ["requested", "joining", "waiting_room", "in_call", "recording", "ended", "done"];
  const at = order.indexOf(meeting.status);
  const joining = !scheduled && at <= order.indexOf("in_call");
  steps.push({
    key: "join",
    label: joining ? (JOIN_LABELS[meeting.status] ?? "Joining the call") : scheduled ? "Joins the call" : "Joined the call",
    detail:
      meeting.status === "waiting_room"
        ? "Someone in the call has to admit Ravi. It gives up after 10 minutes."
        : meeting.status === "in_call"
          ? "Recording starts in a moment."
          : null,
    state: joining ? "current" : scheduled ? "upcoming" : "done",
    since: null,
  });

  const recording = meeting.status === "recording";
  const cap = formatDuration(meeting.maxRecordingSeconds);
  steps.push({
    key: "recording",
    label: recording ? "Recording" : at > order.indexOf("recording") ? "Recorded" : "Records the call",
    detail: recording ? `It leaves when everyone else does${cap ? `, or after ${cap}` : ""}.` : null,
    state: recording ? "current" : at > order.indexOf("recording") ? "done" : "upcoming",
    since: meeting.recordingStartedAt,
  });

  const processing = meeting.status === "ended" || (meeting.status === "done" && !meeting.ready);
  steps.push({
    key: "processing",
    label: processing ? "Preparing the recording and transcript" : meeting.ready ? "Ready" : "Recording and transcript ready",
    detail: processing ? "This page updates when they're ready." : null,
    state: processing ? "current" : meeting.ready ? "done" : "upcoming",
    since: meeting.endedAt,
  });
  return steps;
}

/** Choices for how many months transcripts are kept (1 to 36), with the current value always among them. */
export function retentionMonthOptions(current: number) {
  const options = new Set([1, 3, 6, 12, 18, 24, 36]);
  if (Number.isInteger(current) && current >= 1 && current <= 36) options.add(current);
  return [...options].sort((a, b) => a - b);
}
