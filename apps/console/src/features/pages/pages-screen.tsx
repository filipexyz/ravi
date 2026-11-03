"use client";

import Link from "@/ui/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowUpRight, FileText, Globe2, Plus, Search, Settings, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { useOrgRouter } from "@/lib/org-href";
import type { PageSiteSummary, Project, PublishedPageSummary } from "@/features/console/types";
import { findProject, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Button, IconButton } from "@/ui/button";
import { CodeBlock, CopyButton } from "@/ui/copy";
import { FormMessage, Input, Select } from "@/ui/form";
import { PageHeader } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, Notice, Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { usePublishedPages, useSites, useTurnOnPages } from "./data";
import {
  VISIBILITY_LABEL,
  agentPrompt,
  cappedByHost,
  matchesShow,
  orderPages,
  orderSites,
  pageOpenHref,
  pageUrl,
  parseShow,
  searchPages,
  showOptions,
  type ShowFilter,
} from "./model";
import { CommentsChip, VisibilityBadge } from "./parts";
import { pageHref, pagesHref, pagesSettingsHref, rememberListHref } from "./paths";
import { PagePreview, previewDescription, previewState, useAutoThumbnails } from "./preview";
import { ProjectAccessRequests, useCanShare } from "./sharing";

const NOT_FOUND = new ApiError(404, "not_found", "not_found");
/** From this many pages on, the list gets search and a filter. */
const TOOLBAR_FROM = 7;

/**
 * The project's pages, newest first, each with its preview, who can open it
 * and a link to its own screen. Host settings (sharing all pages, custom
 * domains, history) have their own screen.
 */
export function PagesScreen({ projectId, siteId }: { projectId: string; siteId?: string }) {
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
  return <PagesList project={project} siteId={siteId} />;
}

