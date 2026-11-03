"use client";

import Link from "@/ui/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Bug,
  ChevronsUpDown,
  ExternalLink,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  MessagesSquare,
  Monitor,
  Moon,
  Plug,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  Users,
} from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import { api } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { orgSegment } from "@/lib/console-paths";
import type { ConsoleFeatureAccessData, Org, Project } from "@/features/console/types";
import { Avatar } from "@/ui/badge";
import { Input } from "@/ui/form";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSlot } from "@/ui/overlay";
import { Segmented, TabNav } from "@/ui/tabs";
import { applyThemePreference, readThemePreference, subscribeToThemePreference } from "@/ui/theme";
import { ToastProvider } from "@/ui/toast";
import { useOrganizationAccess } from "@/features/org/access";
import { readableOrganizationSettingsHref } from "@/features/org/navigation";
import type { OrganizationAction } from "@/shared/organization-access";
import { FeedbackDialog } from "./feedback-dialog";
import { OrgSegmentProvider, useAppPathname, useOrgHref } from "@/lib/org-href";
import {
  isActivePath,
  orgSectionFromPath,
  type OrgSection,
  projectRefFromPath,
  projectSectionFromPath,
  projectSwitchHref,
} from "./routes";
import {
  featureEnabled,
  findProject,
  useOrgKey,
  useWorkspace,
  WorkspaceProvider,
  type Workspace,
} from "./workspace";

/** Where "Linked chat accounts" lives (ravi-console#45 adds the page). */
const LINKED_ACCOUNTS_HREF = "/link";

export function AppShell({ children, legacy = false, workspace }: { children: React.ReactNode; legacy?: boolean; workspace: Workspace }) {
  return (
    <WorkspaceProvider value={workspace}>
      <OrgSegmentProvider value={orgSegment(workspace.organization)}>
      <ToastProvider>
        <div className="rv-app min-h-dvh bg-canvas font-sans text-ink antialiased">
          <a
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
            href="#main"
          >
            Skip to content
          </a>
          <ShellHeader />
          <main className="mx-auto w-full max-w-[1120px] px-4 pt-8 pb-24 sm:px-6" id="main">
            {legacy ? <LegacyRegion>{children}</LegacyRegion> : children}
          </main>
        </div>
      </ToastProvider>
      </OrgSegmentProvider>
    </WorkspaceProvider>
  );
}

function LegacyRegion({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-3">
        This screen is not part of the redesigned Console yet and keeps its previous look.
      </p>
      <div className="rv-legacy overflow-hidden rounded-xl border border-line">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

function ShellHeader() {
  const pathname = useAppPathname();
  const orgHref = useOrgHref();
  const { features, projects } = useWorkspace();
  const access = useOrganizationAccess();
  const projectRef = projectRefFromPath(pathname);
  const project = findProject(projects, projectRef);
  const section = projectSectionFromPath(pathname);
  const orgSection = projectRef ? undefined : orgSectionFromPath(pathname);
  // Settings opens on the first tab this person can use.
  const settingsTab = featureEnabled(features, "console.settings")
    ? ""
    : featureEnabled(features, "console.github")
      ? "/integrations"
      : featureEnabled(features, "console.audit")
        ? "/activity"
        : null;

  const tabs = project
    ? [
        { href: orgHref(`/p/${project.id}`), label: "Overview", active: section === "overview" },
        featureEnabled(features, "console.pages")
          ? { href: orgHref(`/p/${project.id}/pages`), label: "Pages", active: section === "pages" }
          : null,
        featureEnabled(features, "console.bases")
          ? { href: orgHref(`/p/${project.id}/bases`), label: "Bases", active: section === "bases" }
          : null,
        featureEnabled(features, "console.library")
          ? { href: orgHref(`/p/${project.id}/library`), label: "Library", active: section === "library" }
          : null,
        featureEnabled(features, "console.meetings")
          ? { href: orgHref(`/p/${project.id}/meetings`), label: "Meetings", active: section === "meetings" }
          : null,
        featureEnabled(features, "console.cloud_agents")
          ? { href: orgHref(`/p/${project.id}/cloud`), label: "Cloud agents", active: section === "cloud" }
          : null,
        settingsTab !== null
          ? {
              href: orgHref(`/p/${project.id}/settings${settingsTab}`),
              label: "Settings",
              active: section === "settings" || section === "github" || section === "audit",
            }
          : null,
      ].filter((item): item is { href: string; label: string; active: boolean } => Boolean(item))
    : orgSection
      ? orgTabs(features, orgSection, orgHref, access.allows)
      : [];

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/75">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-1.5 px-4 sm:px-6">
        <Link aria-label="Ravi Console home" className="mr-1 flex items-center" href={orgHref("/projects")}>
          <RaviMark />
        </Link>
        <Slash />
        <OrganizationSwitcher />
        {project ? (
          <>
            <Slash />
            <ProjectSwitcher current={project} />
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <a
            className="hidden h-8 items-center gap-1 rounded-md px-2.5 text-[13px] text-ink-3 transition-colors hover:bg-hover hover:text-ink sm:inline-flex"
            href="https://docs.ravi.bot"
            rel="noreferrer"
            target="_blank"
          >
            Docs
            <ExternalLink aria-hidden size={12} />
          </a>
          <UserMenu />
        </div>
      </div>
      {tabs.length ? (
        <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
          <TabNav items={tabs} label={project ? "Project" : "Organization"} />
        </div>
      ) : null}
    </header>
  );
}

/** Organization settings open on the first tab this person can use. */
function orgSettingsHref(features: ConsoleFeatureAccessData, allows: (action: OrganizationAction) => boolean) {
  const readable = readableOrganizationSettingsHref(allows);
  if (readable) return readable;
  if (featureEnabled(features, "console.domains")) return "/org/domains";
  if (featureEnabled(features, "console.github")) return "/org/github";
  if (featureEnabled(features, "console.audit")) return "/org/audit";
  if (featureEnabled(features, "console.connectors")) return "/org/connectors";
  if (featureEnabled(features, "console.billing")) return "/org/billing";
  return null;
}

/** The organization's own tabs, shown outside a project: its projects, its people and its settings. */
function orgTabs(features: ConsoleFeatureAccessData, section: OrgSection, orgHref: (path: string) => string, allows: (action: OrganizationAction) => boolean) {
  const settingsHref = orgSettingsHref(features, allows);
  const tabs = [
    { href: orgHref("/projects"), label: "Projects", active: section === "projects" },
    allows("organization.members.read")
      ? { href: orgHref("/org/members"), label: "Members", active: section === "members" }
      : null,
    featureEnabled(features, "console.library")
      ? { href: orgHref("/org/library"), label: "Library", active: section === "library" }
      : null,
    settingsHref ? { href: orgHref(settingsHref), label: "Settings", active: section === "settings" } : null,
  ].filter((item): item is { href: string; label: string; active: boolean } => Boolean(item));
  // A lone Projects tab says nothing the page title doesn't.
  return tabs.length > 1 ? tabs : [];
}

export function RaviMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md bg-brand font-display text-[15px] font-bold text-brand-ink",
        className,
      )}
    >
      R
    </span>
  );
}

