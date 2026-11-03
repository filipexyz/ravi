"use client";

import { BookOpen, Bot, GitPullRequestArrow, LayoutTemplate, Palette, Plus, Search, SearchX, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project } from "@/features/console/types";
import { findProject, roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Input } from "@/ui/form";
import { PageHeader, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton, NoAccess } from "@/ui/states";
import { TabNav } from "@/ui/tabs";
import { RelativeTime } from "@/ui/time";

import { useLibrarySearch, useOpenLibraryProposals } from "./api";
import { KIND_WORDS, LIBRARY_KINDS, type LibraryKind, useLibraryKind } from "./kind";
import { authorLabel, libraryHref, projectsPath, proposalStatus } from "./labels";
import type { LibraryItem, LibraryProposal } from "./types";

const SEARCH_DELAY_MS = 250;

export const KIND_ICONS: Record<LibraryKind, LucideIcon> = { skill: BookOpen, agent: Bot, theme: Palette, widget: LayoutTemplate };

/** What each kind's list says about itself, in the org and in a project. */
function kindDescription(kind: LibraryKind, project: Project | null) {
  switch (kind) {
    case "agent":
      return project
        ? `Agents anyone in ${project.name} can install on their Ravi: the ones made for this project and the ones the whole organization shares.`
        : "Agents anyone in the organization can install on their Ravi, with their instructions and the skills they need.";
    case "theme":
      return project
        ? `Temas que as páginas de ${project.name} podem usar: os deste projeto e os da organização. O tema ativo vale para todas as páginas com tags ravi-*.`
        : "Cores, fontes e espaços das páginas da organização. O tema ativo vale para todas as páginas com tags ravi-*; um projeto pode ter o seu.";
    case "widget":
      return project
        ? `Cartões e blocos que as páginas de ${project.name} usam para mostrar registros: os deste projeto e os da organização.`
        : "Cartões e blocos que as páginas usam para mostrar registros do Bases, feitos com as peças do tema. Os agentes acham com ravi widgets search.";
    default:
      return project
        ? `Skills this project's agents can find and load: the ones made for ${project.name} and the ones the whole organization shares.`
        : "Skills every agent in the organization can find and load. Project skills live in each project's Library.";
  }
}

/** The empty list's next step and the command that publishes one from a machine. */
function kindEmptyState(kind: LibraryKind, scope: string) {
  switch (kind) {
    case "agent":
      return {
        description:
          "Write one here, or publish an agent from a machine where Ravi is logged in to this organization. People install agents with ravi agents install.",
        command: `ravi agents publish <agent> --scope ${scope} --execute`,
        label: "From the terminal",
      };
    case "theme":
      return {
        description: "Crie um aqui, ou proponha uma pasta com theme.json de uma máquina com o Ravi conectado a esta organização.",
        command: `ravi themes init ./meu-tema\nravi themes propose ./meu-tema --scope ${scope} --execute`,
        label: "No terminal",
      };
    case "widget":
      return {
        description: "Crie um aqui, ou proponha uma pasta com widget.html e widget.json de uma máquina com o Ravi conectado a esta organização.",
        command: `ravi widgets init ./meu-widget\nravi widgets propose ./meu-widget --scope ${scope} --execute`,
        label: "No terminal",
      };
    default:
      return {
        description:
          "Write one here, or send a skill folder (a SKILL.md and its references) from a machine where Ravi is logged in to this organization. Agents find skills with ravi skills search.",
        command: `ravi skills propose ./my-skill --scope ${scope} --execute`,
        label: "From the terminal",
      };
  }
}

/**
 * Checks that the Library is on for this organization and role, and resolves
 * the project when the route has one. The server still enforces both on every
 * call.
 */
export function LibraryGate({
  children,
  projectRef,
}: {
  children: (project: Project | null) => React.ReactNode;
  projectRef?: string;
}) {
  const { organization, projects } = useWorkspace();
  const enabled = useFeature("console.library");
  const project = projectRef ? findProject(projects, projectRef) : null;

  if (projectRef && !project) {
    return (
      <EmptyState
        action={<Button href={projectsPath()}>All projects</Button>}
        description="Check the address, or pick a project from the list."
        icon={SearchX}
        title="This project doesn't exist or you don't have access"
      />
    );
  }
  if (!enabled) {
    return (
      <NoAccess
        description="The Library isn't turned on for this organization, or your role doesn't include it."
        role={roleLabel(organization.role)}
        title="The Library isn't available here"
      />
    );
  }
  return <>{children(project ?? null)}</>;
}

/** Skills | Agents | Temas | Widgets | Running agents, under every Library list. */
export function LibraryTabs({ active, project }: { active: LibraryKind | "directory"; project: Project | null }) {
  return (
    <div className="mb-6 border-b border-line">
      <TabNav
        items={[
          ...LIBRARY_KINDS.map((entry) => ({
            active: entry === active,
            href: libraryHref(project, entry),
            label: KIND_WORDS[entry].Many,
          })),
          { active: active === "directory", href: libraryHref(project, "skill", "directory"), label: "Running agents" },
        ]}
        label="Library sections"
      />
    </div>
  );
}

