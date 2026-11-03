"use client";

import { useQueries } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ApiError, api, describeError } from "@/lib/api/client";
import type { PageSiteSummary, PublishedPageSummary } from "@/features/console/types";
import { roleCapabilities, roleLabel, useWorkspace } from "@/features/shell/workspace";
import type { AccessGrantSummary } from "@/server/console/access/grants";
import type { AccessRequestDetail } from "@/server/console/access/requests";
import { Avatar } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Field, FormMessage, Input, Select } from "@/ui/form";
import { Section } from "@/ui/layout";
import { List } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { ErrorState, ListSkeleton } from "@/ui/states";
import { RelativeTime, formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { useDecideAccessRequest, usePagesKeys, useShareAccess, useSiteAccess, useUnshareAccess } from "./data";
import { canShareVisibility, displayUrl } from "./model";
import { focusSectionHeading, useRevealFocus } from "./parts";

/** What a share covers: all pages of the host (`routeId: null`) or one page. */
export type ShareTarget = { label: string; path: string | null; routeId: string | null };

const ALL_PAGES = "site";
const REQUESTS_SHOWN = 3;
const NO_GRANTS: AccessGrantSummary[] = [];

const EXPIRY_OPTIONS = [
  { days: 0, label: "No end date" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** The access list answers 403 when the viewer can't share this project's pages. */
function cannotShare(error: unknown) {
  return error instanceof ApiError && error.status === 403;
}

function shareErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "forbidden":
        return "Only people who can publish to this project can share its pages.";
      case "site_not_found":
        return "This host no longer exists. Refresh the page and try again.";
      case "route_not_found":
        return "This page is no longer published. Refresh the page and try again.";
      case "user_inactive":
        return "This person's account is suspended, so they can't be given access.";
      case "validation_failed":
        if (error.fieldErrors?.expiresAt) return "Pick an end date within the next 365 days.";
        if (error.fieldErrors?.routeId) return "Pick a page or all pages.";
        break;
    }
  }
  return describeError(error);
}

/**
 * Whether the viewer may share this host's pages. Organization owners, admins
 * and developers always can; anyone else waits for the access list, which
 * answers 403 to people who can't. Sharing needs the publish permission, so
 * `canWrite` says the same about publishing.
 */
export function useCanShare(projectId: string, siteId: string | null) {
  const { organization } = useWorkspace();
  const access = useSiteAccess(projectId, siteId);
  const byRole = roleCapabilities(organization.role).canWriteProjects;
  const canWrite = byRole || access.isSuccess;
  return { access, canShare: Boolean(siteId) && canWrite && !cannotShare(access.error), canWrite };
}

/** Pending requests of these hosts, newest first. */
function useAccessRequests(projectId: string, siteIds: string[], enabled: boolean) {
  const keys = usePagesKeys(projectId);
  return useQueries({
    combine: (results) =>
      results
        .flatMap((result) => result.data?.requests ?? [])
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    queries: siteIds.map((siteId) => ({
      enabled,
      queryFn: () =>
        api.get<{ requests: AccessRequestDetail[] }>(`/api/console/pages/access/requests?siteId=${encodeURIComponent(siteId)}`),
      queryKey: keys.accessRequests(siteId),
      retry: false,
    })),
  });
}

/** What a request asks to open: the page's title when one matched, otherwise all pages. */
function requestedPage(request: AccessRequestDetail, pages: PublishedPageSummary[]) {
  if (!request.routeMatched) return "all pages";
  return pages.find((page) => page.siteId === request.siteId && page.path === request.path)?.title ?? request.path;
}

/**
 * People asking to open this project's pages, at the top of the list, with
 * Approve and Decline in place. Only for people who can share, and only when
 * someone is asking.
 */
export function ProjectAccessRequests({
  canShare,
  pages,
  projectId,
  sites,
}: {
  canShare: boolean;
  pages: PublishedPageSummary[];
  projectId: string;
  sites: PageSiteSummary[];
}) {
  const requests = useAccessRequests(
    projectId,
    sites.map((site) => site.id),
    canShare,
  );
  const shown = useStaysOnceShown(requests.length > 0);
  if (!canShare || !shown) return null;
  return <AccessRequestList describe={(request) => requestedPage(request, pages)} projectId={projectId} requests={requests} />;
}

