"use client";

import type { LucideIcon } from "lucide-react";
import { Activity, FolderCog, Globe, Table2, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Event } from "@/features/console/types";
import { RelativeTime } from "@/ui/time";
import { actorName, eventWords, type EventArea } from "./events";

const AREA_ICON: Record<EventArea, LucideIcon> = {
  bases: Table2,
  other: Activity,
  pages: Globe,
  project: FolderCog,
};

export type ActorContext = { currentUserId: string | null; names: Map<string, string> };

/** Rows of audit events: what happened in words, who did it, and when. */
export function ActivityRows({
  actors,
  events,
  subjectFor,
}: {
  actors: ActorContext;
  events: Event[];
  subjectFor?: (event: Event) => string | undefined;
}) {
  return (
    <>
      {events.map((event) => {
        const words = eventWords(event.type);
        const Icon = words.tone === "err" ? TriangleAlert : AREA_ICON[words.area];
        const subject = subjectFor?.(event);
        return (
          <li className="flex items-start gap-3 px-4 py-3" key={event.id}>
            <span
              aria-hidden
              className={cn(
                "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                words.tone === "err" ? "bg-err-soft text-err" : "bg-sunken text-ink-3",
              )}
            >
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 text-sm text-ink">
                <span className="max-w-full shrink-0">{words.text}</span>
                {subject ? (
                  <span className="min-w-0 truncate text-ink-3" title={subject}>
                    &nbsp;· {subject}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-3">
                {actorName(event.actor, actors)} · <RelativeTime value={event.t} />
              </div>
            </div>
          </li>
        );
      })}
    </>
  );
}

export function ActivityList({
  actors,
  className,
  events,
  label = "Activity",
  subjectFor,
}: {
  actors: ActorContext;
  className?: string;
  events: Event[];
  label?: string;
  subjectFor?: (event: Event) => string | undefined;
}) {
  return (
    <ul aria-label={label} className={cn("divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface", className)}>
      <ActivityRows actors={actors} events={events} subjectFor={subjectFor} />
    </ul>
  );
}

/** Names hosts and bases in event rows when the target is one of them. */
export function eventSubjectResolver(input: {
  bases?: Array<{ id: string; name: string }>;
  sites?: Array<{ id: string; defaultHostname: string }>;
}) {
  const sites = new Map((input.sites ?? []).map((site) => [site.id, site.defaultHostname]));
  const bases = new Map((input.bases ?? []).map((base) => [base.id, base.name]));
  return (event: Event) => {
    if (event.type.startsWith("page_site.")) return sites.get(event.target);
    if (event.type.startsWith("bases.base.")) return bases.get(event.target);
    return undefined;
  };
}
