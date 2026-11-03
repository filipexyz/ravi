"use client";

import { ArrowUpRight, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import type { GithubAppRepository, Project, ProjectGithubAppConfig } from "@/features/console/types";
import { roleCapabilities, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Select } from "@/ui/form";
import { GithubMark } from "@/ui/github-mark";
import { Panel } from "@/ui/layout";
import { ErrorState, Skeleton } from "@/ui/states";
import { CommandBlock } from "./command-block";
import { useGithubAppQuery } from "./data";
import { SettingsFrame } from "./settings-frame";
import { SettingsGroup, SettingsGroupAside } from "./settings-group";

export function IntegrationsScreen({ projectId }: { projectId: string }) {
  return (
    <SettingsFrame projectRef={projectId} tab="integrations">
      {(project) => <GithubIntegration project={project} />}
    </SettingsFrame>
  );
}

const VISIBLE_REPOS = 8;

const EVENT_WORDS: Record<string, string> = {
  "issue.closed": "An issue is closed",
  "issue.opened": "An issue is opened",
  "pull_request.closed": "A pull request is closed",
  "pull_request.merged": "A pull request is merged",
  "pull_request.opened": "A pull request is opened",
  "pull_request.reopened": "A pull request is reopened",
  "push.branch": "Someone pushes to any branch",
  "push.default_branch": "Someone pushes to the default branch",
  "push.tag": "A tag is pushed",
  "workflow_run.completed": "A workflow run finishes",
};

/** Every repository the organization's linked GitHub accounts can see, once each. */
function organizationRepositories(config: ProjectGithubAppConfig | undefined) {
  const byName = new Map<string, GithubAppRepository>();
  for (const connection of config?.connections ?? []) {
    if (connection.status !== "active") continue;
    for (const repository of connection.repositories) byName.set(repository.fullName.toLowerCase(), repository);
  }
  return sortRepositories([...byName.values()]);
}

function GithubIntegration({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const query = useGithubAppQuery(project.id);
  const config = query.data;
  const repositories = useMemo(() => organizationRepositories(config), [config]);
  const { canWriteProjects } = roleCapabilities(organization.role);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const selectedRepo = repositories.find((repo) => repo.id === selectedRepoId) ?? repositories[0];

  return (
    <div className="space-y-10">
      <SettingsGroup
        description={
          <>
            Lets your agents react to pull requests, issues, pushes and workflow runs in this project&apos;s
            repositories, through <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">ravi watch create github</span>.
          </>
        }
        title="GitHub"
      >
        {query.isLoading ? (
          <Panel className="space-y-3" padded>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-80 max-w-full" />
            <Skeleton className="h-9 w-40" />
          </Panel>
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            role={roleLabel(organization.role)}
            title="The GitHub connection couldn't load"
          />
        ) : config ? (
          <GithubState
            config={config}
            onSelectRepo={setSelectedRepoId}
            repositories={repositories}
            selectedRepoId={selectedRepo?.id ?? null}
          />
        ) : null}
      </SettingsGroup>

      {selectedRepo ? (
        <SettingsGroup
          description={
            <>
              Run these where Ravi runs, signed in to this Console with{" "}
              <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">ravi login</span>.
            </>
          }
          title="Create a watch"
        >
          <WatchSteps canWrite={canWriteProjects} project={project} repository={selectedRepo} />
        </SettingsGroup>
      ) : null}

      {config ? (
        <SettingsGroupAside>
          <Details config={config} />
        </SettingsGroupAside>
      ) : null}
    </div>
  );
}

function sortRepositories(repositories: GithubAppRepository[]) {
  return [...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** GitHub accounts are linked once, for the whole organization; the project shows what it can watch. */
function GithubState({
  config,
  onSelectRepo,
  repositories,
  selectedRepoId,
}: {
  config: ProjectGithubAppConfig;
  onSelectRepo: (id: string) => void;
  repositories: GithubAppRepository[];
  selectedRepoId: string | null;
}) {
  const { organization } = useWorkspace();
  const canManage = roleCapabilities(organization.role).canWriteProjects;
  const accounts = config.connections.map((connection) => connection.accountLogin ?? connection.displayName);

  if (!config.connections.length) {
    return (
      <Panel padded>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <GithubMark className="size-10 shrink-0 rounded-lg bg-sunken p-2.5 text-ink" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-[15px] font-semibold text-ink">Not connected</div>
            <p className="text-sm text-ink-2">
              GitHub accounts are linked once for {organization.name}, and every project can watch their repositories.
            </p>
            {!canManage ? (
              <p className="text-sm text-ink-3">
                Linking GitHub needs the owner, admin or developer role. Yours is {roleLabel(organization.role)}.
              </p>
            ) : null}
          </div>
          {canManage ? (
            <Button className="shrink-0" href={config.manageUrl} variant="primary">
              Link GitHub
            </Button>
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
        <GithubMark className="size-10 shrink-0 rounded-lg bg-sunken p-2.5 text-ink" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">{accounts.join(", ")}</span>
            <Badge dot tone={repositories.length ? "ok" : "warn"}>
              {repositories.length ? "Connected" : "No repositories yet"}
            </Badge>
          </div>
          <p className="text-sm text-ink-2">
            {repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`}, linked for all of{" "}
            {organization.name}. You choose which ones the app sees on GitHub.
          </p>
        </div>
        <Button className="shrink-0" href={config.manageUrl} iconRight={ArrowUpRight} variant="ghost">
          Organization GitHub
        </Button>
      </div>
      {repositories.length ? (
        <RepositoryPicker onSelect={onSelectRepo} repositories={repositories} selectedId={selectedRepoId} />
      ) : null}
    </Panel>
  );
}

function RepositoryPicker({
  onSelect,
  repositories,
  selectedId,
}: {
  onSelect: (id: string) => void;
  repositories: GithubAppRepository[];
  selectedId: string | null;
}) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => sortRepositories(repositories), [repositories]);
  const needle = filter.trim().toLowerCase();
  const matches = needle ? sorted.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : sorted;
  const shown = showAll || needle ? matches : matches.slice(0, VISIBLE_REPOS);

  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-2">
        <div className="text-sm font-medium text-ink">Pick a repository to watch</div>
        {repositories.length > VISIBLE_REPOS ? (
          <div className="relative w-full sm:w-64">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" size={14} />
            <Input
              aria-label="Find a repository"
              className="h-8 pl-8"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a repository"
              type="search"
              value={filter}
            />
          </div>
        ) : null}
      </div>
      <ul aria-label="Repositories" className="px-2 pb-2" role="radiogroup">
        {shown.map((repo) => {
          const active = repo.id === selectedId;
          return (
            <li key={repo.id}>
              <button
                aria-checked={active}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-hover",
                  active && "bg-hover",
                )}
                onClick={() => onSelect(repo.id)}
                role="radio"
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-ink" : "border-line-strong",
                  )}
                >
                  {active ? <span className="size-2 rounded-full bg-ink" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{repo.fullName}</span>
                <span className="hidden shrink-0 text-[13px] text-ink-3 sm:inline">
                  {[repo.visibility ? capitalize(repo.visibility) : null, repo.defaultBranch].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          );
        })}
        {!shown.length ? <li className="px-3 py-2.5 text-sm text-ink-3">No repository matches “{filter}”.</li> : null}
      </ul>
      {!needle && !showAll && matches.length > VISIBLE_REPOS ? (
        <div className="border-t border-line px-5 py-2.5">
          <Button iconRight={ChevronRight} onClick={() => setShowAll(true)} size="sm" variant="ghost">
            Show all {matches.length}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WatchSteps({ canWrite, project, repository }: { canWrite: boolean; project: Project; repository: GithubAppRepository }) {
  const [event, setEvent] = useState("pull_request.merged");
  const command = `ravi watch create github ${repository.fullName} --event ${event} --placement console --project ${project.id}`;
  return (
    <Panel className="space-y-5 p-4 sm:p-5" padded>
      <Field hint="Each watch follows one kind of event; create more for others." label="Notify when">
        {(props) => (
          <Select {...props} className="sm:max-w-sm" onChange={(change) => setEvent(change.target.value)} value={event}>
            {Object.entries(EVENT_WORDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Step number={1} title={<>Watch <span className="font-mono text-[13px]">{repository.fullName}</span></>}>
        <CommandBlock command={command} />
      </Step>
      <Step number={2} title="Try it">
        <p className="text-sm text-ink-2">
          Make it happen on GitHub ({(EVENT_WORDS[event] ?? event).toLowerCase()}), then check that it arrived:
        </p>
        <CommandBlock command="ravi inbox list" />
      </Step>
      {!canWrite ? <p className="text-sm text-ink-3">Creating watches needs the owner, admin or developer role.</p> : null}
    </Panel>
  );
}

function Step({ children, number, title }: { children: React.ReactNode; number: number; title: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-medium text-ink-2"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="truncate text-sm font-medium text-ink">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** The full event list, for whoever writes watches by hand. */
function Details({ config }: { config: ProjectGithubAppConfig }) {
  return (
    <details className="group rounded-lg border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium text-ink select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="text-ink-3 transition-transform group-open:rotate-90" size={16} />
        Details
      </summary>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <DetailRow label="Events a watch can use">
          <div className="flex flex-wrap gap-1.5">
            {config.supportedEventTypes.map((type) => (
              <span className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-2" key={type}>
                {type}
              </span>
            ))}
          </div>
        </DetailRow>
      </div>
    </details>
  );
}

function DetailRow({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <div className="pt-1 text-sm text-ink-3">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function capitalize(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
