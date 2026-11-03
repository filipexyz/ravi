"use client";

import Link from "@/ui/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/client";
import type { PageSiteSummary, Project, PublishedPageSummary } from "@/features/console/types";
import { findProject, roleCapabilities, roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import type { PageHistoryChange, PageHistoryEntry } from "@/server/console/pages/history";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock, CopyButton } from "@/ui/copy";
import { PageHeader, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton, Notice, Skeleton } from "@/ui/states";
import { RelativeTime, formatDate } from "@/ui/time";
import { AdvancedSection } from "./advanced";
import { CustomDomainsSection } from "./custom-domains";
import { useDomains, usePageHistory, usePublishedPages, useSites } from "./data";
import { VISIBILITY_LABEL, hostDefaultCommand, hostDefaultSentence, hostUrl, orderSites } from "./model";
import { Collapsible, VisibilityBadge, useArrivalFocus, useRevealFocus } from "./parts";
import { pagesHref, pagesSettingsHref, useBackHref } from "./paths";
import { SiteAccessSection, useCanShare } from "./sharing";

const NOT_FOUND = new ApiError(404, "not_found", "not_found");
/** Changes listed under one release before "and N more". */
const CHANGES_SHOWN = 3;
/** Releases listed before "Show all". */
const RELEASES_SHOWN = 10;

/**
 * One host's settings: who can open the pages set to Public on it, people
 * given its pages by email, custom domains, its release history and
 * developer settings.
 */
export function PagesSettingsScreen({ projectId, siteId }: { projectId: string; siteId: string }) {
  const { projects } = useWorkspace();
  const project = findProject(projects, projectId);
  if (!project) {
    return (
      <>
        <PageHeader title="Pages settings" />
        <ErrorState error={NOT_FOUND} title="This project doesn't exist or you don't have access" />
      </>
    );
  }
  return <HostSettings project={project} siteId={siteId} />;
}

function HostSettings({ project, siteId }: { project: Project; siteId: string }) {
  const { organization } = useWorkspace();
  const customDomainsOn = useFeature("console.pages.custom_domains");
  const sitesQuery = useSites(project.id);
  const pagesQuery = usePublishedPages(project.id);
  const sites = useMemo(() => orderSites(sitesQuery.data ?? []), [sitesQuery.data]);
  const site = sites.find((item) => item.id === siteId || item.slug === siteId);
  const primary = sites[0];
  const domains = useDomains(project.id, customDomainsOn && Boolean(site));
  const { canWrite } = useCanShare(project.id, site?.id ?? null);
  const backHref = useBackHref(project.id);
  // Links such as Domains → `settings#domains` land on their section once the host has loaded.
  useArrivalFocus(site?.id ?? null);

  useEffect(() => {
    const previous = document.title;
    document.title = `Pages settings · ${project.name}`;
    return () => {
      document.title = previous;
    };
  }, [project.name]);

  const back = (
    <Link className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink" href={backHref}>
      <ArrowLeft aria-hidden size={15} />
      Pages
    </Link>
  );

  if (sitesQuery.isPending) {
    return (
      <>
        {back}
        <PageHeader title="Pages settings">
          <Skeleton className="h-4 w-64" />
        </PageHeader>
        <ListSkeleton rows={3} />
      </>
    );
  }
  if (sitesQuery.isError) {
    return (
      <>
        {back}
        <PageHeader title="Pages settings" />
        <ErrorState error={sitesQuery.error} onRetry={() => sitesQuery.refetch()} role={roleLabel(organization.role)} />
      </>
    );
  }
  if (!site || !primary) {
    return (
      <>
        {back}
        <PageHeader title="Pages settings" />
        <EmptyState
          action={
            <Button href={pagesHref(project.id)} variant="primary">
              See all pages
            </Button>
          }
          description="It may have been removed from this project."
          headingLevel={2}
          title="This host isn't in this project"
        />
      </>
    );
  }

  const pages = (pagesQuery.data ?? []).filter((page) => page.siteId === site.id);
  const hostnameForSite = (id: string) => sites.find((item) => item.id === id)?.defaultHostname ?? null;
  const others = sites.filter((item) => item.id !== site.id);

  return (
    <>
      {back}
      <PageHeader title="Pages settings">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono text-[13px] text-ink-2">{site.defaultHostname}</span>
          <CopyButton label="Copy host address" value={hostUrl(site.defaultHostname)} />
        </div>
        {canWrite ? null : <p className="text-sm text-ink-3">Only people who can publish to this project change these settings.</p>}
      </PageHeader>

      <div className="space-y-10">
        {site.isDefault ? null : (
          <Notice>
            Older host. New pages go to <span className="font-mono text-[13px] text-ink">{primary.defaultHostname}</span>.
          </Notice>
        )}

        <HostDefault canWrite={canWrite} projectSlug={project.slug} site={site} />
        <SiteAccessSection pages={pages} projectId={project.id} site={site} />
        {customDomainsOn ? (
          <CustomDomainsSection
            // Domain changes need an organization owner, admin or developer, whatever the project role.
            canWrite={roleCapabilities(organization.role).canWriteProjects}
            domains={domains}
            hostnameForSite={hostnameForSite}
            projectId={project.id}
            site={site}
          />
        ) : null}

        <div className="space-y-6">
          <Collapsible count={site.releaseCount || undefined} id="history" title="History">
            <HostHistory canWrite={canWrite} pages={pages} projectId={project.id} siteId={site.id} />
          </Collapsible>
          <AdvancedSection canWrite={canWrite} projectId={project.id} site={site} />
          {others.length ? <OtherHosts pages={pagesQuery.data ?? []} projectId={project.id} sites={others} /> : null}
        </div>
      </div>
    </>
  );
}

