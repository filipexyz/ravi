"use client";

import { Archive, ArrowLeft, GitPullRequestArrow, Pencil, RotateCcw } from "lucide-react";
import { useOrgRouter } from "@/lib/org-href";
import { useState } from "react";

import type { Project } from "@/features/console/types";
import { roleCapabilities, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock, CopyValue } from "@/ui/copy";
import { FormMessage } from "@/ui/form";
import { DetailList, PageHeader, Panel, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { ErrorState, Skeleton } from "@/ui/states";
import { formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { ThemeItemSections } from "@/features/widgets/theme-details";
import { WidgetItemSections } from "@/features/widgets/widget-details";

import { libraryErrorText, useArchiveLibraryItem, useItemProposals, useLibraryItem, useLibraryVersions, useRevertLibraryItem } from "./api";
import { KIND_WORDS, type LibraryKind, useLibraryKind } from "./kind";
import { authorLabel, libraryHref, proposalPath, proposalStatus } from "./labels";
import { LibraryPinsSection } from "./library-pins";
import { LibraryGate } from "./library-screen";
import type { LibraryAgentManifest, LibraryItem, LibraryItemVersion, LibraryProposal } from "./types";

export function LibraryItemScreen({ projectId, scope, slug }: { projectId?: string; scope: string; slug: string }) {
  return (
    <LibraryGate projectRef={projectId}>
      {(project) => <LibraryItemDetail project={project} scope={scope} slug={slug} />}
    </LibraryGate>
  );
}

function LibraryItemDetail({ project, scope, slug }: { project: Project | null; scope: string; slug: string }) {
  const { organization } = useWorkspace();
  const kind = useLibraryKind();
  const [version, setVersion] = useState<number | null>(null);
  const query = useLibraryItem(scope, slug, version);
  const versions = useLibraryVersions(scope, slug);
  const proposals = useItemProposals(scope, slug);
  const can = proposals.data?.can ?? { propose: false, review: false };
  const back = (
    <Button className="-ml-2.5 mb-3" href={libraryHref(project, kind)} icon={ArrowLeft} size="sm" variant="ghost">
      Library
    </Button>
  );

  if (query.isPending) {
    return (
      <>
        {back}
        <div aria-busy aria-label="Loading" className="space-y-4" role="status">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  }
  if (query.isError || !query.data) {
    return (
      <>
        {back}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} role={roleLabel(organization.role)} title={KIND_WORDS[kind].loadError} />
      </>
    );
  }

  const { item, version: shown } = query.data;
  const current = item.version === shown.number;
  return (
    <>
      {back}
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-2">
            {can.propose ? (
              <Button href={libraryHref(project, kind, scope, slug, "propose")} icon={Pencil}>
                Propose a change
              </Button>
            ) : null}
            <ArchiveButton item={item} kind={kind} project={project} />
          </div>
        }
        description={item.description}
        title={<span className="font-mono">{item.slug}</span>}
      >
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge tone={item.scope === "org" ? "neutral" : "info"}>
            {item.scope === "org" ? "Organization" : (item.project?.name ?? "Project")}
          </Badge>
          <Badge tone={current ? "ok" : "warn"}>{current ? `v${shown.number}, current` : `v${shown.number}, older version`}</Badge>
          {item.externalAllowed ? <Badge>Allowed in chats with people outside</Badge> : null}
        </div>
      </PageHeader>

      <div className="space-y-8">
        <OpenItemProposals kind={kind} project={project} proposals={(proposals.data?.proposals ?? []).filter((entry) => entry.status === "draft" || entry.status === "proposed")} />

        <Section title="Details">
          <Panel className="px-5">
            <ItemFacts item={item} version={shown} />
          </Panel>
        </Section>

        {kind === "theme" ? (
          <ThemeItemSections files={shown.files} item={item} project={project} />
        ) : kind === "widget" ? (
          <WidgetItemSections files={shown.files} item={item} project={project} version={shown} />
        ) : kind === "agent" ? (
          <>
            <AgentSetup manifest={shown.agent ?? null} />
            <Section
              description="Installing creates a new agent on that Ravi with these instructions. Ravi asks before it grants a permission profile or skills."
              title="Install it in Ravi"
            >
              <CodeBlock code={`ravi agents install ${item.ref}`} />
            </Section>
          </>
        ) : (
          <>
            <Section description="Agents load the current version with this command. Only published versions ever reach an agent." title="Use it in Ravi">
              <CodeBlock code={`ravi skills show ${item.ref}`} />
            </Section>

            <LibraryPinsSection item={item} project={project} />
          </>
        )}

        <Section title="Files">
          <div className="space-y-4">
            {shown.files.map((file) => (
              <Panel key={file.path}>
                <div className="flex items-center justify-between border-b border-line px-4 py-2">
                  <span className="font-mono text-[13px] text-ink">{file.path}</span>
                  <span className="text-[12px] text-ink-3">{formatBytes(file.bytes)}</span>
                </div>
                <pre className="max-h-[480px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {file.content}
                </pre>
              </Panel>
            ))}
          </div>
        </Section>

        <Section
          description={
            can.review
              ? "Each publish is a new version; older ones stay readable. Pick an older one to revert to it."
              : "Each publish is a new version; older ones stay readable."
          }
          title="Versions"
        >
          {versions.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : versions.isError ? (
            <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
          ) : (
            <List label="Versions">
              {(versions.data ?? []).map((entry) => (
                <ListRow
                  description={entry.note ?? `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"}`}
                  key={entry.number}
                  meta={
                    <>
                      {entry.publishedBy?.name ? <span>{entry.publishedBy.name}</span> : null}
                      {entry.publishedAt ? <span>{formatDate(entry.publishedAt, true)}</span> : null}
                    </>
                  }
                  actions={
                    can.review && entry.number !== item.version && entry.number === shown.number ? (
                      <RevertButton item={item} version={entry.number} />
                    ) : undefined
                  }
                  onClick={() => setVersion(entry.number === item.version ? null : entry.number)}
                  selected={entry.number === shown.number}
                  title={
                    <span className="flex items-center gap-2">
                      <span>Version {entry.number}</span>
                      {entry.number === item.version ? <Badge tone="ok">Current</Badge> : null}
                    </span>
                  }
                />
              ))}
            </List>
          )}
        </Section>
      </div>
    </>
  );
}

function ItemFacts({ item, version }: { item: LibraryItem; version: LibraryItemVersion }) {
  return (
    <DetailList
      items={[
        { label: "Reference", value: <CopyValue value={item.ref} /> },
        { label: "Scope", value: item.scope === "org" ? "Every project in the organization" : `Only the ${item.project?.name ?? ""} project` },
        {
          label: "Published",
          value: version.publishedAt
            ? `${formatDate(version.publishedAt, true)}${item.publishedBy?.name && version.number === item.version ? ` by ${item.publishedBy.name}` : ""}`
            : "Not published",
        },
        version.note ? { label: "Note", value: version.note } : null,
        item.kind === "skill"
          ? {
              label: "Outside chats",
              value: item.externalAllowed
                ? "Agents may load it while talking to people outside the organization."
                : "Agents load it only in the organization's own conversations.",
            }
          : null,
      ]}
    />
  );
}

function ArchiveButton({ item, kind, project }: { item: LibraryItem; kind: LibraryKind; project: Project | null }) {
  const { organization } = useWorkspace();
  const router = useOrgRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [scope, slug] = item.ref.split("/") as [string, string];
  const archive = useArchiveLibraryItem(scope, slug);
  // Project admins can archive too; the button shows for the roles that always can.
  if (!roleCapabilities(organization.role).canAdminOrganization) return null;

  const close = () => {
    archive.reset();
    setOpen(false);
  };
  return (
    <>
      <Button icon={Archive} onClick={() => setOpen(true)} variant="secondary">
        Archive
      </Button>
      <Dialog
        description={
          kind === "agent"
            ? "People stop finding and installing it; agents already installed keep running. Its versions are kept, and publishing it again brings it back."
            : kind === "theme"
              ? "Agents stop finding it and pointers to it are skipped, so private pages and the next ship use the organization's theme or the default. Its versions are kept, and publishing it again brings it back."
              : kind === "widget"
                ? "Agents stop finding it and new pages can't use it; pages already published keep the version they shipped with. Its versions are kept, and publishing it again brings it back."
                : "Agents stop finding and loading it. Its versions are kept, and publishing it again brings it back."
        }
        footer={
          <>
            <Button onClick={close} variant="ghost">
              Keep it
            </Button>
            <Button
              loading={archive.isPending}
              onClick={() =>
                archive.mutate(undefined, {
                  onSuccess: () => {
                    close();
                    toast.show(`${item.slug} was archived.`);
                    router.push(libraryHref(project, kind));
                  },
                })
              }
              variant="danger"
            >
              Archive
            </Button>
          </>
        }
        onClose={close}
        open={open}
        title={`Archive ${item.slug}?`}
      >
        {archive.isError ? <FormMessage>{libraryErrorText(archive.error) ?? "It couldn't be archived. Try again."}</FormMessage> : null}
      </Dialog>
    </>
  );
}

/** What an agent definition's agent.json suggests, and the skills it needs. */
function AgentSetup({ manifest }: { manifest: LibraryAgentManifest | null }) {
  const empty = "Ravi's default";
  return (
    <Section description="Suggestions the installer sees. Nothing here is applied without the person installing it agreeing." title="How it runs">
      <Panel className="px-5">
        <DetailList
          items={[
            { label: "Provider", value: manifest?.provider ?? empty },
            { label: "Model", value: manifest?.model ? <span className="font-mono text-[13px]">{manifest.model}</span> : empty },
            { label: "Permission profile", value: manifest?.profile ?? empty },
            {
              label: "Skills it needs",
              value: manifest?.skills.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {manifest.skills.map((ref) => (
                    <Badge key={ref}>
                      <span className="font-mono">{ref}</span>
                    </Badge>
                  ))}
                </span>
              ) : (
                "None"
              ),
            },
          ]}
        />
      </Panel>
    </Section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function OpenItemProposals({ kind, project, proposals }: { kind: LibraryKind; project: Project | null; proposals: LibraryProposal[] }) {
  if (proposals.length === 0) return null;
  return (
    <Section title="Open proposals">
      <List label="Open proposals">
        {proposals.map((proposal) => {
          const status = proposalStatus(proposal);
          return (
            <ListRow
              chevron
              description={proposal.note ?? undefined}
              href={proposalPath(project, kind, proposal.ref, proposal.number)}
              key={proposal.number}
              leading={
                <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
                  <GitPullRequestArrow aria-hidden size={16} />
                </span>
              }
              meta={<span>{authorLabel(proposal.author)}</span>}
              title={
                <span className="flex items-center gap-2">
                  <span>{`Proposal ${proposal.number}`}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </span>
              }
            />
          );
        })}
      </List>
    </Section>
  );
}

function RevertButton({ item, version }: { item: LibraryItem; version: number }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [scope, slug] = item.ref.split("/") as [string, string];
  const revert = useRevertLibraryItem(scope, slug);
  const close = () => {
    revert.reset();
    setOpen(false);
  };
  return (
    <>
      <Button icon={RotateCcw} onClick={() => setOpen(true)} size="sm" variant="secondary">
        Revert to this
      </Button>
      <Dialog
        description={`Version ${version}'s files are published again as a new version. Agents load it from now on; nothing is deleted.`}
        footer={
          <>
            <Button onClick={close} variant="ghost">
              Cancel
            </Button>
            <Button
              loading={revert.isPending}
              onClick={() =>
                revert.mutate(version, {
                  onSuccess: (result) => {
                    close();
                    toast.show(`Published version ${result.version.number} with version ${version}'s files.`);
                  },
                })
              }
            >
              Revert
            </Button>
          </>
        }
        onClose={close}
        open={open}
        title={`Revert ${item.slug} to version ${version}?`}
      >
        {revert.isError ? <FormMessage>{libraryErrorText(revert.error) ?? "It couldn't be reverted. Try again."}</FormMessage> : null}
      </Dialog>
    </>
  );
}
