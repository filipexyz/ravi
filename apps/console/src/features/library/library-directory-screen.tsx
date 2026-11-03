"use client";

import { Bot, Search, SearchX } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { CodeBlock } from "@/ui/copy";
import { Input } from "@/ui/form";
import { PageHeader, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";

import { useAgentDirectory } from "./api";
import { LibraryGate, LibraryTabs } from "./library-screen";
import type { DirectoryAgent } from "./types";

const SEARCH_DELAY_MS = 250;

/** Agents running on the org's linked machines (`/org/library/directory`, `/p/<project>/library/directory`). */
export function LibraryDirectoryScreen({ projectId }: { projectId?: string }) {
  return <LibraryGate projectRef={projectId}>{(project) => <Directory project={project} />}</LibraryGate>;
}

function Directory({ project }: { project: Project | null }) {
  const { organization } = useWorkspace();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const directory = useAgentDirectory(query, project?.id ?? null);
  const agents = directory.data?.agents ?? [];
  const canAsk = directory.data?.can.ask ?? false;

  return (
    <>
      <PageHeader
        description={
          project
            ? `Agents running on the organization's machines that work for ${project.name} or for everyone. An agent can ask one that takes requests for help.`
            : "Agents running on the organization's machines. An agent can ask one that takes requests for help; the machine's owner decides which ones do."
        }
        title="Library"
      />
      <LibraryTabs active="directory" project={project} />

      <div className="relative mb-4 max-w-md">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={16} />
        <Input
          aria-label="Search running agents"
          className="pl-9"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search running agents"
          type="search"
          value={input}
        />
      </div>

      {directory.isPending ? (
        <ListSkeleton rows={3} />
      ) : directory.isError ? (
        <ErrorState error={directory.error} onRetry={() => void directory.refetch()} role={roleLabel(organization.role)} />
      ) : agents.length === 0 && !query.trim() ? (
        <EmptyState
          description="Agents show up here once a Ravi linked to this organization reports them. Update Ravi and keep the daemon running."
          icon={Bot}
          title="No agents reported yet"
        />
      ) : agents.length === 0 ? (
        <EmptyState description="Try other words, or a shorter part of a word." icon={SearchX} title="No agents match" />
      ) : (
        <List label="Running agents">
          {agents.map((entry) => (
            <DirectoryRow entry={entry} key={`${entry.installation.id}/${entry.agent.id}`} project={project} />
          ))}
        </List>
      )}

      {canAsk && agents.some((entry) => entry.acceptsRequests && !entry.self) ? (
        <Section
          className="mt-8"
          description="From a machine where Ravi is logged in to this organization. The answer comes back to the agent or person who asked."
          title="Ask one of them"
        >
          <CodeBlock code={'ravi agents ask <machine>/<agent> "What you need" --execute'} />
        </Section>
      ) : null}
    </>
  );
}

function DirectoryRow({ entry, project }: { entry: DirectoryAgent; project: Project | null }) {
  const { agent, installation } = entry;
  return (
    <ListRow
      description={agent.description ?? undefined}
      leading={
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <Bot aria-hidden size={16} />
        </span>
      }
      meta={
        <>
          <span>{entry.self ? `${installation.name} (this machine)` : installation.name}</span>
          {entry.online ? null : (
            <span>
              Last seen <RelativeTime value={entry.reportedAt} />
            </span>
          )}
        </>
      }
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-[13px]">{agent.name === agent.id ? agent.id : `${agent.name} (${agent.id})`}</span>
          <Badge dot tone={entry.online ? "ok" : "neutral"}>
            {entry.online ? "Online" : "Offline"}
          </Badge>
          {entry.acceptsRequests ? <Badge tone="info">Takes requests</Badge> : null}
          {agent.project && !project ? <Badge>{agent.project.name}</Badge> : null}
        </span>
      }
    />
  );
}
