"use client";

import { History } from "lucide-react";
import { createElement, useState } from "react";

import type { Event } from "@/features/console/types";
import { featureEnabled, findProject, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Select } from "@/ui/form";
import { Segmented } from "@/ui/tabs";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { eventIcon, eventText, isTechnicalEvent } from "./activity-labels";
import { actorName } from "./labels";
import { OrgArea } from "./org-area";
import { useDomainInventory, useOrgEvents } from "./queries";
import { useOrganizationMemberNames } from "./member-queries";

const PAGE_SIZE = 25;

type Subject = { mono: boolean; text: string };
const SERVER_LIMIT = 200;

export function OrgActivityScreen() {
  return (
    <OrgArea tab="audit">
      <ActivityBody />
    </OrgArea>
  );
}

function ActivityBody() {
  const { features, organization, projects } = useWorkspace();
  const [projectId, setProjectId] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [scope, setScope] = useState<"main" | "all">("main");
  const events = useOrgEvents(projectId || undefined);
  // Names for people and domains, when this role can read them.
  const settings = useOrganizationMemberNames();
  const domains = useDomainInventory({ enabled: featureEnabled(features, "console.domains") });

  const sortedProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const members = settings.data?.members;
  const currentUserId = settings.data?.currentUserId;

  const subjectFor = (event: Event): Subject | undefined => {
    if (event.type.startsWith("domain_claim.")) {
      const domain = domains.data?.claims.find((claim) => claim.id === event.target)?.domain;
      return domain ? { mono: true, text: domain } : undefined;
    }
    if (event.type.startsWith("organization_member.")) {
      const member = members?.find((item) => item.id === event.target);
      return member ? { mono: false, text: member.name || member.email } : undefined;
    }
    return undefined;
  };

  const filter = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Select
        aria-label="Project"
        className="w-full sm:w-64"
        onChange={(event) => {
          setProjectId(event.target.value);
          setVisible(PAGE_SIZE);
        }}
        value={projectId}
      >
        <option value="">All projects</option>
        {sortedProjects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
      <Segmented
        label="Which events"
        onChange={(value) => {
          setScope(value);
          setVisible(PAGE_SIZE);
        }}
        options={[
          { label: "Main activity", value: "main" },
          { label: "Every step", value: "all" },
        ]}
        value={scope}
      />
    </div>
  );

  if (events.isPending) {
    return (
      <div className="space-y-4">
        {filter}
        <ListSkeleton rows={6} />
      </div>
    );
  }
  if (events.isError) {
    return (
      <div className="space-y-4">
        {filter}
        <ErrorState error={events.error} onRetry={() => void events.refetch()} role={roleLabel(organization.role)} />
      </div>
    );
  }

  const all = events.data
    .filter((event) => scope === "all" || !isTechnicalEvent(event.type))
    .sort((a, b) => b.t - a.t);
  const shown = all.slice(0, visible);
  const groups = groupByDay(shown);
  const projectName = projectId ? findProject(projects, projectId)?.name : undefined;

  return (
    <div className="space-y-4">
      {filter}
      {all.length === 0 ? (
        <EmptyState
          description={
            events.data.length > 0
              ? "Only technical steps are recorded here so far. Choose Every step to see them."
              : projectName
                ? `Nothing has happened in ${projectName} yet, or it happened before the latest ${SERVER_LIMIT} events.`
                : "When someone publishes pages, changes a base or adds a member, it shows up here."
          }
          icon={History}
          title={projectName ? "No activity in this project" : "No activity yet"}
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section aria-label={group.label} key={group.key}>
              <h3 className="mb-2 text-[13px] font-medium text-ink-3">{group.label}</h3>
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {group.events.map((event) => (
                  <ActivityRow
                    event={event}
                    key={event.id}
                    project={event.project ? findProject(projects, event.project)?.name ?? event.project : null}
                    showProject={!projectId}
                    subject={subjectFor(event)}
                    who={actorName(event.actor, members, currentUserId)}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div className="flex flex-col items-center gap-2 pt-1">
            {all.length > visible ? (
              <Button onClick={() => setVisible((count) => count + PAGE_SIZE)}>Show more</Button>
            ) : null}
            <p className="text-[13px] text-ink-3">
              {all.length > visible
                ? `Showing ${shown.length} of ${all.length}`
                : events.data.length >= SERVER_LIMIT
                  ? `These are the latest ${SERVER_LIMIT} events.`
                  : "That's everything."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  event,
  project,
  showProject,
  subject,
  who,
}: {
  event: Event;
  project: string | null;
  showProject: boolean;
  subject?: Subject;
  who: string;
}) {
  const where = project ?? "Organization";
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-sunken text-ink-3">
        {createElement(eventIcon(event.type), { "aria-hidden": true, size: 14 })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">
          {eventText(event.type)}
          {subject ? (
            <>
              <span aria-hidden className="text-ink-3">
                {" "}
                ·{" "}
              </span>
              <span className={subject.mono ? "font-mono text-[13px] break-all text-ink-2" : "font-medium"}>
                {subject.text}
              </span>
            </>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-ink-3">
          {who}
          {showProject ? <> · {where}</> : null}
          <span className="md:hidden">
            {" "}
            · <RelativeTime value={event.t} />
          </span>
        </div>
      </div>
      <RelativeTime className="hidden shrink-0 pt-0.5 text-[13px] text-ink-3 md:block" value={event.t} />
    </li>
  );
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupByDay(events: Event[]) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups: Array<{ key: string; label: string; events: Event[] }> = [];
  for (const event of events) {
    const date = new Date(event.t);
    const key = dayKey(date);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label =
        key === dayKey(today)
          ? "Today"
          : key === dayKey(yesterday)
            ? "Yesterday"
            : new Intl.DateTimeFormat("en", {
                day: "numeric",
                month: "long",
                weekday: "long",
                year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
              }).format(date);
      group = { events: [], key, label };
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}