function PagesList({ project, siteId }: { project: Project; siteId?: string }) {
  const { organization } = useWorkspace();
  const role = roleLabel(organization.role);
  const sitesQuery = useSites(project.id);
  const pagesQuery = usePublishedPages(project.id);
  const sites = useMemo(() => orderSites(sitesQuery.data ?? []), [sitesQuery.data]);
  const pages = useMemo(() => orderPages(pagesQuery.data ?? []), [pagesQuery.data]);
  const primary = sites[0];
  const scopedSite = siteId ? sites.find((site) => site.id === siteId || site.slug === siteId) : undefined;
  const { canShare, canWrite } = useCanShare(project.id, primary?.id ?? null);
  // Wait for both: a `?path=` from an older host must not match the default host's page first.
  const legacyMiss = useLegacyPageLinks(project.id, pagesQuery.data && sitesQuery.data ? pages : undefined, scopedSite);

  const actions = primary ? (
    <>
      {canWrite && pages.length > 0 ? <NewPageButton project={project} /> : null}
      <Button href={pagesSettingsHref(project.id, (scopedSite ?? primary).id)} icon={Settings}>
        Pages settings
      </Button>
    </>
  ) : null;
  const header = <PageHeader actions={actions} className="flex-row flex-wrap items-start justify-between" title="Pages" />;

  if (sitesQuery.isPending || (sitesQuery.data?.length && pagesQuery.isPending)) {
    return (
      <>
        {header}
        <GridSkeleton />
      </>
    );
  }
  if (sitesQuery.isError) {
    return (
      <>
        {header}
        <ErrorState error={sitesQuery.error} onRetry={() => sitesQuery.refetch()} role={role} />
      </>
    );
  }
  if (!primary) {
    return (
      <>
        {header}
        <TurnOnPages canWrite={canWrite} project={project} />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-y-8">
        {legacyMiss ? (
          <Notice title="This page is no longer published">The link pointed to a page that this project doesn&apos;t serve anymore.</Notice>
        ) : null}
        <ProjectAccessRequests canShare={canShare} pages={pages} projectId={project.id} sites={sites} />
        {pagesQuery.isError ? (
          <ErrorState error={pagesQuery.error} onRetry={() => pagesQuery.refetch()} role={role} />
        ) : pages.length === 0 ? (
          <NoPages canWrite={canWrite} project={project} />
        ) : (
          <PageBrowser
            canWrite={canWrite}
            defaultShow={scopedSite && !scopedSite.isDefault ? `host:${scopedSite.id}` : "all"}
            pages={pages}
            primary={primary}
            projectId={project.id}
            siteId={siteId}
            sites={sites}
          />
        )}
      </div>
    </>
  );
}

/**
 * Links from before pages had their own screen: `?page=<route>` (the old
 * drawer) and `?path=/x` (the top bar's Console link, once it sends the path)
 * open that page. Returns whether the link named a page that is gone.
 */
function useLegacyPageLinks(projectId: string, pages: PublishedPageSummary[] | undefined, scopedSite: PageSiteSummary | undefined) {
  const router = useOrgRouter();
  const searchParams = useSearchParams();
  const pageRef = searchParams.get("page");
  const path = searchParams.get("path");
  const target = useMemo(() => {
    if (!pages || (!pageRef && !path)) return undefined;
    if (pageRef) return pages.find((page) => page.routeId === pageRef || page.id === pageRef) ?? null;
    const wanted = `/${(path ?? "").replace(/^\/+/, "")}`.replace(/(.)\/+$/, "$1");
    return pages.find((page) => page.path === wanted && (!scopedSite || page.siteId === scopedSite.id)) ?? null;
  }, [pageRef, pages, path, scopedSite]);

  useEffect(() => {
    if (target) router.replace(pageHref(projectId, target));
  }, [projectId, router, target]);

  return target === null;
}

function PageBrowser({
  canWrite,
  defaultShow,
  pages,
  primary,
  projectId,
  siteId,
  sites,
}: {
  canWrite: boolean;
  defaultShow: ShowFilter;
  pages: PublishedPageSummary[];
  primary: PageSiteSummary;
  projectId: string;
  siteId?: string;
  sites: PageSiteSummary[];
}) {
  const router = useOrgRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const headingId = useId();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const options = useMemo(() => showOptions(pages, sites), [pages, sites]);
  // An older host with no pages left has no choice of its own: fall back to all pages.
  const baseShow = options.some((option) => option.value === defaultShow) ? defaultShow : "all";
  const show = searchParams.has("show") ? parseShow(searchParams.get("show"), options) : baseShow;
  const toolbar = pages.length >= TOOLBAR_FROM;

  // The filter always applies (a host's own link, the overview's new-comments link); search only with the toolbar.
  const visible = useMemo(
    () => searchPages(pages.filter((page) => matchesShow(page, show)), toolbar ? query : ""),
    [pages, query, show, toolbar],
  );

  // Back and Forward bring their own search back into the box.
  useEffect(() => {
    const restore = () => setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useAutoThumbnails(projectId, visible, canWrite);

  // Search stays in the URL without a navigation, so Back leaves the list instead of undoing keystrokes.
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (query.trim()) params.set("q", query.trim());
      else params.delete("q");
      const next = params.toString();
      if (next !== window.location.search.replace(/^\?/, "")) {
        // `null`, not the router's state: Next then keeps its own URL (and useSearchParams) in step.
        window.history.replaceState(null, "", next ? `${pathname}?${next}` : pathname);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [pathname, query]);

  // The page screen's Back link returns to this list as it was left.
  useEffect(() => {
    const params = new URLSearchParams();
    if (show !== baseShow) params.set("show", show);
    if (query.trim()) params.set("q", query.trim());
    const base = siteId ? `${pagesHref(projectId)}/${encodeURIComponent(siteId)}` : pagesHref(projectId);
    rememberListHref(params.size ? `${base}?${params.toString()}` : base);
  }, [baseShow, projectId, query, show, siteId]);

  const setShow = (value: ShowFilter) => {
    const params = new URLSearchParams(window.location.search);
    if (value === baseShow) params.delete("show");
    else params.set("show", value);
    const next = params.toString();
    // With `null` Next copies its state into the entry and updates useSearchParams; its own state would be ignored.
    window.history.pushState(null, "", next ? `${pathname}?${next}` : pathname);
  };

  const filtering = toolbar && (query.trim() !== "" || show !== "all");
  const countText = useDebounced(filtering ? `${visible.length} of ${pages.length} pages` : "", 500);
  const showHost = sites.length > 1;
  const showLabel = options.find((option) => option.value === show)?.label;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 className="sr-only" id={headingId}>
        Published pages
      </h2>
      {!toolbar && show !== "all" && showLabel ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
          <span>
            {showLabel} · {visible.length} of {pages.length} pages
          </span>
          <button
            className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
            onClick={() => setShow("all")}
            type="button"
          >
            Show all pages
          </button>
        </p>
      ) : null}
      {toolbar ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <label className="sr-only" htmlFor={searchId}>
              Search pages
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={15} />
            <Input
              autoComplete="off"
              className="pr-9 pl-9"
              enterKeyHint="search"
              id={searchId}
              inputMode="search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visible.length === 1 && visible[0]) {
                  event.preventDefault();
                  router.push(pageHref(projectId, visible[0]));
                }
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search or paste a link"
              ref={searchRef}
              spellCheck={false}
              type="text"
              value={query}
            />
            {query ? (
              <IconButton
                className="absolute top-1/2 right-0.5 -translate-y-1/2"
                icon={X}
                label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                size="sm"
              />
            ) : null}
          </div>
          <label className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
            <span className="shrink-0">Show</span>
            {/* Sized to its options, so a host's name isn't cut off. */}
            <Select
              className="min-w-0 flex-1 sm:w-auto sm:max-w-sm sm:flex-none"
              onChange={(event) => setShow(event.target.value as ShowFilter)}
              value={show}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </Select>
          </label>
          <p aria-live="polite" className="text-[13px] text-ink-3 sm:ml-auto" role="status">
            {countText}
          </p>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-4 py-8 text-center">
          <p className="text-sm text-ink-2">No pages match.</p>
          <Button
            className="mt-3"
            onClick={() => {
              setQuery("");
              setShow("all");
              searchRef.current?.focus();
            }}
            size="sm"
          >
            Show all pages
          </Button>
        </div>
      ) : (
        <ul
          aria-label={`${visible.length} ${visible.length === 1 ? "page" : "pages"}`}
          className={cn(
            "divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface",
            "sm:grid sm:grid-cols-2 sm:gap-4 sm:divide-y-0 sm:overflow-visible sm:rounded-none sm:border-0 sm:bg-transparent lg:grid-cols-3",
          )}
        >
          {visible.map((page) => (
            <PageCard key={page.id} page={page} primary={primary} projectId={projectId} showHost={showHost} />
          ))}
        </ul>
      )}
    </section>
  );
}

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

