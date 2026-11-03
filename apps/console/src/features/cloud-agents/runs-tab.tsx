"use client";

import { Activity } from "lucide-react";
import { useState } from "react";

import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { CloudRun } from "@/server/console/cloud-agents/types";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { RelativeTime } from "@/ui/time";

import { type RunFilter, useCloudRuns } from "./api";
import { CloudFrame, CloudProjectGate } from "./cloud-frame";
import { formatUsd, isActiveRun, runDuration, runStatus, triggerLabel } from "./format";

const FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "attention", label: "Needs attention" },
  { value: "finished", label: "Finished" },
];

const EMPTY_FILTER_TEXT: Record<Exclude<RunFilter, "all">, string> = {
  active: "No run is working or waiting right now.",
  attention: "No run waits for approval, failed or reached its budget.",
  finished: "No run has finished yet.",
};

export function CloudRunsScreen({ projectId }: { projectId: string }) {
  return (
    <CloudProjectGate projectRef={projectId}>
      {(scope) => (
        <CloudFrame scope={scope} tab="runs">
          <RunsList projectId={scope.project.id} />
        </CloudFrame>
      )}
    </CloudProjectGate>
  );
}

function RunsList({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<RunFilter>("all");
  // The cursors of the pages shown after the first, in order.
  const [cursors, setCursors] = useState<string[]>([]);

  return (
    <div className="space-y-3">
      <Segmented
        label="Show runs"
        onChange={(value) => {
          setFilter(value);
          setCursors([]);
        }}
        options={FILTERS}
        value={filter}
      />
      <RunsPage
        cursor={null}
        filter={filter}
        isLast={cursors.length === 0}
        onMore={(next) => setCursors([next])}
        projectId={projectId}
      />
      {cursors.map((cursor, index) => (
        <RunsPage
          cursor={cursor}
          filter={filter}
          isLast={index === cursors.length - 1}
          key={cursor}
          onMore={(next) => setCursors((current) => [...current.slice(0, index + 1), next])}
          projectId={projectId}
        />
      ))}
    </div>
  );
}

function RunsPage({
  cursor,
  filter,
  isLast,
  onMore,
  projectId,
}: {
  cursor: string | null;
  filter: RunFilter;
  isLast: boolean;
  onMore: (cursor: string) => void;
  projectId: string;
}) {
  const { organization } = useWorkspace();
  const runs = useCloudRuns(projectId, { filter, cursor });

  if (runs.isPending) return <ListSkeleton rows={cursor ? 2 : 4} />;
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} role={roleLabel(organization.role)} />;
  const list = runs.data.runs;
  if (list.length === 0 && !cursor) {
    return filter === "all" ? (
      <EmptyState
        action={<Button href={`/p/${projectId}/cloud`}>Go to agents</Button>}
        description="Start one from an agent's Run button, a schedule, a Page or your terminal. Each run shows up here with its cost and result."
        icon={Activity}
        title="No runs yet"
      >
        <CodeBlock code={'ravi cloud runs start <agent> "<what to do>" --execute'} label="From the terminal" />
      </EmptyState>
    ) : (
      <EmptyState description={EMPTY_FILTER_TEXT[filter]} icon={Activity} title="Nothing here" />
    );
  }

  return (
    <>
      <List label={cursor ? "More cloud runs" : "Cloud runs"}>
        {list.map((run) => (
          <RunRow key={run.id} projectId={projectId} run={run} />
        ))}
      </List>
      {isLast && runs.data.cursor ? (
        <div className="flex justify-center">
          <Button onClick={() => onMore(runs.data.cursor!)} variant="ghost">
            Show older runs
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function RunRow({ projectId, run }: { projectId: string; run: CloudRun }) {
  const status = runStatus(run.status);
  const duration = runDuration(run);
  const pending = run.approvals.filter((approval) => approval.status === "pending").length;
  return (
    <ListRow
      chevron
      description={
        <>
          <span className="md:hidden">
            {run.actor.name} · {formatUsd(run.costUsd)} ·{" "}
          </span>
          <span>{run.prompt || "No prompt"}</span>
        </>
      }
      href={`/p/${projectId}/cloud/runs/${run.id}`}
      leading={
        <span className="relative inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <Activity aria-hidden size={16} />
          {isActiveRun(run) ? (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-info ring-2 ring-surface" />
          ) : null}
        </span>
      }
      meta={
        <>
          <span>{triggerLabel(run.trigger)}</span>
          <span>{run.actor.name}</span>
          <span>{formatUsd(run.costUsd)}</span>
          {duration ? <span>{duration}</span> : null}
          <RelativeTime value={run.startedAt} />
        </>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{run.agentName}</span>
          <Badge dot={isActiveRun(run)} title={status.hint} tone={status.tone}>
            {pending > 1 ? `${pending} approvals` : status.label}
          </Badge>
        </span>
      }
    />
  );
}