/** Requests for one page, on that page's screen. */
export function PageAccessRequests({
  canShare,
  page,
  projectId,
}: {
  canShare: boolean;
  page: PublishedPageSummary;
  projectId: string;
}) {
  const requests = useAccessRequests(projectId, [page.siteId], canShare);
  const forPage = requests.filter((request) => request.routeMatched && request.path === page.path);
  const shown = useStaysOnceShown(forPage.length > 0);
  if (!canShare || !shown) return null;
  return <AccessRequestList projectId={projectId} requests={forPage} />;
}

/**
 * Whether the requests section shows: from the first request on, and still
 * after the last one is answered, so focus has somewhere to stay.
 */
function useStaysOnceShown(present: boolean) {
  const [seen, setSeen] = useState(false);
  if (present && !seen) setSeen(true);
  return present || seen;
}

function AccessRequestList({
  describe,
  projectId,
  requests,
}: {
  describe?: (request: AccessRequestDetail) => string;
  projectId: string;
  requests: AccessRequestDetail[];
}) {
  const decide = useDecideAccessRequest(projectId);
  const toast = useToast();
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const { containerRef, reveal } = useRevealFocus<HTMLElement>(expanded, REQUESTS_SHOWN);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const decided = useRef<string | null>(null);
  const shown = expanded ? requests : requests.slice(0, REQUESTS_SHOWN);
  const hidden = requests.length - shown.length;

  // Once a decided request leaves the list, keep keyboard users in it: the next request, or the heading.
  useEffect(() => {
    if (!decided.current || requests.some((request) => request.id === decided.current)) return;
    decided.current = null;
    const next = containerRef.current?.querySelector<HTMLButtonElement>("[data-approve]");
    (next ?? headingRef.current)?.focus();
  }, [containerRef, requests]);

  const act = (request: AccessRequestDetail, decision: "approve" | "deny") =>
    decide.mutate(
      { decision, id: request.id, scope: request.routeMatched ? "route" : "site", siteId: request.siteId },
      {
        onError: (error) => toast.show(describeError(error), "err"),
        onSuccess: () => {
          decided.current = request.id;
          toast.show(
            decision === "approve"
              ? `${request.requester.email} can open ${request.routeMatched ? "the page" : "all pages"} now.`
              : "Request declined.",
          );
        },
      },
    );

  return (
    <section aria-labelledby={headingId} className="space-y-2" ref={containerRef}>
      <h2 className="text-[15px] font-semibold text-ink outline-none" id={headingId} ref={headingRef} tabIndex={-1}>
        Access requests{" "}
        {requests.length ? <span className="ml-0.5 font-normal text-ink-3">{requests.length}</span> : null}
      </h2>
      {requests.length === 0 ? (
        <p className="text-sm text-ink-3" role="status">
          No more requests.
        </p>
      ) : (
        <List label="Access requests">
          {shown.map((request) => {
            const who = request.requester.name || request.requester.email;
            const busy = decide.isPending && decide.variables?.id === request.id;
            const what = describe?.(request);
            return (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-2 pl-4 outline-none"
                data-request-id={request.id}
                data-reveal-item=""
                key={request.id}
              >
                <Avatar className="rounded-full" label={who} seed={request.requester.email} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm [overflow-wrap:anywhere] text-ink">
                    <span className="font-medium">{who}</span>
                    {what ? <span className="text-ink-2"> wants to open {what}</span> : null}
                  </div>
                  <div className="truncate text-[13px] text-ink-3">
                    {request.requester.name && request.requester.name !== request.requester.email ? <>{request.requester.email} · </> : null}
                    <RelativeTime value={request.createdAt} />
                    {request.via === "cli" ? ` · through ${request.agentName ?? "an agent"}` : null}
                  </div>
                  {request.message ? <div className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">{request.message}</div> : null}
                </div>
                <div className="flex items-center gap-1.5 max-sm:basis-full max-sm:justify-end">
                  <Button aria-label={`Decline ${who}`} disabled={busy} onClick={() => act(request, "deny")} size="sm" variant="ghost">
                    Decline
                  </Button>
                  <Button
                    aria-label={`Approve ${who}`}
                    data-approve=""
                    loading={busy && decide.variables?.decision === "approve"}
                    onClick={() => act(request, "approve")}
                    size="sm"
                  >
                    Approve
                  </Button>
                </div>
              </li>
            );
          })}
        </List>
      )}
      {hidden > 0 ? (
        <Button
          onClick={() => {
            reveal();
            setExpanded(true);
          }}
          size="sm"
          variant="ghost"
        >
          Show {hidden} more
        </Button>
      ) : null}
    </section>
  );
}

/** Share for one page, as a header button with its dialog. Only on pages that need a sign-in. */
export function SharePageButton({ page, projectId }: { page: PublishedPageSummary; projectId: string }) {
  const { access, canShare } = useCanShare(projectId, page.siteId);
  const [open, setOpen] = useState(false);
  if (!canShare || !access.data || !canShareVisibility(page.effectiveVisibility)) return null;
  return (
    <>
      <Button icon={UserPlus} onClick={() => setOpen(true)}>
        Share
      </Button>
      {open ? (
        <ShareDialog
          onClose={() => setOpen(false)}
          projectId={projectId}
          siteId={page.siteId}
          targets={[{ label: page.title, path: page.path, routeId: page.routeId }]}
        />
      ) : null}
    </>
  );
}

/** Grants that let someone open this page: given this page, or all pages of its host. */
export function pageGrants(grants: AccessGrantSummary[] | undefined, page: Pick<PublishedPageSummary, "routeId">) {
  return (grants ?? []).filter((grant) => grant.scope === "site" || grant.routeId === page.routeId);
}

/**
 * People given one page by email, on its own or with all pages. Hidden until
 * someone is, and on Public and Password pages, where a share lets no one in
 * and the list would overstate who can open it.
 */
export function PagePeople({ page, projectId }: { page: PublishedPageSummary; projectId: string }) {
  const { access, canShare } = useCanShare(projectId, page.siteId);
  const [removing, setRemoving] = useState<AccessGrantSummary | null>(null);
  const grants = pageGrants(access.data?.grants, page);
  const onRemoved = useFocusAfterRemoval("people", grants, removing);
  // Stays after the last person is removed, so focus has somewhere to go.
  const shown = useStaysOnceShown(canShare && grants.length > 0);
  if (!canShare || !shown || !canShareVisibility(page.effectiveVisibility)) return null;
  return (
    <Section className="scroll-mt-24" id="people" title="People with access">
      {grants.length ? (
        <GrantList grants={grants} onRemove={setRemoving} />
      ) : (
        <p className="text-sm text-ink-3">No one outside the project.</p>
      )}
      <RemoveGrantDialog
        grant={removing}
        onClose={() => setRemoving(null)}
        onRemoved={onRemoved}
        projectId={projectId}
        siteId={page.siteId}
      />
    </Section>
  );
}

/**
 * Removing someone takes away the row the dialog opened from. Once the dialog
 * has closed, focus moves to the next person's Remove button, or to the
 * section's heading when no one is left.
 */
function useFocusAfterRemoval(sectionId: string, grants: AccessGrantSummary[], removing: AccessGrantSummary | null) {
  const removed = useRef<string | null>(null);
  useEffect(() => {
    if (removing || !removed.current || grants.some((grant) => grant.id === removed.current)) return;
    removed.current = null;
    const section = document.getElementById(sectionId);
    const next = section?.querySelector<HTMLElement>("[data-remove-grant]");
    if (next) next.focus();
    else focusSectionHeading(section);
  }, [grants, removing, sectionId]);
  return (grantId: string) => {
    removed.current = grantId;
  };
}

function shareTargets(site: PageSiteSummary, pages: PublishedPageSummary[]): ShareTarget[] {
  const targets: ShareTarget[] = [];
  if (canShareVisibility(site.defaultVisibility)) targets.push({ label: "All pages", path: null, routeId: null });
  for (const page of pages) {
    if (canShareVisibility(page.effectiveVisibility)) targets.push({ label: page.title, path: page.path, routeId: page.routeId });
  }
  return targets;
}

/** Everyone given this host's pages by email, with Share and Remove. Hidden from people who can't share. */
export function SiteAccessSection({
  pages,
  projectId,
  site,
}: {
  pages: PublishedPageSummary[];
  projectId: string;
  site: PageSiteSummary;
}) {
  const { organization } = useWorkspace();
  const { access, canShare } = useCanShare(projectId, site.id);
  const [sharing, setSharing] = useState(false);
  const [removing, setRemoving] = useState<AccessGrantSummary | null>(null);
  const grants = access.data?.grants ?? NO_GRANTS;
  const onRemoved = useFocusAfterRemoval("people", grants, removing);
  if (!canShare) return null;

  const targets = shareTargets(site, pages);

  return (
    <Section
      actions={
        access.data && targets.length ? (
          <Button icon={UserPlus} onClick={() => setSharing(true)} size="sm">
            Share
          </Button>
        ) : null
      }
      className="scroll-mt-24"
      id="people"
      title="People with access"
    >
      {access.isPending ? (
        <ListSkeleton rows={1} />
      ) : access.isError ? (
        <ErrorState error={access.error} onRetry={() => access.refetch()} role={roleLabel(organization.role)} />
      ) : grants.length === 0 ? (
        <p className="text-sm text-ink-3">
          {targets.length ? "No one outside the project." : "No one outside the project. Only Private and Protected pages can be shared."}
        </p>
      ) : (
        <GrantList grants={grants} onRemove={setRemoving} />
      )}
      {sharing ? <ShareDialog onClose={() => setSharing(false)} projectId={projectId} siteId={site.id} targets={targets} /> : null}
      <RemoveGrantDialog
        grant={removing}
        onClose={() => setRemoving(null)}
        onRemoved={onRemoved}
        projectId={projectId}
        siteId={site.id}
      />
    </Section>
  );
}

function GrantList({ grants, onRemove }: { grants: AccessGrantSummary[]; onRemove: (grant: AccessGrantSummary) => void }) {
  return (
    <List label="People with access">
      {grants.map((grant) => {
        const who = grant.name || grant.email;
        return (
          <li className="flex items-center gap-3 py-2.5 pr-2 pl-4" key={grant.id}>
            <Avatar className="rounded-full" label={who} seed={grant.userId} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{who}</div>
              <div className="text-[13px] [overflow-wrap:anywhere] text-ink-3">
                {grant.name && grant.name !== grant.email ? <>{grant.email} · </> : null}
                {grant.scope === "site" ? "All pages" : <span className="font-mono text-xs">{grant.routePath}</span>}
                {grant.expiresAt ? ` · until ${formatDate(grant.expiresAt)}` : null}
              </div>
              <div className="truncate text-xs text-ink-3">
                Shared{grant.createdBy ? ` by ${grant.createdBy}` : null} <RelativeTime value={grant.createdAt} />
              </div>
            </div>
            <IconButton
              className="text-ink-3 hover:text-err"
              data-remove-grant=""
              icon={Trash2}
              label={`Remove access for ${who}`}
              onClick={() => onRemove(grant)}
              size="sm"
            />
          </li>
        );
      })}
    </List>
  );
}

function ShareDialog({
  onClose,
  projectId,
  siteId,
  targets,
}: {
  onClose: () => void;
  projectId: string;
  siteId: string;
  targets: ShareTarget[];
}) {
  const share = useShareAccess(projectId);
  const formId = useId();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [target, setTarget] = useState(targets[0]?.routeId ?? ALL_PAGES);
  const [days, setDays] = useState("0");

  const single = targets.length === 1 ? targets[0] : undefined;
  const serverEmailError = share.error instanceof ApiError && share.error.fieldErrors?.email ? "Enter a valid email address." : null;
  const formError = share.isError && !serverEmailError ? shareErrorMessage(share.error) : null;
  const result = share.data;

  if (result) {
    return (
      <Dialog
        description={result.created ? undefined : "They already had access. Their end date now matches what you picked."}
        footer={
          <Button onClick={onClose} variant="primary">
            Done
          </Button>
        }
        onClose={onClose}
        open
        title={`Shared with ${result.grant.email}`}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-line bg-sunken py-1.5 pr-1.5 pl-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink" title={result.grant.url}>
              {displayUrl(result.grant.url)}
            </span>
            <CopyButton label="Copy link" value={result.grant.url} variant="secondary">
              Copy link
            </CopyButton>
          </div>
          <p className="text-sm text-ink-2">
            Send them this link. They sign in with <span className="font-medium text-ink">{result.grant.email}</span> to open it.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      description={
        single ? (
          <>
            One person can open {single.path ? <span className="font-mono text-[13px] text-ink">{single.path}</span> : "all pages"} after
            signing in with their email.
          </>
        ) : (
          "One person can open what you pick after signing in with their email."
        )
      }
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button form={formId} icon={UserPlus} loading={share.isPending} type="submit" variant="primary">
            Share
          </Button>
        </>
      }
      onClose={onClose}
      open
      title="Share access"
    >
      <form
        className="space-y-4"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          const value = email.trim().toLowerCase();
          if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            setEmailError("Enter a valid email address.");
            return;
          }
          setEmailError(null);
          const length = Number(days);
          share.mutate({
            email: value,
            expiresAt: length ? new Date(Date.now() + length * 86_400_000).toISOString() : null,
            routeId: target === ALL_PAGES ? null : target,
            siteId,
          });
        }}
      >
        <Field error={emailError ?? serverEmailError} label="Email">
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              autoFocus
              inputMode="email"
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
              placeholder="name@company.com"
              spellCheck={false}
              type="email"
              value={email}
            />
          )}
        </Field>
        {single ? null : (
          <Field label="Share">
            {(props) => (
              <Select {...props} onChange={(event) => setTarget(event.target.value)} value={target}>
                {targets.map((option) => (
                  <option key={option.routeId ?? ALL_PAGES} value={option.routeId ?? ALL_PAGES}>
                    {option.path ? `${option.label} · ${option.path}` : option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Access ends">
          {(props) => (
            <Select {...props} onChange={(event) => setDays(event.target.value)} value={days}>
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.days} value={String(option.days)}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p className="text-[13px] text-ink-3">No email is sent: you send them the link. They see only what you share.</p>
        {formError ? <FormMessage>{formError}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function RemoveGrantDialog({
  grant,
  onClose,
  onRemoved,
  projectId,
  siteId,
}: {
  grant: AccessGrantSummary | null;
  onClose: () => void;
  onRemoved: (grantId: string) => void;
  projectId: string;
  siteId: string;
}) {
  const remove = useUnshareAccess(projectId, siteId);
  const toast = useToast();
  const who = grant ? grant.name || grant.email : "";

  const close = () => {
    remove.reset();
    onClose();
  };

  return (
    <Dialog
      description={
        grant ? (
          <>
            <span className="font-medium text-ink">{grant.email}</span> can no longer open{" "}
            {grant.scope === "site" ? "this host's pages" : <span className="font-mono text-[13px] text-ink">{grant.routePath}</span>}{" "}
            through this share. If they are also in the project, they keep that access.
          </>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            icon={Trash2}
            loading={remove.isPending}
            onClick={() => {
              if (!grant) return;
              remove.mutate(grant.id, {
                onSuccess: () => {
                  toast.show(`${who} no longer has access.`);
                  onRemoved(grant.id);
                  close();
                },
              });
            }}
            variant="danger"
          >
            Remove access
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(grant)}
      title={grant ? `Remove access for ${who}?` : "Remove access"}
    >
      {remove.isError ? <FormMessage>{shareErrorMessage(remove.error)}</FormMessage> : null}
    </Dialog>
  );
}
