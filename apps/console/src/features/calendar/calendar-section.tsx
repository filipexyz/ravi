"use client";

import { describeError } from "@/lib/api/client";
import { Field, FormMessage, Select, Switch } from "@/ui/form";
import { Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";

import { useCalendarOverview, useSaveCalendarSettings } from "./api";
import { BRIEFING_MINUTE_OPTIONS, RECORD_MODE_OPTIONS, recordModeHint, syncProblem } from "./model";
import type { CalendarConnection, CalendarRecordMode, CalendarSettingsInput } from "./types";

/**
 * The calendar settings of one Google connection, in its drawer: sync, whether
 * Ravi records the calls on it, where recordings go, and what the agent
 * prepares before and after. Only the connection's owner sees it.
 */
export function CalendarSection({ connectionId }: { connectionId: string }) {
  const overview = useCalendarOverview();
  const entry = overview.data?.connections.find((connection) => connection.connectionId === connectionId);

  if (overview.isPending) {
    return (
      <div aria-busy aria-label="Loading calendar" className="space-y-3 border-t border-line pt-5" role="status">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <section className="space-y-2 border-t border-line pt-5">
        <h3 className="text-sm font-semibold text-ink">Calendar</h3>
        <p className="text-[13px] text-ink-3">{describeError(overview.error)}</p>
      </section>
    );
  }
  if (!entry) return null;
  return (
    <CalendarSettingsForm
      autoRecordAllowed={overview.data.policy.autoRecordAllowed}
      entry={entry}
      meetingsEnabled={overview.data.meetingsEnabled}
      projects={overview.data.projects}
    />
  );
}

function CalendarSettingsForm({
  autoRecordAllowed,
  entry,
  meetingsEnabled,
  projects,
}: {
  autoRecordAllowed: boolean;
  entry: CalendarConnection;
  meetingsEnabled: boolean;
  projects: { id: string; name: string }[];
}) {
  const save = useSaveCalendarSettings();
  const toast = useToast();
  const { settings } = entry;
  const problem = syncProblem(entry.lastSyncError);

  const change = (patch: Omit<CalendarSettingsInput, "connectionId">, done?: string) =>
    save.mutate(
      { connectionId: entry.connectionId, ...patch },
      {
        onError: (error) => toast.show(describeError(error), "err"),
        onSuccess: () => (done ? toast.show(done) : undefined),
      },
    );

  const chooseMode = (value: string) => {
    const recordMode = value ? (value as CalendarRecordMode) : null;
    // Recording needs a project: the first one the person can write, until they pick another.
    const projectId = recordMode && recordMode !== "off" && !settings.projectId ? projects[0]?.id : undefined;
    change({ recordMode, ...(projectId ? { projectId } : {}) }, "Recording choice saved.");
  };

  return (
    <section className="space-y-4 border-t border-line pt-5">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-ink">Calendar</h3>
        <p className="text-[13px] text-ink-3">
          Ravi reads your upcoming meetings (title, time, Meet link and who is invited, never the description) to record
          them and to help you prepare.
        </p>
      </div>

      {!entry.hasCalendarScope ? (
        <p className="text-[13px] text-ink-3">This connection can&apos;t read your calendar yet. Reconnect it and allow calendar access.</p>
      ) : (
        <Switch
          checked={settings.syncEnabled}
          description={
            settings.syncEnabled ? (
              entry.lastSyncedAt ? (
                <>
                  Last checked <RelativeTime value={entry.lastSyncedAt} />. Ravi checks every few minutes.
                </>
              ) : (
                "Ravi reads your calendar in the next few minutes."
              )
            ) : (
              "Off: Ravi doesn't read this calendar."
            )
          }
          disabled={save.isPending}
          label="Use this calendar"
          onChange={(syncEnabled) => change({ syncEnabled }, syncEnabled ? "Ravi will read this calendar." : "Ravi stopped reading this calendar.")}
        />
      )}
      {settings.syncEnabled && problem ? <FormMessage>{problem}</FormMessage> : null}

      {settings.syncEnabled && meetingsEnabled ? (
        <>
          <Field hint={recordModeHint(settings.recordMode, autoRecordAllowed)} label="Record my calls">
            {(props) => (
              <Select
                {...props}
                disabled={save.isPending}
                onChange={(event) => chooseMode(event.target.value)}
                value={settings.recordMode ?? ""}
              >
                {settings.recordMode ? null : <option value="">Choose…</option>}
                {RECORD_MODE_OPTIONS.map((option) => (
                  <option disabled={option.value !== "off" && projects.length === 0} key={option.value} value={option.value}>
                    {option.label}
                    {option.value === "auto" && !autoRecordAllowed ? " (needs an admin)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {settings.recordMode && settings.recordMode !== "off" ? (
            <Field hint="Recordings of this calendar's calls go to this project." label="Save recordings in">
              {(props) => (
                <Select
                  {...props}
                  disabled={save.isPending}
                  onChange={(event) => change({ projectId: event.target.value }, "Recordings will go to that project.")}
                  value={settings.projectId ?? ""}
                >
                  {settings.projectId ? null : <option value="">Choose a project…</option>}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {projects.length === 0 ? (
            <p className="text-[13px] text-ink-3">You can&apos;t save recordings in any project yet. Ask an admin to add you to one.</p>
          ) : null}
        </>
      ) : null}

      {settings.syncEnabled ? (
        <div className="space-y-4">
          <Switch
            checked={settings.briefingEnabled === true}
            description="Your agent prepares a short briefing before each call: who is coming, what you talked about last time, and what to get out of it."
            disabled={save.isPending}
            label="Briefing before meetings"
            onChange={(briefingEnabled) => change({ briefingEnabled }, briefingEnabled ? "Briefings on." : "Briefings off.")}
          />
          {settings.briefingEnabled ? (
            <Field label="Send the briefing">
              {(props) => (
                <Select
                  {...props}
                  className="w-48"
                  disabled={save.isPending}
                  onChange={(event) => change({ briefingMinutes: Number(event.target.value) })}
                  value={String(settings.briefingMinutes)}
                >
                  {[...new Set([...BRIEFING_MINUTE_OPTIONS, settings.briefingMinutes])]
                    .sort((a, b) => a - b)
                    .map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes < 60 ? `${minutes} minutes before` : `${minutes / 60} hour${minutes === 60 ? "" : "s"} before`}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Switch
            checked={settings.followupEnabled === true}
            description="When a recording is ready, your agent sends you the decisions, the next steps and who owns each."
            disabled={save.isPending}
            label="Follow-up after recorded calls"
            onChange={(followupEnabled) => change({ followupEnabled }, followupEnabled ? "Follow-ups on." : "Follow-ups off.")}
          />
        </div>
      ) : null}
    </section>
  );
}
