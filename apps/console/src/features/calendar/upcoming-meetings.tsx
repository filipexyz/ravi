"use client";

import { CalendarDays } from "lucide-react";

import { useWorkspace } from "@/features/shell/workspace";
import { describeError } from "@/lib/api/client";
import { sharedMeetingHref } from "./links";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { useToast } from "@/ui/toast";

import { useCalendarDecision, useCalendarOverview, useUpcomingCalendarEvents } from "./api";
import { eventRecordState, eventWhen, guestsLine } from "./model";
import type { CalendarEvent } from "./types";

const SHOWN = 8;

/**
 * The person's next Google Meet calls from their calendar, on a project's
 * Meetings tab: Record sends Ravi into this project, Don't record keeps it
 * out. Hidden for anyone without a synced calendar, with one line pointing
 * to where it is turned on.
 */
export function UpcomingMeetings({ projectId }: { projectId: string }) {
  const overview = useCalendarOverview();
  const synced = overview.data?.connections.some((connection) => connection.settings.syncEnabled) ?? false;
  const events = useUpcomingCalendarEvents(synced);
  const hasGoogle = (overview.data?.connections.length ?? 0) > 0;

  if (!overview.data) return null;
  if (!synced) {
    return (
      <p className="mb-6 flex items-center gap-2 text-[13px] text-ink-3">
        <CalendarDays aria-hidden size={14} />
        {hasGoogle ? "Turn on your calendar in " : "Connect your Google account in "}
        <Button className="h-auto p-0 text-[13px]" href="/connectors" size="sm" variant="ghost">
          Connectors
        </Button>
        to see your next calls here and have Ravi record them.
      </p>
    );
  }
  const list = (events.data ?? []).filter((event) => event.meetingCode).slice(0, SHOWN);
  return (
    <Panel as="section" className="mb-6 p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="text-[15px] font-semibold text-ink">Next on your calendar</h2>
        <span className="text-xs text-ink-3">Only you see this list.</span>
      </div>
      {events.isError ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3">{describeError(events.error)}</p>
      ) : events.isPending ? null : list.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3">No Google Meet calls in the next 7 days.</p>
      ) : (
        <List className="rounded-none border-x-0 border-b-0" label="Next calls on your calendar">
          {list.map((event) => (
            <UpcomingRow event={event} key={event.id} projectId={projectId} />
          ))}
        </List>
      )}
    </Panel>
  );
}

function UpcomingRow({ event, projectId }: { event: CalendarEvent; projectId: string }) {
  const { projects } = useWorkspace();
  const decide = useCalendarDecision();
  const toast = useToast();
  const state = eventRecordState(event);
  const guests = guestsLine(event);
  const busy = decide.isPending;
  const run = (decision: "record" | "skip" | null, done: string) =>
    decide.mutate(
      { eventId: event.id, decision, ...(decision === "record" ? { projectId } : {}) },
      { onError: (error) => toast.show(describeError(error), "err"), onSuccess: () => toast.show(done) },
    );
  const recording = event.recording;
  const href = recording
    ? recording.projectId && projects.some((project) => project.id === recording.projectId)
      ? `/p/${recording.projectId}/meetings/${recording.meetingId}`
      : sharedMeetingHref(recording.meetingId)
    : undefined;

  return (
    <ListRow
      actions={
        <span className="flex items-center gap-1">
          {state.canRecord ? (
            <Button disabled={busy} onClick={() => run("record", "Ravi will join this call.")} size="sm" variant="secondary">
              Record
            </Button>
          ) : null}
          {state.canSkip ? (
            <Button disabled={busy} onClick={() => run("skip", "Ravi won't join this call.")} size="sm" variant="ghost">
              Don&apos;t record
            </Button>
          ) : null}
          {state.canClear ? (
            <Button disabled={busy} onClick={() => run(null, "Back to your calendar's setting.")} size="sm" variant="ghost">
              Undo
            </Button>
          ) : null}
        </span>
      }
      description={[eventWhen(event.startAt), guests, event.hasBriefing ? "Briefing ready" : null].filter(Boolean).join(" · ")}
      href={href}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{event.title || "Untitled meeting"}</span>
          <Badge dot tone={state.tone}>
            {state.label}
          </Badge>
        </span>
      }
    />
  );
}
