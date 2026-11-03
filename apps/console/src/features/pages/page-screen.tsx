"use client";

import Link from "@/ui/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api/client";
import type { PageSiteSummary, Project, PublishedPageSummary } from "@/features/console/types";
import { findProject, roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { PageHistoryChange } from "@/server/console/pages/history";
import { Avatar, Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { DetailList, PageHeader, Section } from "@/ui/layout";
import { ErrorState, ListSkeleton, Skeleton } from "@/ui/states";
import { RelativeTime, formatDate } from "@/ui/time";
import { usePageHistory, usePublishedPages, useRequestThumbnails, useSites } from "./data";
import { VISIBILITY_LABEL, cappedByHost, displayUrl, orderSites, pageOpenHref, pageUrl, whoCanOpen } from "./model";
import { Collapsible, CommentsChip, VisibilityBadge, focusSectionHeading, useArrivalFocus, useRevealFocus } from "./parts";
import { pagesHref, pagesSettingsHref, useBackHref } from "./paths";
import { PagePreview, previewState, useAutoThumbnails } from "./preview";
import { PageAccessRequests, PagePeople, SharePageButton, pageGrants, useCanShare } from "./sharing";

type Comment = PublishedPageSummary["comments"]["items"][number];

const NOT_FOUND = new ApiError(404, "not_found", "not_found");
const THREADS_SHOWN = 3;

/** One published page: its preview, who can open it, its comments and its history. */
export function PageScreen({ projectId, routeId, siteId }: { projectId: string; routeId: string; siteId: string }) {
  const { projects } = useWorkspace();
  const project = findProject(projects, projectId);
  if (!project) {
    return (
      <>
        <PageHeader title="Pages" />
        <ErrorState error={NOT_FOUND} title="This project doesn't exist or you don't have access" />
      </>
    );
  }
  return <PageDetail project={project} routeId={routeId} siteId={siteId} />;
}

function PageDetail({ project, routeId, siteId }: { project: Project; routeId: string; siteId: string }) {
  const { organization } = useWorkspace();
  const sitesQuery = useSites(project.id);
  const pagesQuery = usePublishedPages(project.id);
  const sites = useMemo(() => orderSites(sitesQuery.data ?? []), [sitesQuery.data]);
  const page =
    pagesQuery.data?.find((item) => item.routeId === routeId && item.siteId === siteId) ??
    pagesQuery.data?.find((item) => item.routeId === routeId);
  const site = page ? sites.find((item) => item.id === page.siteId) : undefined;
  const backHref = useBackHref(project.id);

  useDocumentTitle(page ? `${page.title} · Pages · ${project.name}` : `Pages · ${project.name}`);

  const back = (
    <Link className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink" href={backHref}>
      <ArrowLeft aria-hidden size={15} />
      Pages
    </Link>
  );

  if (pagesQuery.isPending || sitesQuery.isPending) {
    return (
      <>
        {back}
        <div aria-busy aria-label="Loading page" className="space-y-6" role="status">
          <div className="space-y-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="aspect-[16/10] w-full max-w-2xl" />
        </div>
      </>
    );
  }
  if (pagesQuery.isError || sitesQuery.isError) {
    return (
      <>
        {back}
        <ErrorState
          error={pagesQuery.error ?? sitesQuery.error}
          onRetry={() => {
            void pagesQuery.refetch();
            void sitesQuery.refetch();
          }}
          role={roleLabel(organization.role)}
        />
      </>
    );
  }
  if (!page || !site) {
    return (
      <>
        {back}
        <PageHeader
          actions={
            <Button href={pagesHref(project.id)} variant="primary">
              See all pages
            </Button>
          }
          description="It may have been removed or moved to another path."
          title="This page is no longer published"
        />
      </>
    );
  }

  return (
    <>
      {back}
      <PageBody page={page} project={project} site={site} />
    </>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

function PageBody({ page, project, site }: { page: PublishedPageSummary; project: Project; site: PageSiteSummary }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pathname = usePathname();
  const { access, canShare, canWrite } = useCanShare(project.id, page.siteId);
  const url = pageUrl(page);
  const openHref = pageOpenHref(url);
  const sharedWith = canShare ? pageGrants(access.data?.grants, page).length : 0;
  const alsoAt = page.urls.slice(1);

  useAutoThumbnails(project.id, useMemo(() => [page], [page]), canWrite);

  useArrivalFocus(page.routeId, headingRef);

  return (
    <>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1
            className="font-display text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] text-ink outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {page.title}
          </h1>
          <div className="flex min-w-0 items-start gap-1">
            <span className="min-w-0 pt-1.5 font-mono text-[13px] break-all text-ink-2">{displayUrl(url)}</span>
            <CopyButton label="Copy link" value={url} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button external href={openHref} iconRight={ArrowUpRight} target="_blank" variant="primary">
            Open
          </Button>
          <SharePageButton page={page} projectId={project.id} />
        </div>
      </header>

      <div className="space-y-10">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <PreviewWithCaption canWrite={canWrite} page={page} projectId={project.id} openHref={openHref} />
          <div className="space-y-4">
            <DetailList
              className="-mt-3"
              items={[
                {
                  key: "who",
                  label: "Who can open",
                  value: (
                    <div className="space-y-1.5">
                      <VisibilityBadge visibility={page.effectiveVisibility} />
                      <p className="text-ink-2">
                        {cappedByHost(page) ? (
                          <>
                            Set to Public, but{" "}
                            {canWrite ? (
                              <Link className="underline decoration-line-strong underline-offset-2 hover:decoration-ink" href={pagesSettingsHref(project.id, site.id, "default")}>
                                this host&apos;s default
                              </Link>
                            ) : (
                              "this host's default"
                            )}{" "}
                            is {VISIBILITY_LABEL[site.defaultVisibility]}.{" "}
                          </>
                        ) : null}
                        {whoCanOpen(page.effectiveVisibility, sharedWith)}
                      </p>
                    </div>
                  ),
                },
                {
                  key: "published",
                  label: "Published",
                  value: (
                    <span className="text-ink-2">
                      <RelativeTime value={page.published.at} />
                      {page.published.by.name ? ` by ${page.published.by.name}` : null}
                    </span>
                  ),
                },
                {
                  key: "comments",
                  label: "Comments",
                  value:
                    page.comments.openCount > 0 ? (
                      // A router link, so Back after jumping down still returns to the screen it left.
                      <Link
                        className="inline-flex items-center gap-2 hover:underline"
                        href={`${pathname}#comments`}
                        onClick={() => focusSectionHeading(document.getElementById("comments"))}
                      >
                        <span className="text-ink-2">{page.comments.openCount} open</span>
                        {page.comments.hasUnread ? <CommentsChip comments={page.comments} /> : null}
                      </Link>
                    ) : (
                      <span className="text-ink-3">None</span>
                    ),
                },
                alsoAt.length
                  ? {
                      key: "also",
                      label: "Also at",
                      value: (
                        <ul className="space-y-1">
                          {alsoAt.map((other) => (
                            <li className="flex min-w-0 items-center gap-1" key={other}>
                              <span className="min-w-0 font-mono text-[13px] break-all text-ink-2">
                                {displayUrl(other)}
                              </span>
                              <CopyButton label={`Copy ${displayUrl(other)}`} value={other} />
                            </li>
                          ))}
                        </ul>
                      ),
                    }
                  : null,
              ]}
            />
            <p className="text-[13px] text-ink-2">
              {canWrite
                ? "Change visibility or a password, reply to comments and restore earlier versions in the page's top bar. A restore brings back every page on this host."
                : "Reply to comments in the page's top bar."}
            </p>
          </div>
        </div>

        <PageAccessRequests canShare={canShare} page={page} projectId={project.id} />
        <CommentsSection canWrite={canWrite} openHref={openHref} page={page} />
        <PagePeople page={page} projectId={project.id} />
        <Collapsible id="history" title="History">
          <PageHistoryList page={page} projectId={project.id} />
        </Collapsible>
      </div>
    </>
  );
}

/** The large preview, and a line under it only when it isn't the current look of the page. */
function PreviewWithCaption({
  canWrite,
  openHref,
  page,
  projectId,
}: {
  canWrite: boolean;
  openHref: string;
  page: PublishedPageSummary;
  projectId: string;
}) {
  const retry = useRequestThumbnails(projectId);
  const state = previewState(page.thumbnail);
  // A retry's result belongs to the preview state it answered; once the page reads differently, the caption takes over.
  const resultKey = `${state}:${page.artifactVersionId}:${page.thumbnail.attempt?.at ?? ""}`;
  const [retryAnswer, setRetryAnswer] = useState<{ key: string; text: string } | null>(null);
  const retryResult = retryAnswer?.key === resultKey ? retryAnswer.text : null;
  // The frame itself says "No preview yet" or "Making preview"; the line only adds what it can't.
  const caption =
    state === "stale"
      ? "Preview from an earlier version."
      : state === "updating"
        ? "Preview from an earlier version. A new one is on the way."
        : state === "failed"
          ? "This page couldn't be captured."
          : "";

  return (
    <div className="space-y-2">
      {/* The image opens the page for mouse users; keyboards and screen readers use the single Open button. */}
      <a aria-hidden className="block" href={openHref} rel="noreferrer" tabIndex={-1} target="_blank">
        <PagePreview page={page} size="hero" />
      </a>
      {caption || retryResult ? (
        <p aria-live="polite" className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-3">
          <span>{retryResult ?? caption}</span>
          {state === "failed" && page.thumbnail.attempt?.retryable && canWrite && !retryResult ? (
            <button
              className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink disabled:opacity-50"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(
                  { retry: true, routeIds: [page.routeId] },
                  {
                    onError: () => setRetryAnswer({ key: resultKey, text: "Couldn't start a new preview. Try again later." }),
                    onSuccess: (result) => {
                      const item = result.items.find((entry) => entry.routeId === page.routeId);
                      setRetryAnswer({
                        key: resultKey,
                        text: item?.state === "failed" ? "This page couldn't be captured. Its preview stays empty." : "Making a preview.",
                      });
                    },
                  },
                )
              }
              type="button"
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function CommentsSection({ canWrite, openHref, page }: { canWrite: boolean; openHref: string; page: PublishedPageSummary }) {
  const { comments } = page;
  const [expanded, setExpanded] = useState(false);
  const { containerRef, reveal } = useRevealFocus<HTMLUListElement>(expanded, THREADS_SHOWN);
  const threads = commentThreads(comments.items);
  const shown = expanded ? threads : threads.slice(0, THREADS_SHOWN);
  const olderOnPage = comments.openCount - comments.items.length;
  // No comments is already said in the details beside the preview.
  if (comments.openCount === 0) return null;

  return (
    <Section
      actions={
        <Button external href={openHref} iconRight={ArrowUpRight} size="sm" target="_blank" variant="ghost">
          Reply on the page
        </Button>
      }
      className="scroll-mt-24"
      id="comments"
      title={`Comments · ${comments.openCount}`}
    >
      {canWrite && comments.blockingUnreadCount > 0 ? (
        // Neither the Console nor the top bar marks comments read, so deleting them is the way out.
        <div className="max-w-2xl space-y-0.5 text-sm">
          <p className="font-medium text-warn">
            {comments.blockingUnreadCount === 1
              ? "1 new comment blocks your next publish of this page, and restores from the top bar."
              : `${comments.blockingUnreadCount} new comments block your next publish of this page, and restores from the top bar.`}
          </p>
          <p className="text-ink-2">
            Opening or replying in the top bar doesn&apos;t clear them. Once read, delete them there (Apagar comentário). Changing who
            can open the page is never blocked.
          </p>
        </div>
      ) : null}
      <ul className="space-y-4" ref={containerRef}>
        {shown.map((thread) => (
          <li className="space-y-2 outline-none" data-reveal-item="" key={thread.comment.id}>
            <CommentItem comment={thread.comment} />
            {thread.replies.length ? (
              <ul className="ml-4 space-y-2 border-l border-line pl-3">
                {thread.replies.map((reply) => (
                  <li key={reply.id}>
                    <CommentItem comment={reply} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {threads.length > shown.length ? (
        <Button
          onClick={() => {
            reveal();
            setExpanded(true);
          }}
          size="sm"
          variant="ghost"
        >
          Show all {threads.length}
        </Button>
      ) : null}
      {expanded && olderOnPage > 0 ? (
        <p className="text-[13px] text-ink-3">
          {olderOnPage} older {olderOnPage === 1 ? "comment is" : "comments are"} only in the page&apos;s top bar.
        </p>
      ) : null}
    </Section>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  const author = comment.author.displayName?.trim() || "Someone";
  return (
    <div className="flex items-start gap-2.5">
      <Avatar className="rounded-full" label={author} seed={comment.author.id ?? author} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
          <span className="font-medium text-ink">{author}</span>
          <RelativeTime className="text-ink-3" value={comment.createdAt} />
          {comment.unread ? (
            <span className="inline-flex items-center gap-1 text-warn">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              New
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-ink-2">{comment.body}</p>
      </div>
    </div>
  );
}

/** Threads newest first; each keeps its replies (and replies to replies) in order. */
function commentThreads(items: Comment[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rootOf = (item: Comment) => {
    let current = item;
    const seen = new Set<string>();
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId) as Comment;
    }
    return current;
  };
  const threads = new Map<string, { comment: Comment; replies: Comment[]; latest: number }>();
  for (const item of items) {
    const root = rootOf(item);
    const thread = threads.get(root.id) ?? { comment: root, latest: 0, replies: [] };
    if (item.id !== root.id) thread.replies.push(item);
    thread.latest = Math.max(thread.latest, Date.parse(item.createdAt) || 0);
    threads.set(root.id, thread);
  }
  return [...threads.values()].sort((a, b) => b.latest - a.latest);
}

function pageChangeLabel(change: PageHistoryChange) {
  if (change.kind === "visibility") return `Set to ${VISIBILITY_LABEL[change.to]}`;
  if (change.kind === "added") return "Published";
  if (change.kind === "updated") return "New version published";
  return "Removed";
}

/** When this page was published, given new content or another visibility, and by whom. Loads when opened. */
function PageHistoryList({ page, projectId }: { page: PublishedPageSummary; projectId: string }) {
  const { organization } = useWorkspace();
  const history = usePageHistory(projectId, page.siteId, page.routeId, true);
  if (history.isPending) return <ListSkeleton rows={2} />;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => history.refetch()} role={roleLabel(organization.role)} />;
  const { entries, liveReleaseNumber, releasesSearched, truncated } = history.data;
  const rows = entries.flatMap((entry) => entry.changes.map((change) => ({ change, entry, key: `${entry.id}:${change.kind}` })));
  // Only the host's newest releases are read; say so when the page's start may be older than that.
  const searched = `this host's last ${releasesSearched} releases`;
  if (rows.length === 0) {
    return <p className="text-sm text-ink-3">{truncated ? `No changes in ${searched}.` : "No earlier changes."}</p>;
  }
  const older = truncated && !rows.some((row) => row.change.kind === "added");
  // After a restore the page serves an older entry; mark it so the newer ones above read as not live.
  const live = liveReleaseNumber === null ? undefined : rows.find((row) => row.entry.number <= liveReleaseNumber);
  const restored = live !== undefined && live.entry.id !== rows[0]?.entry.id;
  return (
    <div className="space-y-2">
    <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map(({ change, entry, key }) => (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5" key={key}>
          <span className="min-w-0 flex-1 text-sm text-ink">{pageChangeLabel(change)}</span>
          <span className="text-[13px] text-ink-3" title={formatDate(entry.createdAt, true)}>
            <RelativeTime value={entry.createdAt} />
            {entry.by.name ? ` by ${entry.by.name}` : null}
          </span>
          {restored && key === live?.key ? <Badge tone="info">Live</Badge> : null}
        </li>
      ))}
    </ol>
    {older ? <p className="text-[13px] text-ink-3">Older changes aren&apos;t listed: only {searched} are searched.</p> : null}
    </div>
  );
}