function Slash() {
  return (
    <span aria-hidden className="px-0.5 text-lg font-light text-line-strong select-none">
      /
    </span>
  );
}

const switcherButton =
  "inline-flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm font-medium text-ink transition-colors hover:bg-hover aria-expanded:bg-hover";

function OrganizationSwitcher() {
  const { features, organization } = useWorkspace();
  const access = useOrganizationAccess();
  const orgHref = useOrgHref();
  const orgKey = useOrgKey();
  const [wantList, setWantList] = useState(false);
  const orgs = useQuery({
    enabled: wantList,
    queryFn: () => api.get<Org[]>("/api/console/organizations"),
    queryKey: orgKey("organizations"),
    staleTime: 60_000,
  });
  const settingsHref = orgSettingsHref(features, access.allows);
  const others = (orgs.data ?? []).filter((org) => org.id !== organization.id);

  return (
    <Menu
      label="Organization"
      trigger={(props) => (
        <button
          {...props}
          aria-label={`Selecionar organização: ${organization.name}`} className={switcherButton}
          onClick={() => {
            setWantList(true);
            props.onClick();
          }}
          onPointerEnter={() => setWantList(true)}
          type="button"
        >
          <Avatar label={organization.name} seed={organization.id} size="sm" />
          <span className="hidden max-w-[180px] truncate sm:inline">{organization.name}</span>
          <ChevronsUpDown aria-hidden className="shrink-0 text-ink-3" size={14} />
        </button>
      )}
    >
      <MenuLabel>Organization</MenuLabel>
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <Avatar label={organization.name} seed={organization.id} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">{organization.name}</div>
          <div className="truncate text-xs text-ink-3">
            {capitalize(organization.role)} · {organization.plan} plan
          </div>
        </div>
      </div>
      {access.allows("organization.members.read") ? (
        <MenuItem href={orgHref("/org/members")} icon={Users}>
          Members
        </MenuItem>
      ) : null}
      {settingsHref ? (
        <MenuItem href={orgHref(settingsHref)} icon={Settings}>
          Organization settings
        </MenuItem>
      ) : null}
      {others.length ? (
        <>
          <MenuSeparator />
          <MenuLabel>Switch to</MenuLabel>
          {others.map((org) => (
            <form action="/api/console/organizations/select" key={org.id} method="post">
              <input name="organizationId" type="hidden" value={org.id} />
              <input name="returnTo" type="hidden" value="/projects" />
              <button
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                role="menuitem"
                tabIndex={-1}
                type="submit"
              >
                <Avatar label={org.name} seed={org.id} size="sm" />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                <span className="text-xs text-ink-3">{capitalize(org.role)}</span>
              </button>
            </form>
          ))}
        </>
      ) : orgs.isLoading ? (
        <div className="px-2.5 py-2 text-xs text-ink-3">Loading organizations…</div>
      ) : null}
    </Menu>
  );
}

