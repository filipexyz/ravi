"use client";

import Link from "@/ui/link";
import { ArrowRight, ArrowUpRight, ChevronRight, FileText, Globe, MessageSquareDot, Rocket, Table2 } from "lucide-react";
import { useMemo } from "react";

import { isAccessError } from "@/lib/api/client";
import type { PageSiteSummary, Project, PublishedPageSummary } from "@/features/console/types";
import { roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { PageHeader, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton, Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { pageHref, pagesHref } from "@/features/pages/paths";
import { PagePreview } from "@/features/pages/preview";
import { ActivityList, eventSubjectResolver } from "./activity-list";
import { CommandBlock } from "./command-block";
import {
  defaultSite,
  openPageHref,
  pageUrl,
  useActorNames,
  useBasesQuery,
  useEventsQuery,
  usePublishedPagesQuery,
  useSitesQuery,
  type ProjectBaseSummary,
} from "./data";
import { eventWords, visibleEvents } from "./events";
import { ProjectNotFound, useRouteProject } from "./project-scope";

const RECENT_PAGES = 5;
const RECENT_EVENTS = 5;

export function ProjectOverviewScreen({ projectId }: { projectId: string }) {
  const project = useRouteProject(projectId);
  if (!project) return <ProjectNotFound />;
  return <Overview project={project} />;
}

function Overview({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const pagesOn = useFeature("console.pages");
  const basesOn = useFeature("console.bases");
  const auditOn = useFeature("console.audit");
  const sites = useSitesQuery(project.id, pagesOn);
  const pages = usePublishedPagesQuery(project.id, pagesOn);
  const bases = useBasesQuery(project.id, basesOn);
  const role = roleLabel(organization.role);

  const site = defaultSite(sites.data);
  const basesHidden = !basesOn || (bases.isError && isAccessError(bases.error));
  const pagesEmpty = pagesOn && pages.isSuccess && pages.data.length === 0;
  const basesEmpty = basesHidden || (bases.isSuccess && bases.data.length === 0);
  const fresh = pagesEmpty && basesEmpty && (!pagesOn || sites.isSuccess);

  return (
    <>
      <PageHeader description={project.description || undefined} title={project.name}>
        {pagesOn ? <HostLine loading={sites.isLoading} pages={pages.data} site={site} /> : null}
      </PageHeader>

      {fresh ? (
        <FirstPage host={site?.defaultHostname} projectSlug={project.slug} />
      ) : (
        <div className="space-y-8">
          {pagesOn && pages.data ? <CommentsCallout pages={pages.data} projectId={project.id} /> : null}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-8">
              {pagesOn ? (
                <RecentPages
                  error={pages.error}
                  host={site?.defaultHostname}
                  loading={pages.isLoading}
                  multipleHosts={new Set((pages.data ?? []).map((page) => page.siteId)).size > 1}
                  onRetry={() => void pages.refetch()}
                  pages={pages.data}
                  projectId={project.id}
                  projectSlug={project.slug}
                  role={role}
                />
              ) : null}
              {basesHidden ? null : (
                <BasesBlock
                  bases={bases.data}
                  error={bases.error}
                  loading={bases.isLoading}
                  onRetry={() => void bases.refetch()}
                  projectId={project.id}
                  role={role}
                />
              )}
            </div>
            {auditOn ? (
              <RecentActivity
                bases={bases.data}
                projectId={project.id}
                role={role}
                sites={sites.data}
              />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

/** The project's address on ravi.page, with copy and open. */
function HostLine({
  loading,
  pages,
  site,
}: {
  loading: boolean;
  pages: PublishedPageSummary[] | undefined;
  site: PageSiteSummary | undefined;
}) {
  if (loading) return <Skeleton className="mt-2 h-6 w-72 max-w-full" />;
  if (!site) return null;
  const sitePages = (pages ?? []).filter((page) => page.siteId === site.id);
  const home = sitePages.find((page) => page.path === "/");
  const latest = [...sitePages].sort((a, b) => b.published.at - a.published.at)[0];
  const target = home ?? latest;
  const url = pageUrl(site.defaultHostname, target?.path ?? "/");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
      <Globe aria-hidden className="shrink-0 text-ink-3" size={15} />
      <CopyValue className="max-w-full" value={site.defaultHostname} />
      {target ? (
        <Button
          className="-ml-2.5 sm:ml-0"
          external
          href={openPageHref(url)}
          iconRight={ArrowUpRight}
          rel="noreferrer"
          size="sm"
          target="_blank"
          title={`Open ${url}`}
          variant="ghost"
        >
          Open
        </Button>
      ) : null}
    </div>
  );
}

function CommentsCallout({ pages, projectId }: { pages: PublishedPageSummary[]; projectId: string }) {
  const waiting = pages.filter((page) => page.comments.hasUnread || page.comments.unreadCount > 0);
  if (!waiting.length) return null;
  const only = waiting.length === 1 ? waiting[0] : undefined;
  const href = only ? pageHref(projectId, only, "comments") : `${pagesHref(projectId)}?show=new-comments`;
  return (
    <Link
      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:bg-hover"
      href={href}
    >
      <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-info-soft text-info">
        <MessageSquareDot size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">
          {only ? "1 page has comments waiting" : `${waiting.length} pages have comments waiting`}
        </span>
        <span className="block truncate text-[13px] text-ink-3">
          {only ? `${only.title || only.path} · new comments block its next publish` : "New comments block the next publish of those pages"}
        </span>
      </span>
      <ChevronRight aria-hidden className="shrink-0 text-ink-3" size={16} />
    </Link>
  );
}

function shipCommand(projectSlug: string) {
  return `ravi pages ship --project ${projectSlug} --title "Home" --body "<h1>Hello</h1>"`;
}

function FirstPage({ host, projectSlug }: { host?: string; projectSlug: string }) {
  return (
    <EmptyState
      description={
        <>
          Your agents publish pages for you, or you can run this from a terminal signed in with{" "}
          <span className="whitespace-nowrap font-mono text-[13px] text-ink">ravi login</span>. It puts a home page on{" "}
          {host ? <span className="font-mono text-[13px] whitespace-nowrap text-ink">{host}</span> : "the project's address"}.
        </>
      }
      icon={Rocket}
      title="Publish your first page"
    >
      <CommandBlock command={shipCommand(projectSlug)} />
      <p className="mt-3 text-center text-[13px] text-ink-3">Once it&apos;s published, the page and its link show up here.</p>
    </EmptyState>
  );
}

function RecentPages({
  error,
  host,
  loading,
  multipleHosts,
  onRetry,
  pages,
  projectId,
  projectSlug,
  role,
}: {
  error: unknown;
  host?: string;
  loading: boolean;
  multipleHosts: boolean;
  onRetry: () => void;
  pages: PublishedPageSummary[] | undefined;
  projectId: string;
  projectSlug: string;
  role: string;
}) {
  const recent = useMemo(
    () =>
      [...(pages ?? [])]
        .sort((a, b) => b.published.at - a.published.at || a.path.localeCompare(b.path))
        .slice(0, RECENT_PAGES),
    [pages],
  );
  const total = pages?.length ?? 0;
  return (
    <Section
      actions={
        total > 0 ? (
          <Button href={pagesHref(projectId)} iconRight={ArrowRight} size="sm" variant="ghost">
            All pages
          </Button>
        ) : null
      }
      description={total > RECENT_PAGES ? `The ${RECENT_PAGES} most recent of ${total}` : undefined}
      title="Pages"
    >
      {loading ? (
        <ListSkeleton rows={3} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} role={role} title="Pages couldn't load" />
      ) : !recent.length ? (
        <EmptyState
          description={
            <>
              Publish the home page{host ? <> on <span className="font-mono text-[13px] whitespace-nowrap text-ink">{host}</span></> : null} from a
              terminal, or ask your agent to.
            </>
          }
          title="No pages yet"
        >
          <CommandBlock command={shipCommand(projectSlug)} />
        </EmptyState>
      ) : (
        <List label="Recent pages">
          {recent.map((page) => {
            const url = page.urls[0] ?? pageUrl(page.defaultHostname, page.path);
            return (
              <ListRow
                actions={
                  <Button
                    aria-label={`Open ${page.title || page.path}`}
                    className="w-8 px-0"
                    external
                    href={openPageHref(url)}
                    icon={ArrowUpRight}
                    rel="noreferrer"
                    size="sm"
                    target="_blank"
                    title={`Open ${url}`}
                    variant="ghost"
                  />
                }
                description={
                  <span className="font-mono text-[12px]">
                    {multipleHosts ? `${page.defaultHostname}${page.path}` : page.path}
                  </span>
                }
                href={pageHref(projectId, page)}
                key={page.id}
                leading={<PagePreview page={page} size="row" />}
                meta={
                  <span>
                    Published <RelativeTime value={page.published.at} />
                  </span>
                }
                title={page.title || page.path}
              />
            );
          })}
        </List>
      )}
    </Section>
  );
}

function BasesBlock({
  bases,
  error,
  loading,
  onRetry,
  projectId,
  role,
}: {
  bases: ProjectBaseSummary[] | undefined;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
  projectId: string;
  role: string;
}) {
  const active = (bases ?? []).filter((base) => base.status !== "archived");
  return (
    <Section
      actions={
        active.length ? (
          <Button href={`/p/${projectId}/bases`} iconRight={ArrowRight} size="sm" variant="ghost">
            All bases
          </Button>
        ) : null
      }
      title="Bases"
    >
      {loading ? (
        <ListSkeleton rows={2} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} role={role} title="Bases couldn't load" />
      ) : !active.length ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface px-4 py-3.5 text-sm text-ink-2">
          No bases yet. Bases are tables your agents keep for this project; they create them with{" "}
          <span className="whitespace-nowrap font-mono text-[13px] text-ink">ravi bases create</span>.
        </div>
      ) : (
        <List label="Bases">
          {active.map((base) => (
            <ListRow
              chevron
              description={[rowCount(base.rowCount), base.description].filter(Boolean).join(" · ")}
              href={`/p/${projectId}/bases/${encodeURIComponent(base.slug)}`}
              key={base.id}
              leading={<RowIcon icon={Table2} />}
              title={base.name}
            />
          ))}
        </List>
      )}
    </Section>
  );
}

function rowCount(count: number) {
  return count === 1 ? "1 row" : `${count.toLocaleString("en")} rows`;
}

function RecentActivity({
  bases,
  projectId,
  role,
  sites,
}: {
  bases: ProjectBaseSummary[] | undefined;
  projectId: string;
  role: string;
  sites: PageSiteSummary[] | undefined;
}) {
  const events = useEventsQuery(projectId);
  const actors = useActorNames(projectId);
  const recent = useMemo(
    () =>
      visibleEvents(events.data ?? [], false)
        .filter((event) => eventWords(event.type).area !== "other")
        .slice(0, RECENT_EVENTS),
    [events.data],
  );
  const subjectFor = useMemo(() => eventSubjectResolver({ bases, sites }), [bases, sites]);
  if (events.isError && isAccessError(events.error)) return null;
  return (
    <Section
      actions={
        recent.length ? (
          <Button href={`/p/${projectId}/settings/activity`} iconRight={ArrowRight} size="sm" variant="ghost">
            View all
          </Button>
        ) : null
      }
      title="Recent activity"
    >
      {events.isLoading ? (
        <ListSkeleton rows={4} />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} role={role} title="Activity couldn't load" />
      ) : !recent.length ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface px-4 py-3.5 text-sm text-ink-2">
          Nothing has happened in this project yet. Publishing a page or changing a base shows up here.
        </div>
      ) : (
        <ActivityList actors={actors} events={recent} label="Recent activity" subjectFor={subjectFor} />
      )}
    </Section>
  );
}

function RowIcon({ icon: Icon }: { icon: typeof FileText }) {
  return (
    <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
      <Icon size={15} />
    </span>
  );
}
