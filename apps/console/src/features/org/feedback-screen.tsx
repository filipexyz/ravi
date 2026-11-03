"use client";

import Link from "@/ui/link";
import { MessageSquareText } from "lucide-react";

import type { FeedbackItem, FeedbackSeverity, FeedbackSource } from "@/features/console/types";
import { FEEDBACK_KIND_LABELS, FeedbackForm } from "@/features/feedback/feedback-form";
import { featureEnabled, findProject, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Avatar, Badge, type Tone } from "@/ui/badge";
import { PageHeader, Panel } from "@/ui/layout";
import { EmptyState, ErrorState, ListSkeleton, NoAccess } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { actorName, lockedReason } from "./labels";
import { useFeedbackList } from "./queries";
import { useOrganizationMemberNames } from "./member-queries";

const SOURCE_TEXT: Record<FeedbackSource, string> = {
  agent: "From an agent",
  cli: "From the command line",
  console: "From the Console",
};

const SEVERITY: Partial<Record<FeedbackSeverity, { label: string; tone: Tone }>> = {
  critical: { label: "Urgent", tone: "err" },
  high: { label: "Important", tone: "warn" },
};

export function OrgFeedbackScreen() {
  const { features, organization } = useWorkspace();
  const open = featureEnabled(features, "console.feedback");

  return (
    <>
      <PageHeader
        description={
          <>
            Ideas and problems people in {organization.name} sent to the Ravi team, from the Console and from{" "}
            <span className="font-mono text-[13px] text-ink">ravi feedback</span>. Bug reports are kept separately
            {featureEnabled(features, "console.bugs") ? (
              <>
                {" "}
                in{" "}
                <Link
                  className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                  href="/bugs"
                >
                  My bug reports
                </Link>
              </>
            ) : null}
            .
          </>
        }
        title="Feedback"
      />
      {open ? (
        <FeedbackBody />
      ) : (
        <NoAccess
          description={lockedReason(features.byKey["console.feedback"], "Feedback")}
          role={roleLabel(organization.role)}
          title="You can't open Feedback"
        />
      )}
    </>
  );
}

function FeedbackBody() {
  const { organization, projects, viewer } = useWorkspace();
  const toast = useToast();
  const feedback = useFeedbackList();
  const settings = useOrganizationMemberNames();

  return (
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <Panel className="lg:sticky lg:top-24 lg:order-2" padded>
        <h2 className="mb-1 text-[15px] font-semibold text-ink">Send feedback</h2>
        <p className="mb-4 text-sm text-ink-3">It goes to the Ravi team, with the page you are on.</p>
        <FeedbackForm onSubmitted={() => toast.show("Thanks. Your feedback was sent.")} submitLabel="Send" />
      </Panel>

      <section className="min-w-0 space-y-3 lg:order-1">
        <h2 className="text-[15px] font-semibold text-ink">Recent feedback</h2>
        {feedback.isPending ? (
          <ListSkeleton rows={4} />
        ) : feedback.isError ? (
          <ErrorState
            error={feedback.error}
            onRetry={() => void feedback.refetch()}
            role={roleLabel(organization.role)}
          />
        ) : feedback.data.items.length === 0 ? (
          <EmptyState
            description="Feedback sent from the Console or with ravi feedback shows up here, newest first."
            icon={MessageSquareText}
            title="No feedback yet"
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {[...feedback.data.items]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((item) => {
                const who = actorName(item.actor, settings.data?.members, settings.data?.currentUserId);
                return (
                  <FeedbackRow
                    avatarLabel={who === "You" ? viewer.name || who : who}
                    item={item}
                    key={item.id}
                    projectName={
                      item.projectName ??
                      (item.projectId ? findProject(projects, item.projectId)?.name : undefined) ??
                      item.projectSlug ??
                      null
                    }
                    who={who}
                  />
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
}

function FeedbackRow({
  avatarLabel,
  item,
  projectName,
  who,
}: {
  avatarLabel: string;
  item: FeedbackItem;
  projectName: string | null;
  who: string;
}) {
  const severity = SEVERITY[item.severity];
  const headline = item.title?.trim() || item.message;
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <Avatar label={avatarLabel} seed={item.actor} size="sm" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{FEEDBACK_KIND_LABELS[item.kind] ?? "Other"}</Badge>
            {severity ? (
              <Badge dot tone={severity.tone}>
                {severity.label}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm font-medium break-words whitespace-pre-line text-ink">{headline}</p>
          {item.title?.trim() ? (
            <p className="line-clamp-4 text-sm break-words whitespace-pre-line text-ink-2">{item.message}</p>
          ) : null}
          <p className="text-[13px] text-ink-3">
            {who}
            {projectName ? <> · {projectName}</> : null} · {SOURCE_TEXT[item.source] ?? "From the Console"} ·{" "}
            <RelativeTime value={item.createdAt} />
          </p>
        </div>
      </div>
    </li>
  );
}