function ProjectSwitcher({ current }: { current: Project }) {
  const pathname = useAppPathname();
  const orgHref = useOrgHref();
  const router = useRouter();
  const { projects } = useWorkspace();
  const [filter, setFilter] = useState("");
  const canCreate = useOrganizationAccess().allows("organization.projects.create");
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
    return needle
      ? sorted.filter((project) => project.name.toLowerCase().includes(needle) || project.slug.includes(needle))
      : sorted;
  }, [filter, projects]);

  return (
    <Menu
      className="w-72"
      label="Project"
      trigger={(props) => (
        <button {...props} className={switcherButton} type="button">
          <span className="max-w-[44vw] truncate sm:max-w-[240px]">{current.name}</span>
          <ChevronsUpDown aria-hidden className="shrink-0 text-ink-3" size={14} />
        </button>
      )}
    >
      {projects.length > 6 ? (
        <MenuSlot>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" size={14} />
            <Input
              aria-label="Find a project"
              className="h-8 pl-8"
              data-autofocus
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0]) router.push(orgHref(projectSwitchHref(pathname, matches[0].id)));
              }}
              placeholder="Find a project"
              value={filter}
            />
          </div>
        </MenuSlot>
      ) : null}
      <MenuLabel>Projects</MenuLabel>
      {matches.map((project) => (
        <MenuItem href={orgHref(projectSwitchHref(pathname, project.id))} key={project.id} selected={project.id === current.id}>
          {project.name}
        </MenuItem>
      ))}
      {!matches.length ? <div className="px-2.5 py-2 text-sm text-ink-3">No project matches.</div> : null}
      <MenuSeparator />
      <MenuItem href={orgHref("/projects")} icon={LayoutGrid}>
        All projects
      </MenuItem>
      {canCreate ? (
        <MenuItem href={orgHref("/projects/new")} icon={Plus}>
          New project
        </MenuItem>
      ) : null}
    </Menu>
  );
}

function UserMenu() {
  const { features, platformOperator, viewer } = useWorkspace();
  const pathname = useAppPathname();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const theme = useSyncExternalStore(subscribeToThemePreference, readThemePreference, () => "system" as const);

  return (
    <>
      <Menu
        align="end"
        className="w-64"
        label="Account"
        trigger={(props) => (
          <button
            {...props}
            aria-label="Account"
            className="inline-flex size-8 items-center justify-center rounded-full transition-colors hover:bg-hover aria-expanded:bg-hover"
            type="button"
          >
            <Avatar className="rounded-full" label={viewer.name || viewer.email} seed={viewer.email} size="sm" />
          </button>
        )}
      >
        <div className="px-2.5 pt-2 pb-2">
          <div className="truncate text-sm font-medium text-ink">{viewer.name}</div>
          <div className="truncate text-xs text-ink-3">{viewer.email}</div>
        </div>
        <MenuSeparator />
        {featureEnabled(features, "console.connectors") ? (
          <MenuItem href="/connectors" icon={Plug} selected={isActivePath(pathname, "/connectors")}>
            Connectors
          </MenuItem>
        ) : null}
        <MenuItem href={LINKED_ACCOUNTS_HREF} icon={MessagesSquare}>
          Linked chat accounts
        </MenuItem>
        {featureEnabled(features, "console.bugs") ? (
          <MenuItem href="/bugs" icon={Bug} selected={isActivePath(pathname, "/bugs")}>
            My bug reports
          </MenuItem>
        ) : null}
        {featureEnabled(features, "console.feedback") ? (
          <MenuItem icon={MessageSquareText} onSelect={() => setFeedbackOpen(true)}>
            Send feedback
          </MenuItem>
        ) : null}
        {platformOperator ? (
          <MenuItem href="/manage" icon={Shield}>
            Manage
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuSlot className="flex items-center justify-between gap-2 px-2.5">
          <span className="text-sm text-ink-2">Theme</span>
          <Segmented
            label="Theme"
            onChange={applyThemePreference}
            options={[
              { label: <Monitor aria-label="System" size={14} />, value: "system" },
              { label: <Sun aria-label="Light" size={14} />, value: "light" },
              { label: <Moon aria-label="Dark" size={14} />, value: "dark" },
            ]}
            value={theme}
          />
        </MenuSlot>
        <MenuSeparator />
        <MenuItem external href="/logout" icon={LogOut}>
          Sign out
        </MenuItem>
      </Menu>
      <FeedbackDialog onClose={() => setFeedbackOpen(false)} open={feedbackOpen} />
    </>
  );
}

function capitalize(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
