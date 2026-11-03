"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquareDashed } from "lucide-react";

import { api, isNotFound } from "@/lib/api/client";
import type { BugReportDetail } from "@/features/console/types";
import { roleLabel, useFeature, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { DetailList, PageHeader, Panel, Section } from "@/ui/layout";
import { ErrorState, NoAccess, Skeleton } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { BugCommentThread, BugDossierBlocks } from "./bug-dossier-blocks";
import { BUG_PRIORITY, bugSeverity, bugStatus, surfaceLabel } from "./bug-labels";
import { bugProjectName, BugStatusIcon } from "./bugs-screen";

export function BugDetailScreen({ id }: { id: string }) {
  const { organization } = useWorkspace();
  const enabled = useFeature("console.bugs");
  const orgKey = useOrgKey();
  const query = useQuery({
    enabled,
    queryFn: () => api.get<BugReportDetail>(`/api/console/bugs/${encodeURIComponent(id)}`),
    queryKey: orgKey("bugs", id),
    // A missing report won't appear on retry; show the answer right away.
    retry: (failures, error) => !isNotFound(error) && failures < 3,
  });

  const back = (
    <Button className="mb-4 -ml-2.5" href="/bugs" icon={ArrowLeft} size="sm" variant="ghost">
      My bug reports
    </Button>
  );

  if (!enabled) {
    return (
      <>
        {back}
        <NoAccess
          description="Bug reports aren't turned on for this organization."
          role={roleLabel(organization.role)}
          title="Bug reports aren't available here"
        />
      </>
    );
  }

  if (query.isPending) {
    return (
      <>
        {back}
        <DetailSkeleton />
      </>
    );
  }

  if (query.isError) {
    return (
      <>
        {back}
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          role={roleLabel(organization.role)}
          title={isNotFound(query.error) ? "This bug report doesn't exist, or it isn't yours" : undefined}
        />
      </>
    );
  }

  return (
    <>
      {back}
      <BugReportView report={query.data} />
    </>
  );
}

function BugReportView({ report }: { report: BugReportDetail }) {
  const { projects } = useWorkspace();
  const status = bugStatus(report.status);
  const severity = bugSeverity(report.severity);
  const projectName = bugProjectName(report, projects);
  const comments = [...(report.comments ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const changedStatus = report.status !== "submitted";

  return (
    <>
      <PageHeader
        description={
          <>
            Reported {formatDate(report.createdAt)}
            {projectName ? <> in {projectName}</> : null}
            {surfaceLabel(report.surface) ? <> · {surfaceLabel(report.surface)}</> : null}
          </>
        }
        title={<span className="break-words">{report.title}</span>}
      >
        <div className="flex flex-wrap gap-2 pt-1.5">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge dot tone={severity.tone}>
            {severity.label} severity
          </Badge>
        </div>
      </PageHeader>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
        <aside className="space-y-4 lg:order-2">
          <Panel padded>
            <div className="flex items-start gap-3">
              <BugStatusIcon status={report.status} />
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-ink">{status.label}</div>
                <p className="mt-0.5 text-sm text-ink-2">{status.meaning}</p>
              </div>
            </div>
            {report.statusNote ? (
              <blockquote className="mt-4 rounded-md border-l-2 border-line-strong bg-sunken px-3.5 py-2.5 text-sm whitespace-pre-wrap text-ink-2">
                <div className="mb-0.5 text-[13px] text-ink-3">Note from Ravi&apos;s team</div>
                {report.statusNote}
              </blockquote>
            ) : null}
            <ol className="mt-5 space-y-3 border-t border-line pt-4" aria-label="Status history">
              <HistoryItem label="Reported" time={report.createdAt} />
              {changedStatus ? <HistoryItem current label={status.label} time={report.statusUpdatedAt} /> : null}
            </ol>
          </Panel>

          <Panel className="px-5 py-1">
            <DetailList
              className="[&>div]:grid-cols-[104px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5"
              items={[
                { label: "Severity", value: severity.label },
                {
                  label: "Priority",
                  value: report.priority ? BUG_PRIORITY[report.priority] : <span className="text-ink-3">Not set yet</span>,
                },
                surfaceLabel(report.surface) ? { label: "Where", value: surfaceLabel(report.surface) } : null,
                projectName ? { label: "Project", value: projectName } : null,
                { label: "Last update", value: <RelativeTime value={report.updatedAt} /> },
                { label: "Report id", value: <CopyValue display={`${report.id.slice(0, 8)}…`} value={report.id} /> },
              ]}
            />
          </Panel>
        </aside>

        <div className="min-w-0 space-y-8 lg:order-1">
          <Section title="Summary">
            <Panel padded>
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-ink-2">{report.summary}</p>
            </Panel>
          </Section>

          <Section
            description="What was sent with the report. Anything that looked like a secret was removed before it was saved."
            title="What was reported"
          >
            <BugDossierBlocks headerSummary={report.summary} payload={report.payload} />
          </Section>

          <Section
            description="Details added to this report after it was filed, oldest first."
            title={comments.length ? `Updates (${comments.length})` : "Updates"}
          >
            {comments.length ? (
              <BugCommentThread comments={comments} />
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-strong bg-surface px-5 py-4">
                <MessageSquareDashed aria-hidden className="mt-0.5 shrink-0 text-ink-3" size={16} />
                <p className="text-sm text-ink-2">
                  No updates yet. Your agent can add more details with{" "}
                  <code className="font-mono text-[13px] text-ink">ravi bug comment</code>.
                </p>
              </div>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function HistoryItem({ current, label, time }: { current?: boolean; label: string; time: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-sm">
      <span className="flex items-center gap-2">
        <span aria-hidden className={current ? "size-2 rounded-full bg-ink" : "size-2 rounded-full bg-line-strong"} />
        <span className={current ? "font-medium text-ink" : "text-ink-2"}>{label}</span>
      </span>
      <span className="shrink-0 text-[13px] text-ink-3" title={formatDate(time, true)}>
        {formatDate(time, true)}
      </span>
    </li>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy aria-label="Loading" className="space-y-6" role="status">
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
