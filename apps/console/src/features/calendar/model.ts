// Labels and states for the calendar screens, kept pure so they can be tested.

import type { Tone } from "@/ui/badge";

import type { CalendarEvent, CalendarRecordMode } from "./types";

export const RECORD_MODE_OPTIONS: { value: CalendarRecordMode; label: string; hint: string }[] = [
  { value: "ask", label: "Ask me before each call", hint: "Your agent asks you about each upcoming call; you can also press Record in Meetings." },
  {
    value: "auto",
    label: "Record automatically",
    hint: "Ravi joins every Google Meet call on this calendar. Calls with people from outside the organization still ask first.",
  },
  { value: "off", label: "Never record", hint: "Ravi stays out of these calls unless someone else in the call asks for it." },
];

export const BRIEFING_MINUTE_OPTIONS = [10, 15, 30, 60, 120];

export function recordModeHint(mode: CalendarRecordMode | null, autoRecordAllowed: boolean) {
  if (mode === "auto" && !autoRecordAllowed) {
    return "Automatic recording is off in this organization, so Ravi asks first until an owner or admin turns it on.";
  }
  if (!mode) return "Nothing is recorded until you choose. Your agent asks you once.";
  return RECORD_MODE_OPTIONS.find((option) => option.value === mode)?.hint ?? "";
}

/** One line on how the last sync went, or null when it is fine. */
export function syncProblem(error: string | null): string | null {
  if (!error) return null;
  if (error === "auth_required") return "Google stopped letting Ravi read this calendar. Reconnect the account.";
  if (error === "calendar_scope_missing") return "This connection can't read the calendar. Reconnect it and allow calendar access.";
  if (error === "rate_limited") return "Google asked Ravi to slow down. It tries again in a few minutes.";
  return "The last sync didn't finish. Ravi tries again in a few minutes.";
}

export type EventRecordState = { label: string; tone: Tone; canRecord: boolean; canSkip: boolean; canClear: boolean };

/** What happens to this meeting, as the person sees it on their row. */
export function eventRecordState(event: CalendarEvent, now = Date.now()): EventRecordState {
  const started = new Date(event.startAt).getTime() <= now;
  const recording = event.recording;
  if (recording) {
    if (recording.status === "done") return { label: recording.ready ? "Recorded" : "Processing", tone: "ok", canRecord: false, canSkip: false, canClear: false };
    if (recording.status === "failed") return { label: "Ravi couldn't record", tone: "err", canRecord: false, canSkip: false, canClear: false };
    if (recording.status === "requested") return { label: "Ravi will join", tone: "info", canRecord: false, canSkip: false, canClear: false };
    return { label: "Ravi is in the call", tone: "info", canRecord: false, canSkip: false, canClear: false };
  }
  if (!event.meetingCode) return { label: "No Meet link", tone: "neutral", canRecord: false, canSkip: false, canClear: false };
  if (started) return { label: "Not recorded", tone: "neutral", canRecord: false, canSkip: false, canClear: false };
  if (event.recordError) return { label: "Couldn't send Ravi", tone: "err", canRecord: true, canSkip: true, canClear: false };
  if (event.recordDecision === "record") return { label: "Ravi will join", tone: "info", canRecord: false, canSkip: true, canClear: true };
  if (event.recordDecision === "skip") return { label: "Not recording", tone: "neutral", canRecord: true, canSkip: false, canClear: true };
  if (event.effectiveRecordMode === "auto") {
    return event.externalAttendees
      ? { label: "Has outside guests: decide", tone: "warn", canRecord: true, canSkip: true, canClear: false }
      : { label: "Records automatically", tone: "info", canRecord: false, canSkip: true, canClear: false };
  }
  if (event.effectiveRecordMode === "off") return { label: "Never recorded", tone: "neutral", canRecord: true, canSkip: false, canClear: false };
  return { label: "Not decided", tone: "warn", canRecord: true, canSkip: true, canClear: false };
}

/** "Today 14:00", "Tomorrow 09:30", or a short date, in the viewer's time zone. */
export function eventWhen(startAt: string, now = new Date()) {
  const start = new Date(startAt);
  const time = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(start) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  return `${start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** Other people in the call, for the row: "Ana, Bruno and 3 others". */
export function guestsLine(event: CalendarEvent) {
  const others = event.attendees.filter((attendee) => !attendee.self);
  if (others.length === 0) return null;
  const names = others.slice(0, 2).map((attendee) => attendee.name ?? attendee.email.split("@")[0]);
  const rest = others.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}` : names.join(" and ");
}
