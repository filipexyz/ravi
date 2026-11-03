"use client";

import { Building2, FileText, Plus, RefreshCw, Video } from "lucide-react";

import { CenteredScreen, OrganizationChoices } from "@/features/org/organization-picker";
import { safeAuthReturnTo } from "@/lib/auth/return-to";
import type { SharedPageSummary } from "@/server/console/access/grants";
import type { SharedMeetingSummary } from "@/server/console/meetings/sharing";
import { Button } from "@/ui/button";
import { List, ListRow } from "@/ui/list";
import { formatDate } from "@/ui/time";
import type { Org } from "./types";

export function OrganizationSelectionScreen({
  deniedOrganization,
  manageHref,
  orgs,
  returnTo = "/projects",
  sharedMeetings = [],
  sharedPages = [],
}: {
  /** The organization a link named that this account can't open. */
  deniedOrganization?: string;
  manageHref?: string;
  orgs: Org[];
  returnTo?: string;
  sharedMeetings?: SharedMeetingSummary[];
  sharedPages?: SharedPageSummary[];
}) {
  const hasOrganizations = orgs.length > 0;
  const hasSharedPages = sharedPages.length > 0 || sharedMeetings.length > 0;
  const refreshHref = safeReturnPath(returnTo);
  const signUpHref = signUpPathForReturnTo(refreshHref);

  if (hasOrganizations) {
    return (
      <CenteredScreen
        description={
          deniedOrganization
            ? `This link is for the organization “${deniedOrganization}”, which this account can't open. Choose one of yours, or sign in with the account that belongs to it.`
            : "Your account belongs to more than one organization. Private pages and data open only in the organization that owns them."
        }
        title={deniedOrganization ? "No access to this organization" : "Choose an organization"}
      >
        <OrganizationChoices orgs={orgs} returnTo={returnTo} />
        {hasSharedPages ? <SharedWithYou className="mt-8" meetings={sharedMeetings} pages={sharedPages} /> : null}
        <div className="mt-6 flex items-center justify-center gap-1">
          {manageHref ? (
            <>
              <Button href={manageHref} size="sm" variant="ghost">
                Open management
              </Button>
              <span aria-hidden className="text-[13px] text-line-strong">
                ·
              </span>
            </>
          ) : null}
          <Button external href="/logout" size="sm" variant="ghost">
            Sign out
          </Button>
        </div>
      </CenteredScreen>
    );
  }

  if (hasSharedPages) {
    return (
      <CenteredScreen
        description="People in other organizations gave you access to these. They open with this account."
        title="Shared with you"
      >
        <SharedWithYou meetings={sharedMeetings} pages={sharedPages} />
        <div className="mt-6 flex items-center justify-center gap-1">
          <Button href={signUpHref} size="sm" variant="ghost">
            Create your own organization
          </Button>
          <span aria-hidden className="text-[13px] text-line-strong">
            ·
          </span>
          <Button external href="/logout" size="sm" variant="ghost">
            Sign out
          </Button>
        </div>
      </CenteredScreen>
    );
  }

  return (
    <CenteredScreen
      description="The Console needs an organization before projects and pages can open."
      title="Create your organization"
    >
      <div className="space-y-4 rounded-lg border border-line bg-surface p-5 text-center">
        <span className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-sunken text-ink-3">
          <Building2 aria-hidden size={18} />
        </span>
        <p className="text-sm text-ink-2">
          Start by creating one for your team. If someone added your email to their organization, sign in with that
          email, then refresh this page.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button href={signUpHref} icon={Plus} variant="primary">
            Create organization
          </Button>
          <Button href={refreshHref} icon={RefreshCw} variant="ghost">
            Refresh
          </Button>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-center gap-1">
        {manageHref ? (
          <>
            <Button href={manageHref} size="sm" variant="ghost">
              Open management
            </Button>
            <span aria-hidden className="text-[13px] text-line-strong">
              ·
            </span>
          </>
        ) : null}
        <Button external href="/logout" size="sm" variant="ghost">
          Sign out
        </Button>
      </div>
    </CenteredScreen>
  );
}

function SharedWithYou({
  className,
  meetings,
  pages,
}: {
  className?: string;
  meetings: SharedMeetingSummary[];
  pages: SharedPageSummary[];
}) {
  return (
    <section className={className}>
      <h2 className="mb-2 px-1 text-[13px] font-medium text-ink-3">Shared with you</h2>
      <List label="Shared with you">
        {meetings.map((meeting) => (
          <ListRow
            description={
              <span className="block truncate">
                {meeting.organizationName}
                {meeting.recordedAt ? ` · ${formatDate(meeting.recordedAt)}` : ""}
                {meeting.sharedBy ? ` · shared by ${meeting.sharedBy}` : ""}
                {meeting.expiresAt ? ` · until ${formatDate(meeting.expiresAt)}` : ""}
              </span>
            }
            href={meeting.path}
            key={meeting.grantId}
            leading={
              <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full bg-sunken text-ink-3">
                <Video size={16} />
              </span>
            }
            title={meeting.title ?? "Meeting"}
          />
        ))}
        {pages.map((page) => (
          <ListRow
            description={
              <span className="block truncate">
                {page.organizationName}
                {page.sharedBy ? ` · shared by ${page.sharedBy}` : ""}
                {page.expiresAt ? ` · until ${formatDate(page.expiresAt)}` : ""}
              </span>
            }
            href={page.url}
            key={page.grantId}
            leading={
              <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full bg-sunken text-ink-3">
                <FileText size={16} />
              </span>
            }
            title={<span className="font-mono text-[13px]">{`${page.siteHostname}${page.path === "/" ? "" : page.path}`}</span>}
          />
        ))}
      </List>
    </section>
  );
}

function signUpPathForReturnTo(returnTo: string) {
  const safeReturnTo = safeReturnPath(returnTo);
  if (safeReturnTo === "/projects") return "/sign-up";
  const params = new URLSearchParams({ returnTo: safeReturnTo });
  return `/sign-up?${params.toString()}`;
}

function safeReturnPath(returnTo: string) {
  return safeAuthReturnTo(returnTo) ?? "/projects";
}