/** The host default as one fact. Changing it is a CLI command today, behind a disclosure for people who can. */
function HostDefault({ canWrite, projectSlug, site }: { canWrite: boolean; projectSlug: string; site: PageSiteSummary }) {
  const opposite = site.defaultVisibility === "public" ? "private" : "public";
  return (
    <Section className="scroll-mt-24" id="default" title="Host default">
      <div className="space-y-2">
        <VisibilityBadge visibility={site.defaultVisibility} />
        <p className="max-w-2xl text-sm text-ink-2">{hostDefaultSentence(site.defaultVisibility)}</p>
        {canWrite ? (
          <details className="group max-w-2xl">
            <summary className="cursor-pointer text-sm text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
              How to change
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-sm text-ink-2">Run this to make it {VISIBILITY_LABEL[opposite]}:</p>
              <CodeBlock code={hostDefaultCommand({ hostSlug: site.slug, projectSlug, visibility: opposite })} />
            </div>
          </details>
        ) : null}
      </div>
    </Section>
  );
}

function changeLabel(change: PageHistoryChange) {
  switch (change.kind) {
    case "added":
      return `Published ${change.title}`;
    case "updated":
      return `Updated ${change.title}`;
    case "removed":
      return `Removed ${change.path}`;
    case "visibility":
      return `${change.title} set to ${VISIBILITY_LABEL[change.to]}`;
  }
}

/** The host's releases, newest first, with what each changed. Release numbers match the top bar's restore list. */
function HostHistory({
  canWrite,
  pages,
  projectId,
  siteId,
}: {
  canWrite: boolean;
  pages: PublishedPageSummary[];
  projectId: string;
  siteId: string;
}) {
  const { organization } = useWorkspace();
  const history = usePageHistory(projectId, siteId, null, true);
  const [expanded, setExpanded] = useState(false);
  const { containerRef, reveal } = useRevealFocus<HTMLOListElement>(expanded, RELEASES_SHOWN);
  if (history.isPending) return <ListSkeleton rows={3} />;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => history.refetch()} role={roleLabel(organization.role)} />;
  const { entries, truncated } = history.data;
  if (entries.length === 0) return <p className="text-sm text-ink-3">Nothing published yet.</p>;
  const titleFor = (change: PageHistoryChange) => pages.find((page) => page.routeId === change.routeId)?.title ?? change.title;
  const shown = expanded ? entries : entries.slice(0, RELEASES_SHOWN);
  return (
    <div className="space-y-2">
      {canWrite ? (
        <p className="text-[13px] text-ink-2">
          Restore a release from any page&apos;s top bar (Mais opções, then Histórico de releases). A restore brings back every
          page on this host as it was.
        </p>
      ) : null}
      <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface" ref={containerRef}>
        {shown.map((entry) => (
          <HistoryRow entry={entry} key={entry.id} titleFor={titleFor} />
        ))}
      </ol>
      {entries.length > shown.length ? (
        <Button
          onClick={() => {
            reveal();
            setExpanded(true);
          }}
          size="sm"
          variant="ghost"
        >
          Show {entries.length - shown.length} more
        </Button>
      ) : expanded && truncated ? (
        <p className="text-[13px] text-ink-3">The {entries.length} most recent releases.</p>
      ) : null}
    </div>
  );
}

function HistoryRow({ entry, titleFor }: { entry: PageHistoryEntry; titleFor: (change: PageHistoryChange) => string }) {
  const changes = entry.changes.map((change) => ({
    key: `${change.routeId}:${change.kind}`,
    label: changeLabel({ ...change, title: titleFor(change) }),
  }));
  const shown = changes.slice(0, CHANGES_SHOWN);
  const more = changes.length - shown.length;
  return (
    <li className="px-4 py-3 outline-none" data-reveal-item="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
        <span className="font-mono text-ink-2">r{entry.number}</span>
        {entry.live ? <Badge tone="info">Live</Badge> : null}
        <span title={formatDate(entry.createdAt, true)}>
          <RelativeTime value={entry.createdAt} />
          {entry.by.name ? ` by ${entry.by.name}` : null}
        </span>
      </div>
      <ul className="mt-1 space-y-0.5 text-sm text-ink">
        {shown.length ? shown.map((change) => <li key={change.key}>{change.label}</li>) : <li className="text-ink-3">No page changed</li>}
        {more > 0 ? <li className="text-ink-3">and {more} more</li> : null}
      </ul>
    </li>
  );
}

function OtherHosts({ pages, projectId, sites }: { pages: PublishedPageSummary[]; projectId: string; sites: PageSiteSummary[] }) {
  return (
    <section className="space-y-3 border-t border-line pt-4">
      <h2 className="text-[15px] font-semibold text-ink">Other hosts</h2>
      <List label="Other hosts">
        {sites.map((site) => {
          const count = pages.filter((page) => page.siteId === site.id).length;
          return (
            <ListRow
              description={site.isDefault ? "Where new pages go" : `${count} ${count === 1 ? "page" : "pages"}`}
              href={pagesSettingsHref(projectId, site.id)}
              key={site.id}
              chevron
              title={<span className="font-mono text-[13px]">{site.defaultHostname}</span>}
            />
          );
        })}
      </List>
    </section>
  );
}