/**
 * The org's skills, agents, themes or widgets (`/org/library`,
 * `?kind=agent|theme|widget`), or a project's and the org's
 * (`/p/<project>/library`).
 */
export function LibraryScreen({ projectId }: { projectId?: string }) {
  return <LibraryGate projectRef={projectId}>{(project) => <LibraryList project={project} />}</LibraryGate>;
}

export { libraryBasePath } from "./labels";

function LibraryList({ project }: { project: Project | null }) {
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  const words = KIND_WORDS[kind];
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const search = useLibrarySearch(query, project?.id ?? null);
  const items = search.data?.items ?? [];
  const canPropose = search.data?.can?.propose ?? false;
  const publishScope = project ? project.slug : "org";
  const empty = kindEmptyState(kind, publishScope);
  const KindIcon = KIND_ICONS[kind];

  return (
    <>
      <PageHeader
        actions={
          canPropose ? (
            <Button href={libraryHref(project, kind, "new")} icon={Plus}>
              {words.create}
            </Button>
          ) : null
        }
        description={kindDescription(kind, project)}
        title="Library"
      />

      <LibraryTabs active={kind} project={project} />

      <OpenProposals project={project} />

      <div className="relative mb-4 max-w-md">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={16} />
        <Input
          aria-label={words.search}
          className="pl-9"
          onChange={(event) => setInput(event.target.value)}
          placeholder={words.search}
          type="search"
          value={input}
        />
      </div>

      {search.isPending ? (
        <ListSkeleton rows={3} />
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} role={roleLabel(organization.role)} />
      ) : items.length === 0 && !query.trim() ? (
        <EmptyState
          action={
            canPropose ? (
              <Button href={libraryHref(project, kind, "new")} icon={Plus}>
                {words.create}
              </Button>
            ) : undefined
          }
          description={empty.description}
          icon={KindIcon}
          title={words.none}
        >
          <CodeBlock code={empty.command} label={empty.label} />
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          description={kind === "theme" || kind === "widget" ? "Tente outras palavras, ou só um pedaço de uma." : "Try other words, or a shorter part of a word."}
          icon={SearchX}
          title={words.noMatch}
        />
      ) : (
        <List label={words.Many}>
          {items.map((item) => (
            <LibraryRow item={item} key={item.ref} kind={kind} project={project} />
          ))}
        </List>
      )}
    </>
  );
}

function LibraryRow({ item, kind, project }: { item: LibraryItem; kind: LibraryKind; project: Project | null }) {
  const [scope, slug] = item.ref.split("/") as [string, string];
  const Icon = KIND_ICONS[kind];
  return (
    <ListRow
      chevron
      description={item.description}
      href={libraryHref(project, kind, scope, slug)}
      leading={
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <Icon aria-hidden size={16} />
        </span>
      }
      meta={
        <>
          {item.version ? <span>v{item.version}</span> : null}
          {item.publishedAt ? <RelativeTime value={item.publishedAt} /> : null}
        </>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px]">{item.slug}</span>
          {project ? <Badge tone={item.scope === "org" ? "neutral" : "info"}>{item.scope === "org" ? "Organization" : project.name}</Badge> : null}
        </span>
      }
    />
  );
}

/** Open proposals and the viewer's drafts, first on the Library screens. */
function OpenProposals({ project }: { project: Project | null }) {
  const kind = useLibraryKind();
  const proposals = useOpenLibraryProposals(project?.id ?? null);
  const rows = proposals.data ?? [];
  if (proposals.isPending || proposals.isError || rows.length === 0) return null;
  const waiting = rows.filter((proposal) => proposal.status === "proposed" && proposal.can.publish).length;
  return (
    <Section
      className="mb-8"
      description={
        waiting
          ? `${waiting} ${waiting === 1 ? "proposal waits" : "proposals wait"} for you to publish or reject.`
          : "Changes people and agents proposed, and your drafts."
      }
      title="Proposals"
    >
      <List label="Proposals">
        {rows.map((proposal) => (
          <ProposalRow key={`${proposal.ref}#${proposal.number}`} kind={kind} project={project} proposal={proposal} />
        ))}
      </List>
    </Section>
  );
}

function ProposalRow({ kind, project, proposal }: { kind: LibraryKind; project: Project | null; proposal: LibraryProposal }) {
  const [scope, slug] = proposal.ref.split("/") as [string, string];
  const status = proposalStatus(proposal);
  return (
    <ListRow
      chevron
      description={proposal.note ?? proposal.description}
      href={libraryHref(project, kind, scope, slug, "proposals", String(proposal.number))}
      leading={
        <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <GitPullRequestArrow aria-hidden size={16} />
        </span>
      }
      meta={
        <>
          <span>{authorLabel(proposal.author)}</span>
          {proposal.openComments ? <span>{`${proposal.openComments} open ${proposal.openComments === 1 ? "comment" : "comments"}`}</span> : null}
          <RelativeTime value={proposal.proposedAt ?? proposal.updatedAt} />
        </>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px]">{`${scope === "org" ? slug : proposal.ref} #${proposal.number}`}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      }
    />
  );
}