/** What a screen reader hears after the title: where it is, who can open it, and anything that needs attention. */
function cardDescription(page: PublishedPageSummary, location: string) {
  const visibility = VISIBILITY_LABEL[page.effectiveVisibility];
  const parts = [location, cappedByHost(page) ? `${visibility}, set to Public but limited by the host default.` : `${visibility}.`];
  if (page.comments.hasUnread) {
    parts.push(`${page.comments.unreadCount} new ${page.comments.unreadCount === 1 ? "comment" : "comments"}.`);
  } else if (page.comments.openCount) {
    parts.push(`${page.comments.openCount} ${page.comments.openCount === 1 ? "comment" : "comments"}.`);
  }
  const preview = previewDescription(previewState(page.thumbnail));
  if (preview) parts.push(preview);
  return parts.join(" ");
}

/**
 * One page: the whole card opens its screen; Copy (the plain link to send)
 * and Open (through the Console sign-in) stay separate.
 */
function PageCard({
  page,
  primary,
  projectId,
  showHost,
}: {
  page: PublishedPageSummary;
  primary: PageSiteSummary;
  projectId: string;
  showHost: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const url = pageUrl(page);
  const location = showHost && page.siteId !== primary.id ? `${page.defaultHostname}${page.path}` : page.path;

  return (
    <li className="sm:flex">
      <article
        aria-labelledby={titleId}
        className={cn(
          "group relative flex w-full items-start gap-3 px-4 py-3 transition-colors hover:bg-hover",
          "sm:flex-col sm:items-stretch sm:gap-0 sm:overflow-hidden sm:rounded-lg sm:border sm:border-line sm:bg-surface sm:p-0 sm:hover:border-line-strong sm:hover:bg-surface",
        )}
        data-route-id={page.routeId}
        data-site-id={page.siteId}
        data-thumbnail-state={previewState(page.thumbnail)}
        data-visibility={page.effectiveVisibility}
      >
        <PagePreview className="mt-0.5 sm:hidden" page={page} size="row" />
        <PagePreview className="hidden rounded-none border-b border-line sm:block" page={page} size="card" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:p-3">
          <h3 className="truncate text-sm font-medium text-ink sm:line-clamp-2 sm:whitespace-normal" id={titleId}>
            <Link
              aria-describedby={descriptionId}
              className="rv-card-link after:absolute after:inset-0 after:content-[''] sm:after:rounded-lg"
              href={pageHref(projectId, page)}
            >
              {page.title}
            </Link>
          </h3>
          <p className="truncate font-mono text-xs text-ink-3">{location}</p>
          <p className="truncate text-[13px] text-ink-3">
            Published <RelativeTime value={page.published.at} />
          </p>
          <div className="mt-1.5 flex min-h-8 items-center gap-2">
            <VisibilityBadge visibility={page.effectiveVisibility} />
            {cappedByHost(page) ? <span className="min-w-0 truncate text-[13px] text-ink-3">host default</span> : null}
            <CommentsChip comments={page.comments} />
            <span className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5">
              <CopyButton label={`Copy link to ${page.title}`} value={url} />
              <Button aria-label={`Open ${page.title}`} external href={pageOpenHref(url)} size="sm" target="_blank" variant="ghost">
                <ArrowUpRight aria-hidden size={15} />
              </Button>
            </span>
          </div>
        </div>
        {/* Hidden, not sr-only: read with the link, not again after Copy and Open. */}
        <span hidden id={descriptionId}>
          {cardDescription(page, location)}
        </span>
      </article>
    </li>
  );
}

function GridSkeleton() {
  return (
    <div aria-busy aria-label="Loading pages" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="overflow-hidden rounded-lg border border-line bg-surface" key={index}>
          <Skeleton className="hidden aspect-[16/10] w-full rounded-none sm:block" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** How to add a page once there are some: the same request the empty list shows. Publishing stays with agents. */
function NewPageButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={Plus} onClick={() => setOpen(true)}>
        New page
      </Button>
      <Dialog
        description="Ask an agent to publish it. Pages start private."
        onClose={() => setOpen(false)}
        open={open}
        title="New page"
      >
        <CodeBlock className="[&_pre]:font-sans [&_pre]:text-sm" code={agentPrompt(project)} copyLabel="Copy request" />
      </Dialog>
    </>
  );
}

function NoPages({ canWrite, project }: { canWrite: boolean; project: Project }) {
  return (
    <EmptyState
      description={canWrite ? "Ask an agent to publish one. Pages start private." : "Nothing is published here yet."}
      headingLevel={2}
      icon={FileText}
      title="No pages yet"
    >
      {canWrite ? <CodeBlock className="[&_pre]:font-sans [&_pre]:text-sm" code={agentPrompt(project)} copyLabel="Copy request" /> : null}
    </EmptyState>
  );
}

function TurnOnPages({ canWrite, project }: { canWrite: boolean; project: Project }) {
  const { organization } = useWorkspace();
  const turnOn = useTurnOnPages(project.id);
  const slug = `${organization.slug}-${project.slug}`;
  const slugError = turnOn.error instanceof ApiError ? turnOn.error.fieldErrors?.slug : undefined;

  return (
    <EmptyState
      action={
        canWrite ? (
          <Button icon={Globe2} loading={turnOn.isPending} onClick={() => turnOn.mutate(slug)} variant="primary">
            Turn on Pages
          </Button>
        ) : null
      }
      description={
        <>
          This project&apos;s pages will open at <span className="font-mono text-[13px] text-ink">{slug}.ravi.page</span>.
          {canWrite ? null : " Someone who can publish to this project can turn it on."}
        </>
      }
      headingLevel={2}
      icon={Globe2}
      title="Pages is off"
    >
      {turnOn.isError ? <FormMessage>{slugError ?? describeError(turnOn.error)}</FormMessage> : null}
    </EmptyState>
  );
}
