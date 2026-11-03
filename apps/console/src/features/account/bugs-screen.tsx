"use client";

import { useQuery } from "@tanstack/react-query";
import { Bug } from "lucide-react";
import { useMemo, useState } from "react";

import { api } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import type { BugReportList, BugReportSummary, Project } from "@/features/console/types";
import { findProject, roleLabel, useFeature, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import { Badge, type Tone } from "@/ui/badge";
import { CodeBlock } from "@/ui/copy";
import { PageHeader } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton, NoAccess } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { RelativeTime } from "@/ui/time";
import { bugSeverity, bugStatus } from "./bug-labels";

type Filter = "all" | "open" | "closed";

const toneTile: Record<Tone, string> = {
  err: "bg-err-soft text-err",
  info: "bg-info-soft text-info",
  neutral: "bg-sunken text-ink-3",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
};

export function BugStatusIcon({ className, status }: { className?: string; status: string }) {
  const meta = bugStatus(status);
  const Icon = meta.icon;
  return (
    <span aria-hidden className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full", toneTile[meta.tone], className)}>
      <Icon size={16} />
    </span>
  );
}

/** Which project a report points at, when it is one of this organization's projects. */
export function bugProjectName(report: Pick<BugReportSummary, "projectId">, projects: Project[]) {
  return report.projectId ? (findProject(projects, report.projectId)?.name ?? null) : null;
}

export function BugsScreen() {
  const { organization, projects } = useWorkspace();
  const enabled = useFeature("console.bugs");
  const orgKey = useOrgKey();
  const [filter, setFilter] = useState<Filter>("all");
  const query = useQuery({
    enabled,
    queryFn: () => api.get<BugReportList>("/api/console/bugs"),
    queryKey: orgKey("bugs"),
  });

  const items = useMemo(
    // Latest activity first, matching the time each row shows.
    () => [...(query.data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [query.data],
  );
  const openCount = items.filter((item) => bugStatus(item.status).open).length;
  const visible = items.filter((item) =>
    filter === "all" ? true : filter === "open" ? bugStatus(item.status).open : !bugStatus(item.status).open,
  );

  const header = (
    <PageHeader
      description="Problems you or your agents reported to Ravi. Ravi's team updates each one as they work on it."
      title="My bug reports"
    />
  );

  if (!enabled) {
    return (
      <>
        {header}
        <NoAccess
          description="Bug reports aren't turned on for this organization."
          role={roleLabel(organization.role)}
          title="Bug reports aren't available here"
        />
      </>
    );
  }

  return (
    <>
      {header}
      {query.isPending ? (
        <ListSkeleton rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} role={roleLabel(organization.role)} />
      ) : items.length === 0 ? (
        <EmptyState
          description="When you or one of your agents reports a problem, it shows up here with its status, so you can follow it until it's fixed."
          icon={Bug}
          title="No bug reports yet"
        >
          <CodeBlock code="ravi bug report" label="Agents report problems with the Ravi CLI" />
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {items.length > 3 && openCount > 0 && openCount < items.length ? (
            <Segmented
              label="Show"
              onChange={setFilter}
              options={[
                { label: "All", value: "all" },
                { label: `Open (${openCount})`, value: "open" },
                { label: "Closed", value: "closed" },
              ]}
              value={filter}
            />
          ) : null}
          <List label="Bug reports">
            {visible.map((report) => (
              <BugRow key={report.id} projectName={bugProjectName(report, projects)} report={report} />
            ))}
          </List>
          {!visible.length ? (
            <p className="px-1 text-sm text-ink-3">{filter === "open" ? "Nothing open right now." : "Nothing closed yet."}</p>
          ) : null}
        </div>
      )}
    </>
  );
}

function BugRow({ projectName, report }: { projectName: string | null; report: BugReportSummary }) {
  const status = bugStatus(report.status);
  const severity = bugSeverity(report.severity);
  return (
    <ListRow
      chevron
      description={
        <>
          <span className="block whitespace-normal md:hidden">
            {status.label} · {severity.label} severity · <RelativeTime value={report.updatedAt} />
          </span>
          <span className="hidden md:inline">{report.summary}</span>
        </>
      }
      href={`/bugs/${report.id}`}
      leading={<BugStatusIcon status={report.status} />}
      meta={
        <>
          <span className="hidden w-32 truncate text-right lg:inline" title={projectName ?? undefined}>
            {projectName ?? ""}
          </span>
          <span className="flex w-20 justify-end">
            <Badge dot title="Severity" tone={severity.tone}>
              {severity.label}
            </Badge>
          </span>
          <span className="flex w-28 justify-end">
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
          <span className="w-20 text-right">
            <RelativeTime value={report.updatedAt} />
          </span>
        </>
      }
      title={report.title}
    />
  );
}
