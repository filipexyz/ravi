"use client";

import { History } from "lucide-react";
import { useMemo, useState } from "react";

import type { Event, Project } from "@/features/console/types";
import { roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { formatDate } from "@/ui/time";
import { ActivityList, eventSubjectResolver } from "./activity-list";
import { useActorNames, useBasesQuery, useEventsQuery, useSitesQuery } from "./data";
import { eventWords, visibleEvents, type EventArea } from "./events";
import { SettingsFrame } from "./settings-frame";

/** The events endpoint returns at most this many, newest first. */
const SERVER_LIMIT = 200;
const PAGE_SIZE = 30;

type AreaFilter = "all" | Exclude<EventArea, "other">;

export function ActivityScreen({ projectId }: { projectId: string }) {
  return (
    <SettingsFrame projectRef={projectId} tab="activity">
      {(project) => <Activity project={project} />}
    </SettingsFrame>
  );
}

function Activity({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const pagesOn = useFeature("console.pages");
  const basesOn = useFeature("console.bases");
  const events = useEventsQuery(project.id);
  const sites = useSitesQuery(project.id, pagesOn);
  const bases = useBasesQuery(project.id, basesOn);
  const actors = useActorNames(project.id);
  const [area, setArea] = useState<AreaFilter>("all");
  const [technical, setTechnical] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filtered = useMemo(() => {
    const visible = visibleEvents(events.data ?? [], technical);
    return area === "all" ? visible : visible.filter((event) => eventWords(event.type).area === area);
  }, [area, events.data, technical]);
  const shown = filtered.slice(0, limit);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const subjectFor = useMemo(() => eventSubjectResolver({ bases: bases.data, sites: sites.data }), [bases.data, sites.data]);

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-2">What changed in this project and who did it, newest first.</p>
        <Segmented
          className="self-start sm:self-auto"
          label="Show"
          onChange={(value) => {
            setArea(value);
            setLimit(PAGE_SIZE);
          }}
          options={[
            { label: "All", value: "all" },
            { label: "Pages", value: "pages" },
            { label: "Bases", value: "bases" },
            { label: "Project", value: "project" },
          ]}
          value={area}
        />
      </div>

      {events.isLoading ? (
        <ListSkeleton rows={6} />
      ) : events.isError ? (
        <ErrorState
          error={events.error}
          onRetry={() => void events.refetch()}
          role={roleLabel(organization.role)}
          title="Activity couldn't load"
        />
      ) : !shown.length ? (
        <EmptyState
          description={
            area === "all"
              ? "Publishing a page, changing a base or editing the project's settings shows up here."
              : "Nothing of this kind happened recently. Choose All to see everything."
          }
          icon={History}
          title={area === "all" ? "Nothing has happened yet" : "No activity of this kind"}
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section aria-label={group.label} className="space-y-2" key={group.key}>
              <h3 className="px-1 text-[13px] font-medium text-ink-3">{group.label}</h3>
              <ActivityList actors={actors} events={group.events} label={group.label} subjectFor={subjectFor} />
            </section>
          ))}
        </div>
      )}

      {events.isSuccess ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
            <input
              checked={technical}
              className="size-4 accent-[var(--rv-ink)]"
              onChange={(event) => {
                setTechnical(event.target.checked);
                setLimit(PAGE_SIZE);
              }}
              type="checkbox"
            />
            Show technical steps, such as each upload and host update
          </label>
          {filtered.length > shown.length ? (
            <Button onClick={() => setLimit((current) => current + PAGE_SIZE)} size="sm">
              Show more
            </Button>
          ) : (events.data?.length ?? 0) >= SERVER_LIMIT && shown.length ? (
            <span className="text-[13px] text-ink-3">These are the latest {SERVER_LIMIT} events of this project.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function groupByDay(events: Event[]) {
  const groups: Array<{ events: Event[]; key: string; label: string }> = [];
  const today = startOfDay(Date.now());
  const yesterday = today - 86_400_000;
  for (const event of events) {
    const day = startOfDay(event.t);
    const key = String(day);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.events.push(event);
      continue;
    }
    const label = day === today ? "Today" : day === yesterday ? "Yesterday" : formatDate(day);
    groups.push({ events: [event], key, label });
  }
  return groups;
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
