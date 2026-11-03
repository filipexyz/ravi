"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  GitBranch,
  Globe2,
  History,
  KeyRound,
  Mail,
  MessageSquareText,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Shield,
  Terminal,
  Trash2,
  UserPlus,
  Wrench,
} from "lucide-react";
import Image from "next/image";
import Link from "@/ui/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import {
  type Artifact,
  type ArtifactVersion,
  type ConsoleFeatureAccessData,
  type ConsoleFeatureKey,
  type DomainBindingSummary,
  type DomainClaimSummary,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackSeverity,
  type KnowledgeRetrievalResult,
  type KnowledgeSensitivity,
  type KnowledgeSourceSummary,
  type KnowledgeSourceType,
  type MailMessageSummary,
  type MailboxSummary,
  type PageReleaseRoute,
  type PageSiteRelease,
  type PageSiteDetail,
  type PageSiteSummary,
  type PublishedPageSummary,
  type Project,
  type RuntimeRunDetail,
  type RuntimeRunEvent,
  type RuntimeRunSummary,
  type RuntimeRunToolCall,
  type RuntimeRunTurn,
  type SettingsData,
  type Visibility,
  relTime,
} from "./types";
import { suggestConsoleSlug } from "@/lib/console/slugs";
import { ViewerAssertionAudiencesPanel } from "./viewer-assertion-audiences-panel";
import { Avatar, Button, Card, CardBody, CardHeader, Metric, PageHeader, Progress, SlashMark, StatusDot, Tag, VisibilityTag, statusTone } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { VirtualEventList } from "@/components/virtual-event-list";
import {
  ConsoleApiClientError,
  useArtifact,
  useArtifactVersions,
  useArtifacts,
  useCreatePageSite,
  useCheckDomainBinding,
  useConsoleFeatures,
  useCreateDomainBinding,
  useCreateDomainClaim,
  useCreateKnowledgeIngestion,
  useCreateKnowledgeRetrieval,
  useCreateKnowledgeSource,
  useCreateProject,
  useDeleteKnowledgeSource,
  useDomainClaims,
  useEvents,
  useFeedback,
  useMailOverview,
  useKnowledgeSources,
  useOrganization,
  useOrgs,
  usePageSite,
  usePageSites,
  usePublishedPages,
  useProject,
  useProjectGithubApp,
  useProjects,
  useRemoveOrganizationMember,
  useRuntimeRunDetail,
  useRuntimeRuns,
  useSettings,
  useSubmitFeedback,
  useUpdateSettings,
  useUpsertOrganizationMember,
  useVerifyDomainClaim,
} from "./queries";
import { OrganizationSelectionScreen } from "./org-selection";

export function LoginScreen({
  anonymousMode,
  workosConfigured,
}: {
  anonymousMode: boolean;
  workosConfigured: boolean;
}) {
  return (
    <main className="fullbleed">
      <Card className="col">
        <div style={{ maxWidth: 420, padding: 28 }}>
          <div className="row gap-12" style={{ marginBottom: 28 }}>
            <span className="side-brand-mark">R</span>
            <div>
              <div className="t-h2">Ravi Console</div>
              <div className="t-mono t-small t-mute">console.ravi.bot</div>
            </div>
          </div>
          <div className="col gap-12">
            <SlashMark label="workos authkit" num={1} />
            <h1 className="t-h1">Operate artifacts as hosted services.</h1>
            <p className="t-body t-mute" style={{ margin: 0 }}>
              Production authentication uses WorkOS AuthKit. Development can use an explicit anonymous mode through RAVI_CONSOLE_ANONYMOUS_MODE=true.
            </p>
            {workosConfigured ? (
              <Button href="/sign-in" icon={Shield} variant="primary">
                Continue with WorkOS
              </Button>
            ) : null}
            {anonymousMode ? (
              <Button href="/projects" variant={workosConfigured ? "ghost" : "primary"}>
                Continue as anonymous developer
              </Button>
            ) : null}
            {!workosConfigured && !anonymousMode ? (
              <div className="card" style={{ padding: 14 }}>
                <div className="t-h3">Authentication is not configured.</div>
                <div className="t-mono t-tiny t-mute" style={{ marginTop: 6 }}>
                  Set WorkOS env vars or enable RAVI_CONSOLE_ANONYMOUS_MODE=true for local development.
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </main>
  );
}

export function OrgSwitcherScreen() {
  const { data: orgs = [] } = useOrgs();
  return <OrganizationSelectionScreen orgs={orgs} />;
}

export function ProjectsScreen() {
  const { data: organization } = useOrganization();
  const { data: projects = [] } = useProjects();
  const columns = useMemo<ColumnDef<Project>[]>(
    () => [
      {
        header: "Project",
        accessorKey: "name",
        cell: ({ row }) => (
          <div className="col gap-4">
            <span className="t-mono">{row.original.name}</span>
            <span className="t-tiny t-mute">{row.original.description}</span>
          </div>
        ),
      },
      { header: "Artifacts", accessorKey: "artifactCount" },
      { header: "Members", accessorKey: "members" },
      {
        header: "Last active",
        accessorKey: "lastActive",
        cell: ({ row }) => <span className="t-mono t-mute">{relTime(row.original.lastActive)}</span>,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        right={<Button href="/projects/new" icon={Plus} size="sm" variant="primary">New project</Button>}
        slashLabel={`organization / ${organization?.slug ?? "current"}`}
        slashNum={1}
        sub="Projects are the tenant-scoped container for artifacts, members, tokens, quotas, and audit events."
        title="Projects"
      />
      <div className="metric-grid">
        <Metric label="projects" sub="active" value={projects.length} />
        <Metric label="artifacts" sub="linked" value={projects.reduce((sum, project) => sum + project.artifactCount, 0)} />
        <Metric label="memberships" sub="project access" value={projects.reduce((sum, project) => sum + project.members, 0)} />
        <Metric label="plan" mono sub="current" value={organization?.plan ?? "-"} />
      </div>
      {projects.length === 0 ? (
        <Card>
          <CardBody className="row-between gap-16">
            <div className="col gap-4">
              <div className="t-h3">No projects yet.</div>
              <div className="t-mono t-tiny t-mute">Create the first persisted project for this organization.</div>
            </div>
            <Button href="/projects/new" icon={Plus} variant="primary">New project</Button>
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader right={<Button icon={ArrowUpRight} size="sm">Import artifact</Button>}>
          <SlashMark label="project inventory" num={2} />
        </CardHeader>
        <CardBody flush>
          <DataTable columns={columns} data={projects} empty="No projects yet." getRowHref={(project) => `/p/${project.id}`} />
        </CardBody>
      </Card>
    </>
  );
}

export function NewProjectScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: organization } = useOrganization();
  const mutation = useCreateProject();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const form = useForm({
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      defaultVisibility: "private" as Visibility,
    },
    onSubmit: async ({ value }) => {
      const nextFieldErrors: Record<string, string> = {};
      const name = value.name.trim();
      if (!name) nextFieldErrors.name = "Name is required.";
      if (!value.slug) nextFieldErrors.slug = "This slug is unavailable.";

      if (Object.keys(nextFieldErrors).length > 0) {
        setFieldErrors(nextFieldErrors);
        setFormError(null);
        return;
      }

      setFieldErrors({});
      setFormError(null);

      try {
        const result = await mutation.mutateAsync({
          name,
          slug: value.slug,
          description: value.description.trim() || null,
          defaultVisibility: value.defaultVisibility,
          createDefaultPageSite: true,
        });

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["console", "organization"] }),
          queryClient.invalidateQueries({ queryKey: ["console", "projects"] }),
        ]);
        router.push(result.redirectTo);
        router.refresh();
      } catch (error) {
        if (error instanceof ConsoleApiClientError) {
          setFieldErrors(error.payload.fieldErrors ?? {});
          setFormError(apiErrorMessage(error.payload.error));
          return;
        }
        setFormError("Project creation failed.");
      }
    },
  });

  return (
    <>
      <PageHeader
        right={<Button href="/projects" icon={ArrowLeft} size="sm">Projects</Button>}
        slashLabel="projects / new"
        slashNum={1}
        sub="Create the tenant-scoped container for artifacts, members, tokens, quotas, and audit events."
        title="New project"
      />
      <div className="grid grid-2">
        <Card>
          <CardHeader>
            <SlashMark label="project" num={1} />
          </CardHeader>
          <CardBody>
            <form
              className="col gap-16"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
              <form.Field name="name">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Name</label>
                    <input
                      className="input"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        const nextName = event.target.value;
                        field.handleChange(nextName);
                        setFieldErrors((current) => ({ ...current, name: "" }));
                        if (!slugEdited) {
                          form.setFieldValue("slug", suggestConsoleSlug(nextName));
                        }
                      }}
                      value={field.state.value}
                    />
                    {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="slug">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Slug</label>
                    <input
                      className="input t-mono"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        setSlugEdited(true);
                        setFieldErrors((current) => ({ ...current, slug: "" }));
                        field.handleChange(event.target.value);
                      }}
                      value={field.state.value}
                    />
                    {organization?.slug && field.state.value ? (
                      <span className="t-mono t-tiny t-mute">
                        {organization.slug}-{field.state.value}.ravi.page
                      </span>
                    ) : null}
                    {fieldErrors.slug ? <span className="field-error">{fieldErrors.slug}</span> : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="description">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Description</label>
                    <textarea
                      className="textarea"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      rows={4}
                      value={field.state.value}
                    />
                    {fieldErrors.description ? <span className="field-error">{fieldErrors.description}</span> : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="defaultVisibility">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Default visibility</label>
                    <select
                      className="select"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value as Visibility)}
                      value={field.state.value}
                    >
                      <option value="private">private</option>
                      <option value="public">public</option>
                      <option value="protected_link">protected link</option>
                    </select>
                    {fieldErrors.defaultVisibility ? <span className="field-error">{fieldErrors.defaultVisibility}</span> : null}
                  </div>
                )}
              </form.Field>
              <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                <Button href="/projects" variant="ghost">Cancel</Button>
                <Button disabled={mutation.isPending} icon={Check} type="submit" variant="primary">
                  {mutation.isPending ? "Creating" : "Create project"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function ProjectOverviewScreen({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const { data: artifacts = [] } = useArtifacts(projectId);
  const { data: sites = [] } = usePageSites(projectId);
  const { data: publishedPages = [] } = usePublishedPages(projectId);
  const { data: events = [] } = useEvents(projectId);
  const { data: features } = useConsoleFeatures();
  const canUseGithub = consoleFeatureEnabled(features, "console.github");
  const canUseMail = consoleFeatureEnabled(features, "console.mail");
  const canUseRuns = consoleFeatureEnabled(features, "console.runtime_runs");
  const runsQuery = useRuntimeRuns(projectId, { enabled: canUseRuns });
  const { data: mailOverview } = useMailOverview(projectId, { enabled: canUseMail });
  const { data: githubConfig } = useProjectGithubApp(projectId, { enabled: canUseGithub });

  if (project === undefined) return <LoadingState label="Loading project" />;
  if (project === null) return <NotFound />;

  const visiblePublishedPages = publishedPages.slice(0, 6);
  const liveHosts = sites.filter((site) => site.status === "active" && site.activeReleaseId).length;
  const draftOrInactiveHosts = sites.length - liveHosts;
  const pagesStatus = sites.length === 0 ? "idle" : draftOrInactiveHosts > 0 ? "warn" : "active";
  const runs = runsQuery.data?.runs ?? [];
  const activeRuns = runs.filter((run) => isActiveRunStatus(run.status)).length;
  const problemRuns = runs.filter(isProblemRun);
  const visibleRuns = [...runs].sort(projectRunSort).slice(0, 4);
  const recentArtifacts = artifacts.slice(0, 5);
  const mailboxes = mailOverview?.mailboxes ?? [];
  const githubConnections = githubConfig?.connections ?? [];
  const githubNeedsAttention = githubConnections.some((connection) => connection.requiresReauth || connection.status !== "active");
  const attentionItems = [
    draftOrInactiveHosts > 0 ? `${draftOrInactiveHosts} Pages host${draftOrInactiveHosts === 1 ? "" : "s"} without an active serving state.` : null,
    problemRuns.length > 0 ? `${problemRuns.length} runtime run${problemRuns.length === 1 ? "" : "s"} with errors or degraded status.` : null,
    githubNeedsAttention ? "GitHub connection needs review." : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <>
      <PageHeader
        right={
          <>
            <Button href={`/p/${projectId}/pages`} icon={Globe2} size="sm">Pages</Button>
            {canUseRuns ? <Button href={`/p/${projectId}/runs`} icon={Terminal} size="sm">Runs</Button> : null}
            <Button href={`/p/${projectId}/settings`} size="sm" variant="ghost">Settings</Button>
          </>
        }
        slashLabel={`project / ${project.name}`}
        slashNum={1}
        sub={project.description || "Project workspace for published surfaces, artifacts, runtime work, integrations, and audit."}
        title={project.name}
      />
      <div className="metric-grid">
        <Metric label="live pages" sub="published urls" value={publishedPages.length} />
        <Metric label="attention" sub="needs review" value={attentionItems.length} />
        <Metric label="artifacts" sub="recent source" value={project.artifactCount} />
        <Metric label="last active" mono sub="ago" value={relTime(project.lastActive)} />
      </div>
      <div className="project-overview-grid">
        <Card className="grid-span-2">
          <CardHeader right={<Link className="t-mono t-small t-mute" href={`/p/${projectId}/pages`}>manage Pages</Link>}>
            <SlashMark label="live surfaces" num={1} />
          </CardHeader>
          <CardBody flush>
            {publishedPages.length === 0 ? (
              <div className="empty project-empty-action">
                <div>No published pages yet.</div>
                <Button href={`/p/${projectId}/pages`} icon={Globe2} size="sm">Open Pages</Button>
              </div>
            ) : (
              <>
                <PublishedPageUrlTable pages={visiblePublishedPages} />
                {publishedPages.length > visiblePublishedPages.length ? (
                  <div className="project-more-row">
                    <Link className="t-mono t-small t-mute" href={`/p/${projectId}/pages`}>
                      View {publishedPages.length - visiblePublishedPages.length} more published URLs
                    </Link>
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader right={canUseRuns ? <Link className="t-mono t-small t-mute" href={`/p/${projectId}/runs`}>open runs</Link> : undefined}>
            <SlashMark label="current work" num={2} />
          </CardHeader>
          <CardBody flush>
            {!canUseRuns ? <div className="empty">Runtime runs are not enabled for this organization.</div> : null}
            {canUseRuns && visibleRuns.length === 0 ? <div className="empty">No runtime work captured yet.</div> : null}
            {canUseRuns
              ? visibleRuns.map((run, index) => (
                  <ProjectRunPreviewRow href={`/p/${projectId}/runs`} isLast={index === visibleRuns.length - 1} key={run.id} run={run} />
                ))
              : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="operations" num={3} />
          </CardHeader>
          <CardBody flush>
            <ProjectSignalRow
              href={`/p/${projectId}/pages`}
              icon={Globe2}
              label="Pages"
              status={pagesStatus}
              sub={`${liveHosts} live hosts · ${sites.length} total hosts`}
              value={`${publishedPages.length} URLs`}
            />
            <ProjectSignalRow
              href={canUseRuns ? `/p/${projectId}/runs` : undefined}
              icon={Terminal}
              label="Runtime"
              status={problemRuns.length ? "err" : activeRuns ? "active" : runs.length ? "ready" : "idle"}
              sub={canUseRuns ? `${activeRuns} active · ${problemRuns.length} issues` : "feature unavailable"}
              value={canUseRuns ? `${runs.length} runs` : "disabled"}
            />
            <ProjectSignalRow
              href={canUseMail ? `/p/${projectId}/mail` : undefined}
              icon={Mail}
              label="Mail"
              status={mailboxes.length ? "active" : "idle"}
              sub={canUseMail ? "project-scoped mailboxes" : "feature unavailable"}
              value={canUseMail ? `${mailboxes.length} mailboxes` : "disabled"}
            />
            <ProjectSignalRow
              href={canUseGithub ? `/p/${projectId}/github` : undefined}
              icon={GitBranch}
              isLast
              label="GitHub"
              status={githubNeedsAttention ? "warn" : githubConnections.length ? "active" : "idle"}
              sub={canUseGithub ? "source connection" : "feature unavailable"}
              value={canUseGithub ? `${githubConnections.length} installs` : "disabled"}
            />
          </CardBody>
        </Card>
        {attentionItems.length > 0 ? (
          <Card className="grid-span-2">
            <CardHeader>
              <SlashMark label="attention" num={4} />
            </CardHeader>
            <CardBody>
              <div className="project-attention-list">
                {attentionItems.map((item) => (
                  <div className="project-attention-row" key={item}>
                    <AlertTriangle size={14} />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader right={<Link className="t-mono t-small t-mute" href={`/p/${projectId}/artifacts`}>view all</Link>}>
            <SlashMark label="recent artifacts" num={attentionItems.length > 0 ? 5 : 4} />
          </CardHeader>
          <CardBody flush>
            {recentArtifacts.length === 0 ? <div className="empty">No artifacts yet.</div> : null}
            {recentArtifacts.map((artifact, index) => (
              <ProjectArtifactPreviewRow
                artifact={artifact}
                href={`/p/${projectId}/artifacts/${artifact.id}`}
                isLast={index === recentArtifacts.length - 1}
                key={artifact.id}
              />
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader right={<Link className="t-mono t-small t-mute" href={`/p/${projectId}/audit`}>view all</Link>}>
            <SlashMark label="recent activity" num={attentionItems.length > 0 ? 6 : 5} />
          </CardHeader>
          <CardBody flush>
            <VirtualEventList events={events.slice(0, 10)} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function KnowledgeScreen({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: project } = useProject(projectId);
  const { data: sources = [], isFetching } = useKnowledgeSources(projectId);
  const createSource = useCreateKnowledgeSource(projectId);
  const deleteSource = useDeleteKnowledgeSource(projectId);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const effectiveSourceId = selectedSourceId ?? sources[0]?.id ?? null;
  const selectedSource = sources.find((source) => source.id === effectiveSourceId) ?? sources[0] ?? null;
  const createIngestion = useCreateKnowledgeIngestion(projectId, effectiveSourceId ?? "");
  const createRetrieval = useCreateKnowledgeRetrieval(projectId);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceDescription, setSourceDescription] = useState("");
  const [sourceType, setSourceType] = useState<KnowledgeSourceType>("manual_note");
  const [sourceSensitivity, setSourceSensitivity] = useState<KnowledgeSensitivity>("standard");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestContent, setIngestContent] = useState("");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [lastIngestion, setLastIngestion] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [retrievalResult, setRetrievalResult] = useState<KnowledgeRetrievalResult | null>(null);

  if (project === undefined) return <LoadingState label="Loading Knowledge" />;
  if (project === null) return <NotFound />;

  const activeSources = sources.filter((source) => source.status === "active");
  const totalDocuments = sources.reduce((sum, source) => sum + source.documentCount, 0);
  const totalChunks = sources.reduce((sum, source) => sum + source.chunkCount, 0);
  const attentionSources = sources.filter(
    (source) => source.status !== "active" || source.sensitivity !== "standard" || source.raw.status === "pending",
  );
  const selectedSourceIsActive = selectedSource?.status === "active";

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = sourceTitle.trim();
    if (!title) {
      setSourceError("Source title is required.");
      return;
    }
    setSourceError(null);
    try {
      const source = await createSource.mutateAsync({
        title,
        description: sourceDescription.trim() || null,
        sensitivity: sourceSensitivity,
        sourceType,
      });
      setSelectedSourceId(source.id);
      setSourceTitle("");
      setSourceDescription("");
      setSourceType("manual_note");
      setSourceSensitivity("standard");
      await queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "knowledge", "sources"] });
    } catch (error) {
      setSourceError(error instanceof ConsoleApiClientError ? knowledgeApiErrorMessage(error.payload.error) : "Source creation failed.");
    }
  }

  async function deleteSelectedSource() {
    if (!selectedSource || deleteSource.isPending) return;
    setSourceError(null);
    try {
      await deleteSource.mutateAsync(selectedSource.id);
      setSelectedSourceId(null);
      setRetrievalResult(null);
      await queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "knowledge", "sources"] });
    } catch (error) {
      setSourceError(error instanceof ConsoleApiClientError ? knowledgeApiErrorMessage(error.payload.error) : "Source delete failed.");
    }
  }

  async function submitIngestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSource) {
      setIngestError("Create or select a source first.");
      return;
    }
    if (!selectedSourceIsActive) {
      setIngestError("Select an active source first.");
      return;
    }
    if (!ingestContent.trim()) {
      setIngestError("Content is required.");
      return;
    }
    setIngestError(null);
    try {
      const result = await createIngestion.mutateAsync({
        content: ingestContent,
        title: ingestTitle.trim() || selectedSource.title,
        mimeType: "text/markdown",
      });
      setLastIngestion(`${result.chunkCount} chunks / ${shortHash(result.document.contentHash)}`);
      setIngestTitle("");
      setIngestContent("");
      await queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "knowledge", "sources"] });
    } catch (error) {
      setIngestError(error instanceof ConsoleApiClientError ? knowledgeApiErrorMessage(error.payload.error) : "Ingestion failed.");
    }
  }

  async function submitRetrieval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) {
      setRetrievalError("Query is required.");
      return;
    }
    setRetrievalError(null);
    try {
      const result = await createRetrieval.mutateAsync({
        query,
        limit: 8,
        sourceIds: selectedSourceIsActive ? [selectedSource.id] : undefined,
        strategyKey: "default",
      });
      setRetrievalResult(result);
    } catch (error) {
      setRetrievalError(error instanceof ConsoleApiClientError ? knowledgeApiErrorMessage(error.payload.error) : "Retrieval failed.");
    }
  }

  return (
    <>
      <PageHeader
        right={
          <>
            <Button href={`/p/${projectId}/runs`} icon={Terminal} size="sm">Runs</Button>
            <Button href={`/p/${projectId}`} icon={ArrowLeft} size="sm">Project</Button>
          </>
        }
        slashLabel={`project / ${project.name}`}
        slashNum={2}
        sub="Governed project memory: source registry, ingestion, permission snapshots, and retrieval citations."
        title="Knowledge"
      />
      <div className="metric-grid">
        <Metric label="sources" sub="enrolled" value={sources.length} />
        <Metric label="active" sub="retrievable" value={activeSources.length} />
        <Metric label="documents" sub="canonical" value={totalDocuments} />
        <Metric label="chunks" sub="indexed" value={totalChunks} />
        <Metric label="attention" sub="status/governance" value={attentionSources.length} />
      </div>
      <div className="grid grid-2">
        <Card className="grid-span-2">
          <CardHeader
            right={
              <div className="row gap-8">
                {isFetching ? <Tag tone="info">refreshing</Tag> : null}
                <Tag>{sources.length} sources</Tag>
              </div>
            }
          >
            <SlashMark label="source registry" num={1} />
          </CardHeader>
          <CardBody flush>
            <div className="compact-list">
              {sources.length === 0 ? <div className="compact-empty">No knowledge sources yet.</div> : null}
              {sources.map((source) => (
                <KnowledgeSourceRegistryRow
                  isSelected={source.id === selectedSource?.id}
                  key={source.id}
                  onSelect={() => setSelectedSourceId(source.id)}
                  source={source}
                />
              ))}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            right={selectedSource ? <Tag tone={knowledgeSourceStatusTone(selectedSource.status)}>{selectedSource.status}</Tag> : null}
          >
            <SlashMark label="selected source" num={2} />
          </CardHeader>
          <CardBody>
            {!selectedSource ? (
              <div className="empty">Select or create a source to inspect governance.</div>
            ) : (
              <div className="col gap-16">
                {sourceError ? <div className="form-banner form-banner--err">{sourceError}</div> : null}
                <div className="col gap-8">
                  <div className="row-between gap-12">
                    <div className="col gap-4 truncate">
                      <span className="t-mono truncate">{selectedSource.title}</span>
                      <span className="t-small t-mute">{selectedSource.description ?? knowledgeSourceTypeLabel(selectedSource.sourceType)}</span>
                    </div>
                    <Tag tone={knowledgeSensitivityTone(selectedSource.sensitivity)}>{selectedSource.sensitivity}</Tag>
                  </div>
                  <div className="row gap-8" style={{ flexWrap: "wrap" }}>
                    <Tag>{knowledgeSourceTypeLabel(selectedSource.sourceType)}</Tag>
                    <Tag>{selectedSource.access.scope}</Tag>
                    <Tag>{knowledgeAllowedConsumersLabel(selectedSource)}</Tag>
                  </div>
                </div>
                <div className="grid grid-2" style={{ gap: 10 }}>
                  <KnowledgeMeta label="documents" value={String(selectedSource.documentCount)} />
                  <KnowledgeMeta label="chunks" value={String(selectedSource.chunkCount)} />
                  <KnowledgeMeta label="raw" value={`${selectedSource.raw.status} / ${selectedSource.raw.storageBackend}`} />
                  <KnowledgeMeta label="stored" value={formatKnowledgeSize(selectedSource.raw.sizeBytes)} />
                  <KnowledgeMeta label="hash" value={shortHash(selectedSource.raw.sha256)} />
                  <KnowledgeMeta label="updated" value={relTime(selectedSource.updatedAt)} />
                </div>
                <div className="row gap-8" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <Button
                    disabled={!selectedSourceIsActive || createRetrieval.isPending}
                    icon={Search}
                    onClick={() => {
                      setQuery(selectedSource.title);
                    }}
                    size="sm"
                  >
                    Use as query
                  </Button>
                  <Button
                    disabled={deleteSource.isPending}
                    icon={Trash2}
                    onClick={() => {
                      void deleteSelectedSource();
                    }}
                    size="sm"
                    variant="danger"
                  >
                    {deleteSource.isPending ? "Deleting" : "Delete"}
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="new source" num={3} />
          </CardHeader>
          <CardBody>
            <form className="col gap-16" onSubmit={submitSource}>
              {sourceError ? <div className="form-banner form-banner--err">{sourceError}</div> : null}
              <div className="field">
                <label htmlFor="knowledge-source-title">Title</label>
                <input
                  className="input"
                  id="knowledge-source-title"
                  onChange={(event) => setSourceTitle(event.target.value)}
                  placeholder="Product docs"
                  value={sourceTitle}
                />
              </div>
              <div className="field">
                <label htmlFor="knowledge-source-description">Description</label>
                <input
                  className="input"
                  id="knowledge-source-description"
                  onChange={(event) => setSourceDescription(event.target.value)}
                  placeholder="What this source contains"
                  value={sourceDescription}
                />
              </div>
              <div className="field">
                <label htmlFor="knowledge-source-type">Type</label>
                <select
                  className="select"
                  id="knowledge-source-type"
                  onChange={(event) => setSourceType(event.target.value as KnowledgeSourceType)}
                  value={sourceType}
                >
                  <option value="manual_note">manual note</option>
                  <option value="meeting">meeting transcript</option>
                  <option value="artifact">artifact</option>
                  <option value="file_upload">file upload</option>
                  <option value="provider_resource">provider resource</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="knowledge-source-sensitivity">Sensitivity</label>
                <select
                  className="select"
                  id="knowledge-source-sensitivity"
                  onChange={(event) => setSourceSensitivity(event.target.value as KnowledgeSensitivity)}
                  value={sourceSensitivity}
                >
                  <option value="standard">standard</option>
                  <option value="confidential">confidential</option>
                  <option value="restricted">restricted</option>
                </select>
              </div>
              <Button disabled={createSource.isPending} icon={Plus} type="submit" variant="primary">
                {createSource.isPending ? "Creating" : "Create source"}
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader right={selectedSource ? <Tag>{selectedSource.title}</Tag> : null}>
            <SlashMark label="ingest text" num={4} />
          </CardHeader>
          <CardBody>
            <form className="col gap-16" onSubmit={submitIngestion}>
              {ingestError ? <div className="form-banner form-banner--err">{ingestError}</div> : null}
              {lastIngestion ? <div className="form-banner">{lastIngestion}</div> : null}
              <div className="field">
                <label htmlFor="knowledge-ingest-title">Document title</label>
                <input
                  className="input"
                  id="knowledge-ingest-title"
                  onChange={(event) => setIngestTitle(event.target.value)}
                  placeholder={selectedSource?.title ?? "Document"}
                  value={ingestTitle}
                />
              </div>
              <div className="field">
                <label htmlFor="knowledge-ingest-content">Markdown or text</label>
                <textarea
                  className="textarea"
                  id="knowledge-ingest-content"
                  onChange={(event) => setIngestContent(event.target.value)}
                  placeholder="Paste Markdown or plain text."
                  rows={9}
                  value={ingestContent}
                />
              </div>
              <Button disabled={createIngestion.isPending || !selectedSourceIsActive} icon={Plus} type="submit" variant="primary">
                {createIngestion.isPending ? "Ingesting" : "Ingest document"}
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader right={retrievalResult ? <Tag tone="info">{retrievalResult.citations.length} citations</Tag> : null}>
            <SlashMark label="retrieval test" num={5} />
          </CardHeader>
          <CardBody>
            <form className="col gap-16" onSubmit={submitRetrieval}>
              {retrievalError ? <div className="form-banner form-banner--err">{retrievalError}</div> : null}
              <div className="field">
                <label htmlFor="knowledge-query">Query</label>
                <input
                  className="input"
                  id="knowledge-query"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="What should Ravi remember?"
                  value={query}
                />
              </div>
              <Button disabled={createRetrieval.isPending} icon={Search} type="submit" variant="primary">
                {createRetrieval.isPending ? "Searching" : "Search knowledge"}
              </Button>
            </form>
            <div className="col gap-10" style={{ marginTop: 18 }}>
              {!retrievalResult ? <div className="empty">Run a retrieval query to inspect governed citations.</div> : null}
              {retrievalResult?.citations.map((citation) => (
                <div className="card" key={`${citation.runId}-${citation.rank}`} style={{ padding: 12 }}>
                  <div className="row-between gap-12">
                    <div className="row gap-8 truncate">
                      <Tag tone="info">#{citation.rank}</Tag>
                      <span className="t-mono truncate">{citation.sourceTitle}</span>
                      <Tag tone={knowledgeSensitivityTone(citation.sensitivity)}>{citation.sensitivity}</Tag>
                    </div>
                    <span className="t-mono t-tiny t-mute">{citation.score.toFixed(2)}</span>
                  </div>
                  <div className="t-tiny t-mute truncate" style={{ marginTop: 6 }}>{citation.documentTitle}</div>
                  <p className="t-small t-mute" style={{ margin: "8px 0 0" }}>{citation.excerpt}</p>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function KnowledgeSourceRegistryRow({
  isSelected,
  onSelect,
  source,
}: {
  isSelected: boolean;
  onSelect: () => void;
  source: KnowledgeSourceSummary;
}) {
  const needsAttention = source.status !== "active" || source.sensitivity !== "standard" || source.raw.status === "pending";

  return (
    <button
      className="compact-list-row card-hover"
      onClick={onSelect}
      style={{
        alignItems: "center",
        background: isSelected ? "var(--bg-2)" : "transparent",
        borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
        color: "inherit",
        cursor: "pointer",
        gap: 14,
        gridTemplateColumns: "minmax(0, 1fr) auto",
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      <div className="row gap-12 truncate">
        <div
          className="row"
          style={{
            alignItems: "center",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            height: 32,
            justifyContent: "center",
            width: 32,
          }}
        >
          {needsAttention ? <AlertTriangle size={14} /> : <Shield size={14} />}
        </div>
        <div className="col gap-4 truncate">
          <div className="row gap-8 truncate">
            <span className="t-mono truncate">{source.title}</span>
            <Tag tone={knowledgeSourceStatusTone(source.status)}>{source.status}</Tag>
            <Tag tone={knowledgeSensitivityTone(source.sensitivity)}>{source.sensitivity}</Tag>
          </div>
          <span className="t-tiny t-mute truncate">{source.description ?? knowledgeSourceTypeLabel(source.sourceType)}</span>
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <span className="t-tiny t-mute">{knowledgeSourceTypeLabel(source.sourceType)}</span>
            <span className="t-tiny t-mute">{knowledgeAllowedConsumersLabel(source)}</span>
            <span className="t-tiny t-mute">raw {source.raw.status}</span>
          </div>
        </div>
      </div>
      <div className="row gap-12" style={{ justifyContent: "flex-end", minWidth: 260 }}>
        <KnowledgeMeta label="docs" value={String(source.documentCount)} />
        <KnowledgeMeta label="chunks" value={String(source.chunkCount)} />
        <KnowledgeMeta label="updated" value={relTime(source.updatedAt)} />
      </div>
    </button>
  );
}

function KnowledgeMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="col gap-4" style={{ minWidth: 0 }}>
      <span className="t-tiny t-mute">{label}</span>
      <span className="t-mono t-tiny truncate">{value}</span>
    </div>
  );
}

function knowledgeSourceTypeLabel(type: KnowledgeSourceType) {
  switch (type) {
    case "manual_note":
      return "Manual note";
    case "file_upload":
      return "File upload";
    case "artifact":
      return "Artifact";
    case "meeting":
      return "Meeting";
    case "mail_thread":
      return "Mail thread";
    case "calendar_event":
      return "Calendar";
    case "github_repository":
      return "GitHub";
    case "ravi_page":
      return "Ravi Page";
    case "provider_resource":
      return "Provider resource";
    case "external_rag_collection":
      return "External RAG";
    default:
      return type;
  }
}

function knowledgeAllowedConsumersLabel(source: KnowledgeSourceSummary) {
  const consumers = source.access.allowedConsumers;
  if (consumers.length === 0) return "no consumers";
  if (consumers.length > 3) return `${consumers.slice(0, 3).join(" / ")} +${consumers.length - 3}`;
  return consumers.join(" / ");
}

function formatKnowledgeSize(sizeBytes: number | null) {
  if (sizeBytes === null) return "-";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = sizeBytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function PagesScreen({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: project } = useProject(projectId);
  const { data: sites = [] } = usePageSites(projectId);
  const { data: publishedPages = [] } = usePublishedPages(projectId);
  const { data: domainData } = useDomainClaims();
  const mutation = useCreatePageSite(projectId);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      slug: "",
      defaultVisibility: "private" as Visibility,
    },
    onSubmit: async ({ value }) => {
      if (!value.slug.trim()) {
        setFieldErrors({ slug: "This slug is unavailable." });
        return;
      }
      setFieldErrors({});
      setFormError(null);

      try {
        await mutation.mutateAsync({
          slug: suggestConsoleSlug(value.slug),
          defaultVisibility: value.defaultVisibility,
        });
        form.reset();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "pages", "sites"] }),
          queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "published-pages"] }),
        ]);
      } catch (error) {
        if (error instanceof ConsoleApiClientError) {
          setFieldErrors(error.payload.fieldErrors ?? {});
          setFormError(apiErrorMessage(error.payload.error) ?? "Site creation failed.");
          return;
        }
        setFormError("Site creation failed.");
      }
    },
  });

  if (project === undefined) return <LoadingState label="Loading Pages" />;
  if (project === null) return <NotFound />;

  const claims = domainData?.claims ?? [];
  const pageBindings = domainBindingsWithoutReplacedUnsupportedApex(
    (domainData?.bindings ?? []).filter((binding) => binding.product === "pages"),
    claims,
  );
  const connectedCustomHostnames = pageBindings.filter(domainBindingIsReady);
  const liveUrlCount = publishedPages.reduce((count, page) => count + page.urls.length, 0);

  return (
    <>
      <PageHeader
        right={
          <>
            <Button href="/org/domains" icon={Globe2} size="sm">Domains</Button>
            <Button href={`/p/${projectId}`} icon={ArrowLeft} size="sm">Project</Button>
          </>
        }
        slashLabel={`project / ${project.name}`}
        slashNum={2}
        sub="Published page URLs, host surfaces, and custom domain aliases for this project."
        title="Pages"
      />
      <div className="metric-grid">
        <Metric label="pages" sub="published URLs" value={publishedPages.length} />
        <Metric label="urls" sub="including aliases" value={liveUrlCount} />
        <Metric label="hosts" sub="ravi.page surfaces" value={sites.length} />
        <Metric label="domains" sub="connected aliases" value={connectedCustomHostnames.length} />
      </div>
      <div className="grid grid-2">
        <PagesAgentPromptCard className="grid-span-2" project={project} />
        <Card className="grid-span-2">
          <CardHeader
            right={
              <Button href={`/p/${projectId}/artifacts`} icon={ArrowUpRight} size="sm">
                Artifacts
              </Button>
            }
          >
            <SlashMark label="published pages" num={2} />
          </CardHeader>
          <CardBody flush>
            {publishedPages.length === 0 ? (
              <div className="empty">No published page URLs yet.</div>
            ) : (
              <PublishedPageUrlTable pages={publishedPages} />
            )}
          </CardBody>
        </Card>
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="hosts & domains" num={3} />
          </CardHeader>
          <CardBody>
            <div className="host-domain-grid">
              <div className="col gap-8">
                <div className="row-between gap-12">
                  <span className="t-label">hosts</span>
                  <span className="t-mono t-tiny t-mute">{sites.length} total</span>
                </div>
                <div className="compact-list">
                  {sites.length === 0 ? <div className="compact-empty">No hosts yet.</div> : null}
                  {sites.map((site) => (
                    <PageHostCompactRow href={`/p/${projectId}/pages/${site.id}`} key={site.id} site={site} />
                  ))}
                </div>
              </div>
              <div className="col gap-8">
                <div className="row-between gap-12">
                  <span className="t-label">domains</span>
                  <Button href="/org/domains" icon={ArrowUpRight} size="sm">Manage</Button>
                </div>
                <div className="compact-list">
                  {pageBindings.length === 0 ? <div className="compact-empty">No custom domains yet.</div> : null}
                  {pageBindings.map((binding) => (
                    <PageDomainCompactRow
                      binding={binding}
                      claim={claims.find((claim) => claim.id === binding.claimId) ?? null}
                      key={binding.id}
                    />
                  ))}
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="new host" num={4} />
          </CardHeader>
          <CardBody>
            <form
              className="col gap-16"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
              <form.Field name="slug">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>ravi.page host</label>
                    <input
                      className="input t-mono"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        setFieldErrors((current) => ({ ...current, slug: "" }));
                        field.handleChange(event.target.value);
                      }}
                      placeholder="demo"
                      value={field.state.value}
                    />
                    <span className="t-mono t-tiny t-mute">Creates https://slug.ravi.page. Published paths on that host appear as pages above.</span>
                    {fieldErrors.slug ? <span className="field-error">{fieldErrors.slug}</span> : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="defaultVisibility">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Default visibility</label>
                    <select
                      className="select"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value as Visibility)}
                      value={field.state.value}
                    >
                      <option value="private">private</option>
                      <option value="public">public</option>
                      <option value="protected_link">protected link</option>
                    </select>
                  </div>
                )}
              </form.Field>
              <Button disabled={mutation.isPending} icon={Plus} type="submit" variant="primary">
                {mutation.isPending ? "Creating" : "Create host"}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function PageSiteDetailScreen({ projectId, siteId }: { projectId: string; siteId: string }) {
  const { data: project } = useProject(projectId);
  const { data: site } = usePageSite(projectId, siteId);
  const { data: domainData } = useDomainClaims();

  if (project === undefined || site === undefined) return <LoadingState label="Loading Pages host" />;
  if (project === null || site === null) return <NotFound />;

  const claims = domainData?.claims ?? [];
  const siteBindings = domainBindingsWithoutReplacedUnsupportedApex(
    (domainData?.bindings ?? []).filter((binding) => binding.product === "pages" && domainBindingSiteId(binding) === site.id),
    claims,
  );

  return (
    <>
      <PageHeader
        right={
          <>
            {site.activeReleaseId ? (
              <Button href={pageOperatorOpenHref(pageRouteHref(site.defaultHostname, "/"))} icon={Globe2} size="sm" target="_blank">
                Open
              </Button>
            ) : null}
            <Button href={`/p/${projectId}/pages`} icon={ArrowLeft} size="sm">Hosts</Button>
          </>
        }
        slashLabel={`pages / ${project.name}`}
        slashNum={3}
        sub={`${site.defaultHostname} publishes from ${project.name}.`}
        title={site.slug}
      />
      <div className="metric-grid">
        <Metric label="status" sub="public surface" value={site.activeReleaseId ? "published" : "draft"} />
        <Metric label="release" mono sub="active" value={site.activeRelease ? `r${site.activeRelease.releaseNumber}` : "-"} />
        <Metric label="custom domains" sub="connected" value={siteBindings.filter(domainBindingIsReady).length} />
        <Metric label="routes" sub="active release" value={site.activeRoutes.length} />
      </div>
      <div className="grid grid-2">
        <PagesAgentPromptCard className="grid-span-2" project={project} site={site} />
        <PageSiteLiveUrlsPanel bindings={siteBindings} num={2} site={site} />
        <PageSiteCustomDomainPanel bindings={siteBindings} claims={claims} num={3} projectId={projectId} site={site} />
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="active routes" num={4} />
          </CardHeader>
          <CardBody flush>
            {site.activeRoutes.length === 0 ? <div className="empty">No active release routes yet.</div> : null}
            {site.activeRoutes.map((route) => (
              <PageRouteRow key={route.id} route={route} site={site} />
            ))}
          </CardBody>
        </Card>
        <ViewerAssertionAudiencesPanel
          defaultHostname={site.defaultHostname}
          num={5}
          projectId={projectId}
          siteId={site.id}
        />
        <Card>
          <CardHeader>
            <SlashMark label="release history" num={6} />
          </CardHeader>
          <CardBody flush>
            {site.releases.length === 0 ? <div className="empty">No releases yet.</div> : null}
            {site.releases.map((release) => (
              <PageReleaseRow
                activeReleaseId={site.activeReleaseId}
                key={release.id}
                release={release}
              />
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function PagesAgentPromptCard({ className, project, site }: { className?: string; project: Project; site?: PageSiteDetail }) {
  const prompt = pagesAgentPublishPrompt(project, site);
  return (
    <Card className={className}>
      <CardHeader
        right={
          <Button
            icon={Copy}
            onClick={() => {
              void navigator.clipboard?.writeText(prompt);
            }}
            size="sm"
          >
            Copy prompt
          </Button>
        }
      >
        <SlashMark label="publish with agent" num={1} />
      </CardHeader>
      <CardBody>
        <div className="pages-agent-prompt">
          <div className="col gap-4">
            <div className="t-h3">Publishing happens through Ravi agents.</div>
            <div className="t-small t-mute">
              Console shows live URLs, hosts, domains, paths, and release history. To publish or update content, send a prompt like this to an agent.
            </div>
          </div>
          <pre>{prompt}</pre>
        </div>
      </CardBody>
    </Card>
  );
}

function pagesAgentPublishPrompt(project: Project, site?: PageSiteDetail) {
  if (site) {
    return [
      `Ravi, publica uma página no projeto ${project.slug}, host ${site.slug} (${site.defaultHostname}).`,
      "Fonte: <pasta local ou artifact id>.",
      "Path: /",
      "Visibilidade: public | private | protected_link.",
      "Depois me devolve os links publicados e qualquer instrução de DNS/domínio se precisar.",
    ].join("\n");
  }

  return [
    `Ravi, publica uma página no projeto ${project.slug}.`,
    "Fonte: <pasta local ou artifact id>.",
    "Host: <usar existente ou criar um novo host Ravi Pages>.",
    "Path: /",
    "Visibilidade: public | private | protected_link.",
    "Depois me devolve os links publicados e qualquer instrução de DNS/domínio se precisar.",
  ].join("\n");
}

function PageSiteLiveUrlsPanel({ bindings, num = 1, site }: { bindings: DomainBindingSummary[]; num?: number; site: PageSiteDetail }) {
  return (
    <Card className="grid-span-2">
      <CardHeader
        right={
          site.activeReleaseId ? (
            <Button href={pageOperatorOpenHref(pageRouteHref(site.defaultHostname, "/"))} icon={ArrowUpRight} size="sm" target="_blank">
              Open primary
            </Button>
          ) : null
        }
      >
        <SlashMark label="live urls" num={num} />
      </CardHeader>
      <CardBody flush>
        <PageUrlRow
          href={site.activeReleaseId ? pageRouteHref(site.defaultHostname, "/") : null}
          hostname={site.defaultHostname}
          isLast={bindings.length === 0}
          label="Primary"
          status={site.activeReleaseId ? "published" : "no active release"}
          tone={site.activeReleaseId ? "ok" : "warn"}
        />
        {bindings.map((binding, index) => (
          <PageUrlRow
            href={site.activeReleaseId && domainBindingIsReady(binding) ? pageRouteHref(binding.hostname, "/") : null}
            hostname={binding.hostname}
            isLast={index === bindings.length - 1}
            key={binding.id}
            label={domainBindingIsReady(binding) ? "Custom" : "Setup"}
            status={domainBindingIsReady(binding) ? "connected" : domainReadinessLabel(binding)}
            tone={domainBindingTone(binding)}
          />
        ))}
      </CardBody>
    </Card>
  );
}

function PageSiteCustomDomainPanel({
  bindings,
  claims,
  num = 2,
  projectId,
  site,
}: {
  bindings: DomainBindingSummary[];
  claims: DomainClaimSummary[];
  num?: number;
  projectId: string;
  site: PageSiteDetail;
}) {
  const queryClient = useQueryClient();
  const createClaim = useCreateDomainClaim();
  const verifyClaim = useVerifyDomainClaim();
  const createBinding = useCreateDomainBinding();
  const checkBinding = useCheckDomainBinding();
  const [claimDomain, setClaimDomain] = useState("");
  const [hostname, setHostname] = useState("");
  const [selectedClaimId, setSelectedClaimId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const verifiedClaims = claims.filter((claim) => claim.verificationStatus === "verified");
  const selectedClaim =
    verifiedClaims.find((claim) => claim.id === selectedClaimId) ??
    verifiedClaims.find((claim) => hostnameIsUnderClaim(hostname, claim.domain)) ??
    verifiedClaims[0] ??
    null;
  const activeClaimId = selectedClaim?.id ?? "";

  async function refreshDomains() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["console", "domains"] }),
      queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "pages"] }),
      queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId, "pages", "sites", site.id] }),
    ]);
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = claimDomain.trim();
    if (!domain) return;
    setFormError(null);
    try {
      await createClaim.mutateAsync({ domain, ownershipMode: "customer_managed" });
      setClaimDomain("");
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function submitBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeClaimId || !selectedClaim) return;
    const requestedHostname = hostname.trim() || `www.${selectedClaim.domain}`;
    setFormError(null);
    try {
      await createBinding.mutateAsync({
        claimId: activeClaimId,
        hostname: requestedHostname,
        product: "pages",
        target: { siteId: site.id },
      });
      setHostname("");
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function verify(claim: DomainClaimSummary) {
    setFormError(null);
    try {
      await verifyClaim.mutateAsync(claim.id);
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function check(binding: DomainBindingSummary) {
    setFormError(null);
    try {
      await checkBinding.mutateAsync(binding.id);
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function repairApexBinding(binding: DomainBindingSummary, claim: DomainClaimSummary) {
    setFormError(null);
    try {
      await createBinding.mutateAsync({
        claimId: binding.claimId,
        hostname: recommendedPagesHostnameForClaim(claim),
        product: "pages",
        target: { siteId: site.id },
      });
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  return (
    <Card className="grid-span-2">
      <CardHeader>
        <SlashMark label="domains" num={num} />
      </CardHeader>
      <CardBody>
        <div className="col gap-16">
          {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
          <div className="grid grid-2">
            <form className="col gap-12" onSubmit={submitClaim}>
              <div className="field">
                <label htmlFor="site-domain-claim">Domain to verify</label>
                <input
                  className="input t-mono"
                  id="site-domain-claim"
                  onChange={(event) => setClaimDomain(event.target.value)}
                  placeholder="customer.com"
                  value={claimDomain}
                />
              </div>
              <Button disabled={createClaim.isPending} icon={Plus} type="submit" variant="primary">
                {createClaim.isPending ? "Adding" : "Add domain"}
              </Button>
            </form>
            <form className="col gap-12" onSubmit={submitBinding}>
              <div className="field">
                <label htmlFor="site-domain-claim-select">Verified domain</label>
                <select
                  className="select t-mono"
                  disabled={verifiedClaims.length === 0}
                  id="site-domain-claim-select"
                  onChange={(event) => setSelectedClaimId(event.target.value)}
                  value={activeClaimId}
                >
                  {verifiedClaims.length === 0 ? <option value="">no verified claims</option> : null}
                  {verifiedClaims.map((claim) => (
                    <option key={claim.id} value={claim.id}>
                      {claim.domain}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="site-domain-hostname">Custom hostname</label>
                <input
                  className="input t-mono"
                  disabled={!activeClaimId}
                  id="site-domain-hostname"
                  onChange={(event) => setHostname(event.target.value)}
                  placeholder={selectedClaim ? `www.${selectedClaim.domain}, app.${selectedClaim.domain}, or *.${selectedClaim.domain}` : "www.customer.com"}
                  value={hostname}
                />
              </div>
              <Button disabled={!activeClaimId || createBinding.isPending} icon={Globe2} type="submit" variant="primary">
                {createBinding.isPending ? "Connecting" : "Connect hostname"}
              </Button>
            </form>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="col gap-8">
              <span className="t-tiny t-mute">Ownership claims</span>
              <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                {claims.length === 0 ? <div className="empty">No domain claims yet.</div> : null}
                {claims.map((claim, index) => (
                  <DomainClaimRow
                    claim={claim}
                    isLast={index === claims.length - 1}
                    isPending={verifyClaim.isPending}
                    key={claim.id}
                    onVerify={() => void verify(claim)}
                  />
                ))}
              </div>
            </div>
            <div className="col gap-8">
              <span className="t-tiny t-mute">Hostnames for this page</span>
              <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                {bindings.length === 0 ? <div className="empty">No custom hostnames yet.</div> : null}
                {bindings.map((binding, index) => (
                  <DomainBindingRow
                    binding={binding}
                    claim={claims.find((claim) => claim.id === binding.claimId) ?? null}
                    isLast={index === bindings.length - 1}
                    isPending={checkBinding.isPending}
                    isRepairing={createBinding.isPending}
                    key={binding.id}
                    onCheck={() => void check(binding)}
                    openHref={site.activeReleaseId && domainBindingIsReady(binding) ? `https://${binding.hostname}` : undefined}
                    onRepairApex={(claim) => void repairApexBinding(binding, claim)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export function MailScreen({ projectId, scope }: { projectId?: string; scope: "organization" | "project" }) {
  const { data: project } = useProject(projectId);
  const { data: mail } = useMailOverview(projectId);
  const mailboxColumns = useMailboxColumns();
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  if (projectId && project === undefined) return <LoadingState label="Loading project mail" />;
  if (projectId && project === null) return <NotFound />;
  if (mail === undefined) return <LoadingState label="Loading inbox" />;
  if (mail === null) return <NotFound />;

  const selectedMessage = mail.messages.find((message) => message.id === selectedMessageId) ?? mail.messages[0] ?? null;
  const agentMailboxCount = mail.mailboxes.filter((mailbox) => mailbox.agentId).length;
  const systemAddress = mail.mailboxes[0]?.address ?? mail.agentAddressPattern.canonicalExample;

  return (
    <>
      <PageHeader
        right={projectId ? <Button href={`/p/${projectId}`} icon={ArrowLeft} size="sm">Project</Button> : undefined}
        slashLabel={scope === "project" ? `project / ${project?.name ?? projectId}` : "organization"}
        slashNum={scope === "project" ? 4 : 2}
        sub={scope === "project" ? "Project inbox, agent addresses, and message history." : "Organization inbox, agent addresses, and message history."}
        title="Inbox"
      />
      <div className="metric-grid">
        <Metric label="messages" sub="recent" value={mail.messages.length} />
        <Metric label="addresses" sub="active" value={mail.mailboxes.filter((mailbox) => mailbox.status === "active").length} />
        <Metric label="agent addresses" sub="linked" value={agentMailboxCount} />
        <Metric label="system address" sub="default" value={systemAddress.split("@")[0] ?? "-"} />
      </div>
      <div className="grid grid-2">
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="inbox" num={1} />
          </CardHeader>
          <CardBody flush>
            <MailInbox
              mailboxes={mail.mailboxes}
              messages={mail.messages}
              onSelect={setSelectedMessageId}
              selectedMessage={selectedMessage}
            />
          </CardBody>
        </Card>
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="addresses" num={2} />
          </CardHeader>
          <CardBody flush>
            <DataTable columns={mailboxColumns} data={mail.mailboxes} empty="No addresses yet." />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function DomainsScreen() {
  const { data } = useDomainClaims();
  const queryClient = useQueryClient();
  const createClaim = useCreateDomainClaim();
  const verifyClaim = useVerifyDomainClaim();
  const createBinding = useCreateDomainBinding();
  const checkBinding = useCheckDomainBinding();
  const [claimDomain, setClaimDomain] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const claims = data?.claims ?? [];
  const bindings = data?.bindings ?? [];
  const pagesBindings = domainBindingsWithoutReplacedUnsupportedApex(
    bindings.filter((binding) => binding.product === "pages"),
    claims,
  );
  const verifiedClaims = claims.filter((claim) => claim.verificationStatus === "verified").length;
  const activeBindings = pagesBindings.filter((binding) => binding.status === "active").length;
  const pendingBindings = pagesBindings.filter((binding) => binding.status === "pending").length;
  const pendingChecks =
    claims.filter((claim) => claim.verificationStatus !== "verified").length +
    pendingBindings;

  async function refreshDomains() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["console", "domains"] }),
    ]);
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = claimDomain.trim();
    if (!domain) return;
    setFormError(null);
    try {
      await createClaim.mutateAsync({ domain, ownershipMode: "customer_managed" });
      setClaimDomain("");
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function verify(claim: DomainClaimSummary) {
    setFormError(null);
    try {
      await verifyClaim.mutateAsync(claim.id);
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function check(binding: DomainBindingSummary) {
    setFormError(null);
    try {
      await checkBinding.mutateAsync(binding.id);
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  async function repairApexBinding(binding: DomainBindingSummary, claim: DomainClaimSummary) {
    const siteId = domainBindingSiteId(binding);
    if (!siteId) {
      setFormError("Open the target Page and add the www hostname from there.");
      return;
    }
    setFormError(null);
    try {
      await createBinding.mutateAsync({
        claimId: binding.claimId,
        hostname: recommendedPagesHostnameForClaim(claim),
        product: "pages",
        target: { siteId },
      });
      await refreshDomains();
    } catch (error) {
      setFormError(domainApiErrorMessage(error));
    }
  }

  return (
    <>
      <PageHeader
        right={
          <Button disabled={checkBinding.isPending || verifyClaim.isPending} icon={RefreshCw} onClick={() => void refreshDomains()} size="sm">
            Refresh
          </Button>
        }
        slashLabel="organization"
        slashNum={2}
        sub="Organization-owned domain claims and Ravi Pages custom hostname readiness."
        title="Domains"
      />
      <div className="metric-grid">
        <Metric label="claims" sub="verified" value={verifiedClaims} />
        <Metric label="pages" sub="active" value={activeBindings} />
        <Metric label="pages" sub="pending" value={pendingBindings} />
        <Metric label="checks" sub="pending" value={pendingChecks} />
      </div>
      {formError ? <div className="form-banner form-banner--err" style={{ marginBottom: 16 }}>{formError}</div> : null}
      <div className="grid grid-2">
        <Card>
          <CardHeader>
            <SlashMark label="claim ownership" num={1} />
          </CardHeader>
          <CardBody>
            <form className="col gap-12" onSubmit={submitClaim}>
              <div className="field">
                <label htmlFor="domain-claim">Root domain or delegated subdomain</label>
                <input
                  className="input t-mono"
                  id="domain-claim"
                  onChange={(event) => setClaimDomain(event.target.value)}
                  placeholder="customer.com"
                  value={claimDomain}
                />
              </div>
              <Button disabled={createClaim.isPending} icon={Plus} type="submit" variant="primary">
                {createClaim.isPending ? "Creating" : "Create claim"}
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="product bindings" num={2} />
          </CardHeader>
          <CardBody flush>
            {pagesBindings.length === 0 ? <div className="empty">No Pages bindings yet.</div> : null}
            {pagesBindings.map((binding, index) => (
              <DomainBindingRow
                binding={binding}
                claim={claims.find((claim) => claim.id === binding.claimId) ?? null}
                isLast={index === pagesBindings.length - 1}
                isPending={checkBinding.isPending}
                isRepairing={createBinding.isPending}
                key={binding.id}
                onCheck={() => void check(binding)}
                onRepairApex={(claim) => void repairApexBinding(binding, claim)}
              />
            ))}
          </CardBody>
        </Card>
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="ownership claims" num={3} />
          </CardHeader>
          <CardBody flush>
            {claims.length === 0 ? <div className="empty">No domain claims yet.</div> : null}
            {claims.map((claim, index) => (
              <DomainClaimRow
                claim={claim}
                isLast={index === claims.length - 1}
                isPending={verifyClaim.isPending}
                key={claim.id}
                onVerify={() => void verify(claim)}
              />
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function DomainClaimRow({
  claim,
  isLast,
  isPending,
  onVerify,
}: {
  claim: DomainClaimSummary;
  isLast: boolean;
  isPending: boolean;
  onVerify: () => void;
}) {
  const expected = claim.verification.expected;
  const isVerified = claim.verificationStatus === "verified";

  return (
    <div
      className="row-between gap-16"
      style={{ borderBottom: isLast ? 0 : "1px solid var(--line)", padding: "14px 18px" }}
    >
      <div className="row gap-12 grow" style={{ minWidth: 0 }}>
        <Globe2 size={15} style={{ color: "var(--mute)", flex: "none" }} />
        <div className="col gap-8 grow" style={{ minWidth: 0 }}>
          <div className="row gap-8">
            <span className="t-mono truncate">{claim.domain}</span>
            <Tag tone={domainClaimTone(claim)}>{claim.verificationStatus}</Tag>
            <Tag>{claim.ownershipMode}</Tag>
          </div>
          {!isVerified && expected?.name && expected.value ? (
            <div className="grid grid-2" style={{ gap: 8 }}>
              <DnsValue label={expected.type ?? "TXT"} value={expected.name} />
              <DnsValue label="value" value={expected.value} />
            </div>
          ) : (
            <span className="t-mono t-tiny t-mute truncate">{domainVerificationLabel(claim)}</span>
          )}
        </div>
      </div>
      {isVerified ? (
        <Tag tone="ok">Verified</Tag>
      ) : (
        <Button disabled={isPending} icon={RefreshCw} onClick={onVerify} size="sm">
          Verify
        </Button>
      )}
    </div>
  );
}

function DomainBindingRow({
  binding,
  claim,
  isLast,
  isPending,
  isRepairing,
  onCheck,
  openHref,
  onRepairApex,
}: {
  binding: DomainBindingSummary;
  claim?: DomainClaimSummary | null;
  isLast: boolean;
  isPending: boolean;
  isRepairing?: boolean;
  onCheck: () => void;
  openHref?: string;
  onRepairApex?: (claim: DomainClaimSummary) => void;
}) {
  const dnsRecords = domainBindingDnsRecords(binding, claim);
  const apexUnsupported = isUnsupportedApexPagesBinding(binding, claim);
  const isReady = domainBindingIsReady(binding);
  const repairHostname = claim ? recommendedPagesHostnameForClaim(claim) : null;
  const repairRecord = repairHostname ? { name: repairHostname, type: "CNAME", value: "cname.ravi.page" } : null;

  return (
    <div
      className="row-between gap-16"
      style={{ borderBottom: isLast ? 0 : "1px solid var(--line)", padding: "14px 18px" }}
    >
      <div className="row gap-12 grow" style={{ minWidth: 0 }}>
        <Globe2 size={15} style={{ color: "var(--mute)", flex: "none" }} />
        <div className="col gap-4 grow" style={{ minWidth: 0 }}>
          <div className="row gap-8">
            <Tag tone="info">{binding.product}</Tag>
            <span className="t-mono truncate">{binding.hostname}</span>
            {isReady ? null : (
              <Tag tone={domainBindingTone(binding, claim)}>{domainBindingDisplayStatus(binding, claim)}</Tag>
            )}
          </div>
          {isReady ? null : (
            <span className="t-mono t-tiny t-mute truncate">{domainReadinessLabel(binding, claim)}</span>
          )}
          {apexUnsupported && repairRecord ? (
            <div className="col gap-8">
              <InstructionLine num={1} text={`Create ${repairRecord.name} for this Page.`} />
              <InstructionLine num={2} text="Add this DNS record at your provider." />
              <DnsRecordValue record={repairRecord} />
              <InstructionLine num={3} text="Return here and check readiness after DNS propagates." />
            </div>
          ) : dnsRecords.length > 0 ? (
            <div className="col gap-8">
              {dnsRecords.map((record) => (
                <DnsRecordValue key={`${record.type}:${record.name}:${record.value}`} record={record} />
              ))}
              <InstructionLine num={1} text="Add the DNS record above, then click Check." />
            </div>
          ) : null}
        </div>
      </div>
      {apexUnsupported && claim && onRepairApex ? (
        <Button
          disabled={isRepairing}
          icon={Plus}
          onClick={() => onRepairApex(claim)}
          size="sm"
          title={repairHostname ? `Create ${repairHostname}` : "Create replacement hostname"}
          variant="primary"
        >
          {isRepairing ? "Creating" : "Create www"}
        </Button>
      ) : apexUnsupported ? (
        <Tag tone="err">Unsupported</Tag>
      ) : isReady && openHref ? (
        <Button href={openHref} icon={ArrowUpRight} size="sm" target="_blank">
          Open
        </Button>
      ) : isReady ? null : (
        <Button disabled={isPending} icon={RefreshCw} onClick={onCheck} size="sm">
          Check
        </Button>
      )}
    </div>
  );
}

function InstructionLine({ num, text }: { num: number; text: string }) {
  return (
    <div className="row gap-8 t-tiny t-mute" style={{ alignItems: "center" }}>
      <span className="t-mono" style={{ color: "var(--text)", width: 14 }}>
        {num}.
      </span>
      <span>{text}</span>
    </div>
  );
}

function DnsRecordValue({ record }: { record: { name: string; type: string; value: string } }) {
  return (
    <div
      className="grid grid-2"
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        gap: 8,
        padding: 10,
      }}
    >
      <DnsValue label="type" value={record.type} />
      <DnsValue label="name" value={record.name} />
      <div className="grid-span-2">
        <DnsValue label="value" value={record.value} />
      </div>
    </div>
  );
}

function DnsValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="col gap-4" style={{ minWidth: 0 }}>
      <span className="t-tiny t-mute">{label}</span>
      <span className="t-mono t-tiny" style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
        {value}
      </span>
    </div>
  );
}

export function ArtifactsScreen({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const { data: artifacts = [] } = useArtifacts(projectId);
  const columns = useArtifactColumns();

  if (project === undefined) return <LoadingState label="Loading project artifacts" />;
  if (project === null) return <NotFound />;

  return (
    <>
      <PageHeader
        right={<Button icon={Plus} size="sm" variant="primary">New artifact</Button>}
        slashLabel={`project / ${project.name}`}
        slashNum={2}
        sub="Each artifact keeps immutable versions, visibility, metadata, and sync lineage."
        title="Artifacts"
      />
      <Card>
        <CardHeader>
          <SlashMark label="artifact inventory" num={1} />
        </CardHeader>
        <CardBody flush>
          <DataTable columns={columns} data={artifacts} getRowHref={(artifact) => `/p/${projectId}/artifacts/${artifact.id}`} />
        </CardBody>
      </Card>
    </>
  );
}

export function ArtifactDetailScreen({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const { data: artifact } = useArtifact(artifactId);
  const { data: versions = [] } = useArtifactVersions(artifactId);
  const { data: project } = useProject(projectId);

  if (artifact === undefined || project === undefined) return <LoadingState label="Loading artifact" />;
  if (artifact === null || project === null) return <NotFound />;

  return (
    <>
      <PageHeader
        right={
          <>
            <Button icon={Plus} size="sm" variant="primary">New version</Button>
          </>
        }
        slashLabel={`artifact / ${project.name}`}
        slashNum={3}
        sub={artifact.description}
        title={artifact.name}
      />
      <div className="metric-grid">
        <Metric label="latest" mono sub="version" value={artifact.latestVersion} />
        <Metric label="versions" sub="immutable" value={artifact.versions} />
        <Metric label="visibility" sub="policy" value={<VisibilityTag value={artifact.visibility} />} />
        <Metric label="updated" mono sub="ago" value={relTime(artifact.last)} />
      </div>
      <div className="grid grid-2">
        <Card className="grid-span-2">
          <CardHeader>
            <SlashMark label="versions" num={1} />
          </CardHeader>
          <CardBody flush>
            {versions.map((version) => (
              <VersionRow key={version.id} version={version} />
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function AuditScreen({ scope, projectId }: { scope: "org" | "project"; projectId?: string }) {
  const { data: events = [] } = useEvents(projectId);
  return (
    <>
      <PageHeader
        slashLabel={scope === "project" ? `project / ${projectId}` : "organization"}
        slashNum={5}
        sub="Audited actions include project creation, artifact changes, token usage, visibility changes, quota warnings, and billing events."
        title={scope === "project" ? "Project audit" : "Organization audit"}
      />
      <Card>
        <CardHeader>
          <SlashMark label="event timeline" num={1} />
        </CardHeader>
        <CardBody flush>
          <VirtualEventList events={events} showProject={scope === "org"} />
        </CardBody>
      </Card>
    </>
  );
}

const FEEDBACK_KINDS: FeedbackKind[] = ["bug", "idea", "ux", "docs", "performance", "security", "other"];
const FEEDBACK_SEVERITIES: FeedbackSeverity[] = ["low", "medium", "high", "critical"];

export function FeedbackScreen() {
  const queryClient = useQueryClient();
  const feedbackQuery = useFeedback();
  const submitFeedback = useSubmitFeedback();
  const feedback = feedbackQuery.data;
  const items = feedback?.items ?? [];
  const urgentCount = items.filter((item) => item.severity === "high" || item.severity === "critical").length;
  const cliCount = items.filter((item) => item.source === "cli" || item.source === "agent").length;
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [severity, setSeverity] = useState<FeedbackSeverity>("medium");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [surface, setSurface] = useState("");
  const [projectRef, setProjectRef] = useState("");
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setFormError(null);
    const cleanMessage = message.trim();
    if (!cleanMessage) {
      setFormError("Feedback message is required.");
      return;
    }
    try {
      await submitFeedback.mutateAsync({
        kind,
        severity,
        title: title.trim() || null,
        message: cleanMessage,
        surface: surface.trim() || null,
        projectRef: projectRef.trim() || null,
        url: url.trim() || null,
        tags,
        source: "console",
      });
      setMessage("");
      setTitle("");
      setSurface("");
      setProjectRef("");
      setUrl("");
      setTags("");
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["console", "feedback"] });
    } catch (error) {
      setFormError(error instanceof ConsoleApiClientError ? error.payload.error : "Failed to submit feedback.");
    }
  }

  return (
    <>
      <PageHeader
        slashLabel="organization"
        slashNum={5}
        sub="Structured product and operational feedback from Console, agents, and local CLI workflows."
        title="Feedback"
      />
      <div className="metric-grid">
        <Metric label="recent" sub="signals" value={feedback?.total ?? items.length} />
        <Metric label="attention" sub="high / critical" value={urgentCount} />
        <Metric label="agent / cli" sub="submitted" value={cliCount} />
        <Metric label="command" mono sub="local entrypoint" value="ravi feedback" />
      </div>
      <div className="grid grid-2">
        <Card>
          <CardHeader>
            <SlashMark label="submit feedback" num={1} />
          </CardHeader>
          <CardBody>
            <form className="col gap-12" onSubmit={submit}>
              {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
              {saved ? <div className="form-banner">Feedback submitted.</div> : null}
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="feedback-kind">Kind</label>
                  <select
                    className="select"
                    id="feedback-kind"
                    onChange={(event) => setKind(event.target.value as FeedbackKind)}
                    value={kind}
                  >
                    {FEEDBACK_KINDS.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="feedback-severity">Severity</label>
                  <select
                    className="select"
                    id="feedback-severity"
                    onChange={(event) => setSeverity(event.target.value as FeedbackSeverity)}
                    value={severity}
                  >
                    {FEEDBACK_SEVERITIES.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="feedback-title">Title</label>
                <input
                  className="input"
                  id="feedback-title"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short summary"
                  value={title}
                />
              </div>
              <div className="field">
                <label htmlFor="feedback-message">Message</label>
                <textarea
                  className="textarea"
                  id="feedback-message"
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="What happened, why it matters, and what would make it better."
                  rows={5}
                  value={message}
                />
              </div>
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="feedback-surface">Surface</label>
                  <input
                    className="input t-mono"
                    id="feedback-surface"
                    onChange={(event) => setSurface(event.target.value)}
                    placeholder="console/pages"
                    value={surface}
                  />
                </div>
                <div className="field">
                  <label htmlFor="feedback-project">Project</label>
                  <input
                    className="input t-mono"
                    id="feedback-project"
                    onChange={(event) => setProjectRef(event.target.value)}
                    placeholder="optional project slug"
                    value={projectRef}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="feedback-url">URL</label>
                <input
                  className="input t-mono"
                  id="feedback-url"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://console.ravi.bot/..."
                  value={url}
                />
              </div>
              <div className="field">
                <label htmlFor="feedback-tags">Tags</label>
                <input
                  className="input t-mono"
                  id="feedback-tags"
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="pages,ux,auth"
                  value={tags}
                />
              </div>
              <Button disabled={submitFeedback.isPending} icon={Send} type="submit" variant="primary">
                {submitFeedback.isPending ? "Submitting" : "Submit feedback"}
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="agent contract" num={2} />
          </CardHeader>
          <CardBody>
            <div className="col gap-12">
              <div className="row gap-8">
                <MessageSquareText size={14} />
                <span className="t-strong">Use the structured command for feedback captured outside the Console.</span>
              </div>
              <pre className="mail-body" style={{ margin: 0 }}>
{`ravi feedback send "message" \\
  --kind bug \\
  --severity high \\
  --surface console/pages \\
  --project rbbt \\
  --url https://console.ravi.bot/org/feedback \\
  --tag pages,ux`}
              </pre>
              <p className="t-body t-mute" style={{ margin: 0 }}>
                The command uses the same Console auth and stores feedback as normalized product signals for later analysis.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader
          right={
            <Button disabled={feedbackQuery.isFetching} icon={RefreshCw} onClick={() => void feedbackQuery.refetch()} size="sm">
              Refresh
            </Button>
          }
        >
          <SlashMark label="recent feedback" num={3} />
        </CardHeader>
        <CardBody>
          {feedbackQuery.data === undefined ? (
            <LoadingState label="Loading feedback" />
          ) : items.length === 0 ? (
            <EmptyState title="No feedback yet" body="Feedback from Console, agents, and CLI workflows will appear here." />
          ) : (
            <div className="col gap-12">
              {items.map((item) => (
                <FeedbackRow item={item} key={item.id} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function FeedbackRow({ item }: { item: FeedbackItem }) {
  return (
    <div
      className="col gap-12"
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--radius)",
        padding: 14,
      }}
    >
      <div className="row-between gap-12" style={{ alignItems: "flex-start" }}>
        <div className="col gap-4" style={{ minWidth: 0 }}>
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            <Tag>{item.kind}</Tag>
            <Tag dot tone={feedbackSeverityTone(item.severity)}>{item.severity}</Tag>
            <Tag>{item.source}</Tag>
            {item.projectSlug ? <Tag>{item.projectSlug}</Tag> : null}
          </div>
          <div className="t-strong">{item.title ?? item.message.slice(0, 96)}</div>
        </div>
        <div className="row gap-8" style={{ flexShrink: 0 }}>
          <Avatar color={item.color} mark={item.actorMark} />
          <div className="col">
            <span className="t-small">{item.actor}</span>
            <span className="t-mono t-tiny t-mute">{relTime(item.createdAt)}</span>
          </div>
        </div>
      </div>
      {item.title ? <p className="t-body" style={{ margin: 0 }}>{item.message}</p> : null}
      <div className="row gap-12" style={{ flexWrap: "wrap" }}>
        <FeedbackMeta label="surface" value={item.surface ?? "-"} />
        <FeedbackMeta label="url" value={item.url ?? "-"} />
        <FeedbackMeta label="project" value={item.projectName ?? item.projectSlug ?? "-"} />
        {item.tags.length ? <FeedbackMeta label="tags" value={item.tags.join(", ")} /> : null}
      </div>
    </div>
  );
}

function FeedbackMeta({ label, value }: { label: string; value: string }) {
  return (
    <span className="row gap-4" style={{ minWidth: 0 }}>
      <span className="t-tiny t-mute">{label}</span>
      <span className="t-mono t-tiny" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </span>
    </span>
  );
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="col gap-8" style={{ padding: 24, textAlign: "center" }}>
      <span className="t-strong">{title}</span>
      <span className="t-body t-mute">{body}</span>
    </div>
  );
}

function feedbackSeverityTone(severity: FeedbackSeverity): "ok" | "warn" | "err" | "info" | "default" {
  if (severity === "critical") return "err";
  if (severity === "high") return "warn";
  if (severity === "medium") return "info";
  return "default";
}

export function RunsScreen({ scope, projectId }: { scope: "organization" | "project"; projectId?: string }) {
  const { data: project } = useProject(projectId);
  const runsQuery = useRuntimeRuns(projectId);
  const runs = runsQuery.data?.runs ?? [];
  const [selectedRunRef, setSelectedRunRef] = useState<string | null>(null);
  const selectedRun = runs.find((run) => run.externalTraceId === selectedRunRef || run.id === selectedRunRef) ?? runs[0] ?? null;
  const detailQuery = useRuntimeRunDetail(selectedRun?.externalTraceId ?? null);
  const detailData = detailQuery.data ?? null;
  const detail = detailData?.summary.externalTraceId === selectedRun?.externalTraceId ? detailData : null;
  const activeRuns = runs.filter((run) => isActiveRunStatus(run.status)).length;
  const failedRuns = runs.filter((run) => isProblemRun(run)).length;
  const toolCalls = runs.reduce((sum, run) => sum + run.toolCallCount, 0);
  const totalTokens = runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0);
  const isLoading = runsQuery.data === undefined || (projectId ? project === undefined : false);
  const isFetching = runsQuery.isFetching || detailQuery.isFetching;

  if (projectId && project === null) return <NotFound />;
  if (isLoading) return <LoadingState label="Loading runs" />;
  if (runsQuery.data === null) return <NotFound />;

  return (
    <>
      <PageHeader
        right={
          <Button
            disabled={isFetching}
            icon={RefreshCw}
            onClick={() => {
              void runsQuery.refetch();
              if (selectedRun) void detailQuery.refetch();
            }}
            size="sm"
          >
            Refresh
          </Button>
        }
        slashLabel={scope === "project" ? `project / ${project?.name ?? projectId}` : "organization"}
        slashNum={scope === "project" ? 5 : 4}
        sub={scope === "project" ? "Runtime execution history for this project." : "Runtime execution history across accessible projects."}
        title="Runs"
      />
      <div className="metric-grid">
        <Metric label="runs" sub="recent" value={runs.length} />
        <Metric label="active" sub="open" value={activeRuns} />
        <Metric label="issues" sub="errors" value={failedRuns} />
        <Metric label="tokens" mono sub="in + out" value={formatCompactNumber(totalTokens)} />
      </div>
      <Card>
        <CardHeader right={<span className="t-mono t-tiny t-mute">{toolCalls} tool calls</span>}>
          <SlashMark label="runtime timeline" num={1} />
        </CardHeader>
        <CardBody flush>
          {runs.length === 0 ? (
            <div className="empty">No runs captured yet.</div>
          ) : (
            <RuntimeRunsPanel
              detail={detail}
              detailLoading={Boolean(selectedRun && detailQuery.isFetching && !detail)}
              onSelectRun={(run) => setSelectedRunRef(run.externalTraceId)}
              runs={runs}
              scope={scope}
              selectedRun={selectedRun}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}

export function SettingsScreen({ scope, projectId }: { scope: "org" | "project"; projectId?: string }) {
  const { data: settings } = useSettings(scope, projectId);

  if (settings === undefined) return <LoadingState label="Loading settings" />;
  if (settings === null) return <NotFound />;

  return <SettingsForm projectId={projectId} scope={scope} settings={settings} />;
}

function SettingsForm({
  scope,
  projectId,
  settings,
}: {
  scope: "org" | "project";
  projectId?: string;
  settings: SettingsData;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const mutation = useUpdateSettings();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm({
    defaultValues: {
      name: settings.name,
      slug: settings.slug,
      visibility: settings.visibility,
    },
    onSubmit: async ({ value }) => {
      const nextFieldErrors: Record<string, string> = {};
      const name = value.name.trim();
      const slug = value.slug.trim();
      if (!name) nextFieldErrors.name = "Name is required.";
      if (!slug) nextFieldErrors.slug = "This slug is unavailable.";

      if (Object.keys(nextFieldErrors).length > 0) {
        setFieldErrors(nextFieldErrors);
        setFormError(null);
        setSaved(false);
        return;
      }

      setFieldErrors({});
      setFormError(null);
      setSaved(false);

      try {
        await mutation.mutateAsync({
          name,
          projectId,
          scope,
          slug,
          visibility: scope === "project" ? value.visibility : undefined,
        });

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["console", "settings", scope, projectId ?? "current"] }),
          queryClient.invalidateQueries({ queryKey: ["console", "organization"] }),
          queryClient.invalidateQueries({ queryKey: ["console", "organizations"] }),
          queryClient.invalidateQueries({ queryKey: ["console", "projects"] }),
          projectId ? queryClient.invalidateQueries({ queryKey: ["console", "projects", projectId] }) : Promise.resolve(),
          queryClient.invalidateQueries({ queryKey: ["console", "events"] }),
        ]);
        setSaved(true);
        router.refresh();
      } catch (error) {
        if (error instanceof ConsoleApiClientError) {
          setFieldErrors(error.payload.fieldErrors ?? {});
          setFormError(settingsApiErrorMessage(error.payload.error));
          return;
        }
        setFormError("Settings update failed.");
      }
    },
  });

  return (
    <>
      <PageHeader
        slashLabel={scope === "project" ? `project / ${settings.name ?? projectId}` : "organization"}
        slashNum={7}
        sub="Settings establish the shape for WorkOS-backed members, project tokens, secrets, and project policies."
        title={scope === "project" ? "Project settings" : "Organization settings"}
      />
      <div className="grid grid-2">
        <Card>
          <CardHeader>
            <SlashMark label="general" num={1} />
          </CardHeader>
          <CardBody>
            <form
              className="col gap-16"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              {formError ? <div className="form-banner form-banner--err">{formError}</div> : null}
              {saved ? <div className="form-banner">Settings saved.</div> : null}
              <form.Field name="name">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Name</label>
                    <input
                      className="input"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        setFieldErrors((current) => ({ ...current, name: "" }));
                        setSaved(false);
                        field.handleChange(event.target.value);
                      }}
                      value={field.state.value}
                    />
                    {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="slug">
                {(field) => (
                  <div className="field">
                    <label htmlFor={field.name}>Slug</label>
                    <input
                      className="input t-mono"
                      id={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        setFieldErrors((current) => ({ ...current, slug: "" }));
                        setSaved(false);
                        field.handleChange(event.target.value);
                      }}
                      value={field.state.value}
                    />
                    {fieldErrors.slug ? <span className="field-error">{fieldErrors.slug}</span> : null}
                  </div>
                )}
              </form.Field>
              {scope === "project" ? (
                <form.Field name="visibility">
                  {(field) => (
                    <div className="field">
                      <label htmlFor={field.name}>Default visibility</label>
                      <select
                        className="select"
                        id={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) => {
                          setFieldErrors((current) => ({ ...current, visibility: "" }));
                          setSaved(false);
                          field.handleChange(event.target.value as SettingsData["visibility"]);
                        }}
                        value={field.state.value}
                      >
                        <option value="public">public</option>
                        <option value="private">private</option>
                        <option value="protected_link">protected link</option>
                      </select>
                      {fieldErrors.visibility ? <span className="field-error">{fieldErrors.visibility}</span> : null}
                    </div>
                  )}
                </form.Field>
              ) : null}
              <Button disabled={mutation.isPending} icon={Check} type="submit" variant="primary">
                {mutation.isPending ? "Saving..." : "Save settings"}
              </Button>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <SlashMark label="members" num={3} />
          </CardHeader>
          <MembersSettingsPanel settings={settings} />
        </Card>
      </div>
    </>
  );
}

const ORGANIZATION_ROLE_OPTIONS: SettingsData["currentRole"][] = ["owner", "admin", "developer", "viewer", "billing"];

function MembersSettingsPanel({ settings }: { settings: SettingsData }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const upsertMutation = useUpsertOrganizationMember();
  const removeMutation = useRemoveOrganizationMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SettingsData["currentRole"]>("developer");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [panelError, setPanelError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const canManageOwnerRoles = settings.currentRole === "owner";

  async function refreshMembers() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["console", "settings", "org", "current"] }),
      queryClient.invalidateQueries({ queryKey: ["console", "organization"] }),
      queryClient.invalidateQueries({ queryKey: ["console", "organizations"] }),
      queryClient.invalidateQueries({ queryKey: ["console", "events"] }),
    ]);
    router.refresh();
  }

  async function submitMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setFieldErrors({ email: "Email is required." });
      setPanelError(null);
      setSavedMessage(null);
      return;
    }

    setFieldErrors({});
    setPanelError(null);
    setSavedMessage(null);

    try {
      await upsertMutation.mutateAsync({ email: trimmedEmail, role });
      setEmail("");
      setRole("developer");
      setSavedMessage("Member saved.");
      await refreshMembers();
    } catch (error) {
      if (error instanceof ConsoleApiClientError) {
        setFieldErrors(error.payload.fieldErrors ?? {});
        setPanelError(memberApiErrorMessage(error.payload.error));
        return;
      }
      setPanelError("Member update failed.");
    }
  }

  async function updateMemberRole(member: SettingsData["members"][number], nextRole: SettingsData["currentRole"]) {
    setPendingMemberId(member.id);
    setPanelError(null);
    setSavedMessage(null);
    try {
      await upsertMutation.mutateAsync({ email: member.email, role: nextRole });
      setSavedMessage("Member role updated.");
      await refreshMembers();
    } catch (error) {
      if (error instanceof ConsoleApiClientError) {
        setPanelError(memberApiErrorMessage(error.payload.error));
      } else {
        setPanelError("Member role update failed.");
      }
    } finally {
      setPendingMemberId(null);
    }
  }

  async function removeMember(member: SettingsData["members"][number]) {
    setPendingMemberId(member.id);
    setPanelError(null);
    setSavedMessage(null);
    try {
      await removeMutation.mutateAsync({ userRef: member.id });
      setSavedMessage("Member removed.");
      await refreshMembers();
    } catch (error) {
      if (error instanceof ConsoleApiClientError) {
        setPanelError(memberApiErrorMessage(error.payload.error));
      } else {
        setPanelError("Member removal failed.");
      }
    } finally {
      setPendingMemberId(null);
    }
  }

  return (
    <CardBody className="col gap-14">
      {panelError ? <div className="form-banner form-banner--err">{panelError}</div> : null}
      {savedMessage ? <div className="form-banner">{savedMessage}</div> : null}
      {settings.canManageMembers ? (
        <form className="col gap-12" onSubmit={submitMember}>
          <div className="grid" style={{ gap: 10, gridTemplateColumns: "minmax(0, 1fr) 140px" }}>
            <div className="field">
              <label htmlFor="member-email">Email</label>
              <input
                className="input t-mono"
                id="member-email"
                onChange={(event) => {
                  setFieldErrors((current) => ({ ...current, email: "" }));
                  setEmail(event.target.value);
                }}
                placeholder="person@company.com"
                value={email}
              />
              {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
            </div>
            <div className="field">
              <label htmlFor="member-role">Role</label>
              <select
                className="select"
                id="member-role"
                onChange={(event) => {
                  setFieldErrors((current) => ({ ...current, role: "" }));
                  setRole(event.target.value as SettingsData["currentRole"]);
                }}
                value={role}
              >
                {ORGANIZATION_ROLE_OPTIONS.map((option) => (
                  <option disabled={option === "owner" && !canManageOwnerRoles} key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {fieldErrors.role ? <span className="field-error">{fieldErrors.role}</span> : null}
            </div>
          </div>
          <Button disabled={upsertMutation.isPending} icon={UserPlus} type="submit" variant="primary">
            {upsertMutation.isPending && !pendingMemberId ? "Saving..." : "Add member"}
          </Button>
        </form>
      ) : null}
      <div className="col gap-12">
        {settings.members.length === 0 ? <div className="empty">No organization members yet.</div> : null}
        {settings.members.map((member) => {
          const isPending = pendingMemberId === member.id;
          const canEditThisMember =
            settings.canManageMembers && (canManageOwnerRoles || member.role !== "owner");
          return (
            <div
              className="row-between gap-12"
              key={member.membershipId}
              style={{ borderBottom: "1px solid var(--line)", flexWrap: "wrap", paddingBottom: 10 }}
            >
              <div className="row gap-12 grow truncate">
                <Avatar color={member.color} mark={member.mark} />
                <div className="grow truncate">
                  <div className="truncate">{member.name}</div>
                  <div className="t-mono t-tiny t-mute truncate">
                    {member.email} / {member.status} / {relTime(member.joined)}
                  </div>
                </div>
              </div>
              {settings.canManageMembers ? (
                <div className="row gap-8" style={{ flexWrap: "wrap" }}>
                  <select
                    className="select"
                    disabled={!canEditThisMember || isPending}
                    onChange={(event) => {
                      void updateMemberRole(member, event.target.value as SettingsData["currentRole"]);
                    }}
                    style={{ minWidth: 128 }}
                    value={member.role}
                  >
                    {ORGANIZATION_ROLE_OPTIONS.map((option) => (
                      <option disabled={option === "owner" && !canManageOwnerRoles} key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={!canEditThisMember || isPending}
                    icon={Trash2}
                    onClick={() => {
                      void removeMember(member);
                    }}
                    size="sm"
                    variant="danger"
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <Tag>{member.role}</Tag>
              )}
            </div>
          );
        })}
      </div>
    </CardBody>
  );
}

type RuntimeRunChatItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      at: number;
      sequence: number;
      preview: string;
      event: RuntimeRunEvent;
    }
  | {
      id: string;
      kind: "tool-group";
      at: number;
      sequence: number;
      calls: RuntimeRunToolCall[];
    }
  | {
      id: string;
      kind: "system-group";
      at: number;
      sequence: number;
      events: RuntimeRunEvent[];
      tone: "default" | "ok" | "warn" | "err" | "info";
    };

function RuntimeRunsPanel({
  detail,
  detailLoading,
  onSelectRun,
  runs,
  scope,
  selectedRun,
}: {
  detail: RuntimeRunDetail | null;
  detailLoading: boolean;
  onSelectRun: (run: RuntimeRunSummary) => void;
  runs: RuntimeRunSummary[];
  scope: "organization" | "project";
  selectedRun: RuntimeRunSummary | null;
}) {
  const groups = useMemo(() => groupRuntimeRunsByIdentity(runs), [runs]);

  return (
    <div className="runs-layout">
      <div className="runs-list">
        {groups.map((group) => (
          <div className="run-channel-group" key={group.key}>
            <div className="run-channel-head">
              <div className="col gap-4 truncate">
                <span className="run-channel-title truncate">{group.label}</span>
                {group.subLabel ? <span className="run-channel-sub truncate">{group.subLabel}</span> : null}
              </div>
              <span className="run-channel-count">{group.runs.length}</span>
            </div>
            {group.runs.map((run) => (
              <RuntimeRunListItem
                isSelected={run.id === selectedRun?.id}
                key={run.id}
                onClick={() => onSelectRun(run)}
                run={run}
                showProject={scope === "organization"}
              />
            ))}
          </div>
        ))}
      </div>
      <RuntimeRunDetailPanel detail={detail} isLoading={detailLoading} summary={selectedRun} />
    </div>
  );
}

function RuntimeRunListItem({
  isSelected,
  onClick,
  run,
  showProject,
}: {
  isSelected: boolean;
  onClick: () => void;
  run: RuntimeRunSummary;
  showProject: boolean;
}) {
  const preview = run.lastErrorPreview ?? run.lastSafePreview;
  const channel = runChannelLabel(run);
  const chat = runChatLabel(run);
  const identity = runtimeRunPrimaryId(run);
  return (
    <button className={`run-list-item${isSelected ? " is-selected" : ""}`} onClick={onClick} type="button">
      <div className="row-between gap-12">
        <div className="row gap-8 truncate">
          <Bot size={14} style={{ color: "var(--mute)" }} />
          <span className="t-small truncate">{runDisplayName(run)}</span>
        </div>
        <Tag tone={runTone(run.status)}>{run.status}</Tag>
      </div>
      <div className="row gap-8 run-list-meta">
        {channel ? <span>{channel}</span> : null}
        {chat ? <span>{chat}</span> : null}
        <span className="t-mono">{shortHash(identity)}</span>
        <span>{run.runtimeProvider}</span>
        {run.runtimeModel ? <span>{run.runtimeModel}</span> : null}
        {showProject ? <span>{run.projectSlug ?? run.projectName ?? "organization"}</span> : null}
      </div>
      <div className="run-list-counts">
        <span>{run.turnCount} turns</span>
        <span>{run.eventCount} events</span>
        <span>{run.toolCallCount} tools</span>
        {run.errorCount ? <span className="run-count-err">{run.errorCount} errors</span> : null}
      </div>
      <div className="t-small t-mute run-preview">{preview ?? "No safe preview yet."}</div>
      <div className="row-between gap-12">
        <span className="t-mono t-tiny t-mute">{formatDateTime(run.startedAt)}</span>
        <span className="t-mono t-tiny t-mute">{relTime(run.updatedAt)}</span>
      </div>
    </button>
  );
}

/** A cloud agent run (placement `cloud`) has its own page, with approvals, follow-ups and files. */
function cloudRunHref(run: RuntimeRunSummary) {
  if (run.placement !== "cloud" || !run.projectId || !run.runId) return null;
  return `/p/${run.projectId}/cloud/runs/${run.runId}`;
}

function RuntimeRunDetailPanel({
  detail,
  isLoading,
  summary,
}: {
  detail: RuntimeRunDetail | null;
  isLoading: boolean;
  summary: RuntimeRunSummary | null;
}) {
  const chatItems = useMemo(() => (detail ? buildRunChat(detail) : []), [detail]);

  if (!summary) {
    return <div className="run-detail empty">Select a run.</div>;
  }

  return (
    <div className="run-detail">
      <div className="run-detail-head">
        <div className="col gap-8 grow truncate">
          <div className="row gap-8">
            <Tag tone={runTone(summary.status)} dot>{summary.status}</Tag>
            <Tag>{summary.placement}</Tag>
            {runChannelLabel(summary) ? <Tag tone="info">{runChannelLabel(summary)}</Tag> : null}
            {summary.projectSlug ?? summary.projectName ? <Tag tone="info">{summary.projectSlug ?? summary.projectName}</Tag> : null}
          </div>
          <div className="t-h2 truncate">{runDisplayName(summary)}</div>
          <div className="t-mono t-tiny t-mute truncate">{runtimeRunPrimaryId(summary)}</div>
        </div>
        {cloudRunHref(summary) ? (
          <Link className="t-mono t-small t-mute" href={cloudRunHref(summary)!}>
            open cloud run
          </Link>
        ) : null}
      </div>
      <div className="run-summary-strip">
        <RunStat icon={Clock3} label="started" value={formatDateTime(summary.startedAt)} />
        <RunStat icon={Terminal} label="provider" value={`${summary.runtimeProvider}${summary.runtimeModel ? ` / ${summary.runtimeModel}` : ""}`} />
        <RunStat icon={Wrench} label="tools" value={String(summary.toolCallCount)} />
        <RunStat icon={AlertTriangle} label="issues" value={`${summary.warningCount} warn / ${summary.errorCount} err`} />
      </div>
      {isLoading ? (
        <div className="empty">Loading run detail.</div>
      ) : detail ? (
        <div className="run-chat-shell">
          <div className="run-chat" aria-label="Run conversation">
            {chatItems.length === 0 ? <div className="empty">No chat messages captured yet.</div> : null}
            {chatItems.map((item) => (
              <RuntimeChatItem key={item.id} item={item} />
            ))}
          </div>
          <RunMetadata detail={detail} />
        </div>
      ) : (
        <div className="empty">Run detail unavailable.</div>
      )}
    </div>
  );
}

function RunStat({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: string }) {
  return (
    <div className="run-stat">
      <Icon size={13} />
      <div className="col gap-4 truncate">
        <span>{label}</span>
        <strong className="truncate">{value}</strong>
      </div>
    </div>
  );
}

function RuntimeChatItem({ item }: { item: RuntimeRunChatItem }) {
  if (item.kind === "message") return <RuntimeChatMessage item={item} />;
  if (item.kind === "tool-group") return <RuntimeToolGroup item={item} />;
  return <RuntimeSystemGroup item={item} />;
}

function RuntimeChatMessage({ item }: { item: Extract<RuntimeRunChatItem, { kind: "message" }> }) {
  const isUser = item.role === "user";
  const payloadEntries = safePayloadEntries(item.event.safePayload);
  return (
    <div className={`run-chat-row ${isUser ? "run-chat-row--user" : "run-chat-row--assistant"}`}>
      {!isUser ? <RunChatAvatar label="R" /> : null}
      <div className={`run-chat-bubble ${isUser ? "run-chat-bubble--user" : "run-chat-bubble--assistant"}`}>
        <div className="run-chat-text">{item.preview}</div>
        <details className="run-inline-details">
          <summary>
            <span>{formatDateTime(item.at)}</span>
            <span>{item.event.eventType}</span>
          </summary>
          <div className="run-details-grid">
            <RunMeta label="Sequence" value={String(item.event.sequence)} />
            <RunMeta label="Severity" value={item.event.severity} />
            <RunMeta label="Status" value={item.event.status ?? "-"} />
            <RunMeta label="Blob" value={shortHash(item.event.blobRef)} />
            {payloadEntries.map(([key, value]) => (
              <RunMeta key={key} label={key} value={value} />
            ))}
          </div>
        </details>
      </div>
      {isUser ? <RunChatAvatar label="U" /> : null}
    </div>
  );
}

function RuntimeToolGroup({ item }: { item: Extract<RuntimeRunChatItem, { kind: "tool-group" }> }) {
  const totalDuration = item.calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const hasDuration = item.calls.some((call) => call.durationMs !== null);
  const failedCount = item.calls.filter((call) => ["failed", "denied", "interrupted"].includes(call.status)).length;
  const tone = failedCount > 0 ? "err" : item.calls.every((call) => call.status === "completed") ? "ok" : "info";
  const names = compactToolNames(item.calls);
  return (
    <div className="run-chat-tool-wrap">
      <details className="run-tool-group">
        <summary>
          <span className="run-tool-icon"><Wrench size={13} /></span>
          <span className="run-tool-summary">
            <strong>{item.calls.length === 1 ? "1 function call" : `${item.calls.length} function calls`}</strong>
            <span>{names}</span>
          </span>
          <Tag tone={tone}>{failedCount ? `${failedCount} failed` : "tools"}</Tag>
          {hasDuration ? <span className="t-mono t-tiny t-mute">{formatDuration(totalDuration)}</span> : null}
        </summary>
        <div className="run-tool-list">
          {item.calls.map((call) => (
            <div className="run-tool-call" key={call.id}>
              <div className="row-between gap-12">
                <span className="t-mono t-small truncate">{call.toolName}</span>
                <Tag tone={runTone(call.status)}>{call.status}</Tag>
              </div>
              <div className="run-details-grid">
                <RunMeta label="Duration" value={formatDuration(call.durationMs)} />
                <RunMeta label="Input" value={call.inputPreview ?? "-"} />
                <RunMeta label="Output" value={call.outputPreview ?? "-"} />
                <RunMeta label="Input blob" value={shortHash(call.inputBlobRef)} />
                <RunMeta label="Output blob" value={shortHash(call.outputBlobRef)} />
                {safePayloadEntries(call.approval).map(([key, value]) => (
                  <RunMeta key={key} label={key} value={value} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function RuntimeSystemGroup({ item }: { item: Extract<RuntimeRunChatItem, { kind: "system-group" }> }) {
  const title = item.events.length === 1 ? item.events[0]?.eventType ?? "event" : `${item.events.length} runtime events`;
  return (
    <div className="run-chat-system">
      <details>
        <summary>
          <AlertTriangle size={13} />
          <span>{title}</span>
          <Tag tone={item.tone}>{item.tone === "err" ? "issue" : "event"}</Tag>
        </summary>
        <div className="run-system-list">
          {item.events.map((event) => (
            <div className="run-system-event" key={event.id}>
              <div className="row-between gap-12">
                <span className="t-mono t-small truncate">{event.eventType}</span>
                <span className="t-mono t-tiny t-mute">{formatDateTime(event.occurredAt)}</span>
              </div>
              {event.safePreview ? <div className="t-small t-mute">{event.safePreview}</div> : null}
              <div className="run-details-grid">
                <RunMeta label="Group" value={event.eventGroup} />
                <RunMeta label="Severity" value={event.severity} />
                <RunMeta label="Status" value={event.status ?? "-"} />
                <RunMeta label="Blob" value={shortHash(event.blobRef)} />
                {safePayloadEntries(event.safePayload).map(([key, value]) => (
                  <RunMeta key={key} label={key} value={value} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function RunMetadata({ detail }: { detail: RuntimeRunDetail }) {
  const tokenTotal = detail.turns.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0);
  return (
    <details className="run-metadata">
      <summary>
        <span>Run metadata</span>
        <span className="t-mono t-tiny t-mute">
          {detail.turns.length} turns / {detail.events.length} events / {detail.blobs.length} blobs
        </span>
      </summary>
      <div className="run-details-grid">
        <RunMeta label="Run ID" value={detail.summary.runId ?? "-"} />
        <RunMeta label="Session" value={detail.summary.sessionKey} />
        <RunMeta label="Agent" value={detail.summary.agentRef ?? "-"} />
        <RunMeta label="Channel" value={runChannelLabel(detail.summary) ?? "-"} />
        <RunMeta label="Chat" value={runChatLabel(detail.summary) ?? "-"} />
        <RunMeta label="Source chat" value={detail.summary.sourceChatId ?? "-"} />
        <RunMeta label="Canonical chat" value={detail.summary.canonicalChatId ?? "-"} />
        <RunMeta label="Source account" value={detail.summary.sourceAccountId ?? "-"} />
        <RunMeta label="Thread" value={detail.summary.sourceThreadId ?? "-"} />
        <RunMeta label="Tokens" value={String(tokenTotal)} />
        <RunMeta label="Input" value={String(detail.summary.inputTokens)} />
        <RunMeta label="Output" value={String(detail.summary.outputTokens)} />
      </div>
      {detail.turns.length ? (
        <div className="run-turn-list">
          {detail.turns.map((turn) => (
            <div className="run-turn-row" key={turn.id}>
              <span className="t-mono t-tiny">turn {turn.sequence}</span>
              <Tag tone={runTone(turn.status)}>{turn.status}</Tag>
              <span className="t-mono t-tiny t-mute">{turn.inputTokens} in / {turn.outputTokens} out</span>
              <span className="t-mono t-tiny t-mute">{shortHash(turn.requestBlobSha256)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function RunChatAvatar({ label }: { label: string }) {
  return <span className="run-chat-avatar">{label}</span>;
}

function RunMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="run-meta-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type RawChatEntry =
  | {
      kind: "message";
      role: "user" | "assistant";
      at: number;
      sequence: number;
      event: RuntimeRunEvent;
      preview: string;
    }
  | {
      kind: "tool";
      at: number;
      sequence: number;
      call: RuntimeRunToolCall;
    }
  | {
      kind: "system";
      at: number;
      sequence: number;
      event: RuntimeRunEvent;
      tone: "default" | "ok" | "warn" | "err" | "info";
    };

function buildRunChat(detail: RuntimeRunDetail): RuntimeRunChatItem[] {
  const rawEntries: RawChatEntry[] = [];

  detail.events.forEach((event) => {
    const role = messageRoleFromEvent(event);
    if (role && event.safePreview) {
      rawEntries.push({
        at: event.occurredAt,
        event,
        kind: "message",
        preview: event.safePreview,
        role,
        sequence: event.sequence,
      });
      return;
    }

    if (shouldShowSystemEvent(event)) {
      rawEntries.push({
        at: event.occurredAt,
        event,
        kind: "system",
        sequence: event.sequence,
        tone: eventTone(event.severity),
      });
    }
  });

  detail.toolCalls.forEach((call, index) => {
    rawEntries.push({
      at: call.startedAt,
      call,
      kind: "tool",
      sequence: index,
    });
  });

  rawEntries.sort((a, b) => a.at - b.at || a.sequence - b.sequence || chatSortWeight(a.kind) - chatSortWeight(b.kind));

  const items: RuntimeRunChatItem[] = [];
  let pendingTools: RuntimeRunToolCall[] = [];
  let pendingSystem: RuntimeRunEvent[] = [];

  const flushTools = () => {
    if (!pendingTools.length) return;
    const first = pendingTools[0];
    items.push({
      at: first?.startedAt ?? 0,
      calls: pendingTools,
      id: `tools:${pendingTools.map((call) => call.id).join(":")}`,
      kind: "tool-group",
      sequence: items.length,
    });
    pendingTools = [];
  };

  const flushSystem = () => {
    if (!pendingSystem.length) return;
    const first = pendingSystem[0];
    const tone = pendingSystem.some((event) => event.severity === "error")
      ? "err"
      : pendingSystem.some((event) => event.severity === "warn" || event.severity === "warning")
        ? "warn"
        : "info";
    items.push({
      at: first?.occurredAt ?? 0,
      events: pendingSystem,
      id: `system:${pendingSystem.map((event) => event.id).join(":")}`,
      kind: "system-group",
      sequence: items.length,
      tone,
    });
    pendingSystem = [];
  };

  for (const entry of rawEntries) {
    if (entry.kind === "tool") {
      flushSystem();
      pendingTools.push(entry.call);
      continue;
    }

    flushTools();

    if (entry.kind === "system") {
      pendingSystem.push(entry.event);
      continue;
    }

    flushSystem();
    items.push({
      at: entry.at,
      event: entry.event,
      id: `message:${entry.event.id}`,
      kind: "message",
      preview: entry.preview,
      role: entry.role,
      sequence: entry.sequence,
    });
  }

  flushTools();
  flushSystem();

  return items;
}

function messageRoleFromEvent(event: RuntimeRunEvent): "user" | "assistant" | null {
  const role = typeof event.safePayload.role === "string" ? event.safePayload.role : null;
  if (role === "user" || role === "assistant") return role;
  if (event.eventType === "message.user" || event.eventType === "user.message") return "user";
  if (
    event.eventType === "message.assistant" ||
    event.eventType === "assistant.message" ||
    event.eventType === "assistant.delta.coalesced" ||
    event.eventType === "assistant.delta"
  ) {
    return "assistant";
  }
  return null;
}

function shouldShowSystemEvent(event: RuntimeRunEvent) {
  if (event.severity === "error" || event.severity === "warn" || event.severity === "warning") return true;
  return [
    "approval.requested",
    "approval.completed",
    "turn.failed",
    "turn.interrupted",
    "turn.aborted",
  ].includes(event.eventType);
}

function chatSortWeight(kind: RawChatEntry["kind"]) {
  if (kind === "message") return 0;
  if (kind === "tool") return 1;
  return 2;
}

function compactToolNames(calls: RuntimeRunToolCall[]) {
  const uniqueNames = Array.from(new Set(calls.map((call) => call.toolName)));
  if (uniqueNames.length <= 2) return uniqueNames.join(", ");
  return `${uniqueNames.slice(0, 2).join(", ")} +${uniqueNames.length - 2}`;
}

type RuntimeRunChannelGroup = {
  key: string;
  label: string;
  subLabel: string | null;
  runs: RuntimeRunSummary[];
};

type ParsedRuntimeSessionKey = {
  accountId: string | null;
  agentRef: string | null;
  channel: string | null;
  chatId: string | null;
  chatKind: string | null;
};

function groupRuntimeRunsByIdentity(runs: RuntimeRunSummary[]): RuntimeRunChannelGroup[] {
  const groups = new Map<string, RuntimeRunChannelGroup>();
  for (const run of runs) {
    const key = runtimeRunIdentityKey(run);
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    groups.set(key, {
      key,
      label: runtimeRunVisualTitle(run),
      subLabel: runtimeRunIdentitySubLabel(run),
      runs: [run],
    });
  }
  return [...groups.values()];
}

function runDisplayName(run: RuntimeRunSummary) {
  return runtimeRunVisualTitle(run);
}

function runtimeRunSource(run: RuntimeRunSummary) {
  const parsed = parseRuntimeSessionKey(run.sessionKey);
  return {
    accountId: validDisplayText(run.sourceAccountId) ?? parsed.accountId,
    canonicalChatId: validDisplayText(run.canonicalChatId),
    channel: normalizeRuntimeChannel(validDisplayText(run.sourceChannel) ?? parsed.channel),
    chatId: validDisplayText(run.sourceChatId) ?? parsed.chatId,
    chatKind: parsed.chatKind,
    threadId: validDisplayText(run.sourceThreadId),
  };
}

function runtimeRunIdentityKey(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  const chatId = normalizedChatIdentity(source.chatId, source.chatKind);
  return [
    source.channel ?? "runtime",
    source.accountId ?? "*",
    chatId ?? source.canonicalChatId ?? run.sessionKey ?? run.externalTraceId,
  ].join(":");
}

function runtimeRunPrimaryId(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  const chatId = normalizedChatIdentity(source.chatId, source.chatKind);
  if (chatId) return chatId;
  if (source.canonicalChatId) return source.canonicalChatId;
  return run.sessionKey || run.externalTraceId;
}

function runtimeRunVisualTitle(run: RuntimeRunSummary) {
  const target = runtimeRunTargetLabel(run);
  const actor = runtimeRunActorLabel(run);
  if (target && actor) return `${target} · ${actor}`;
  if (target) return target;
  if (actor) return `Runtime · ${actor}`;
  return "Runtime run";
}

function runtimeRunIdentitySubLabel(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  const parts = [
    `id:${shortHash(runtimeRunPrimaryId(run))}`,
    source.accountId ? `account:${source.accountId}` : null,
    run.runtimeProvider,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function runtimeRunActorLabel(run: RuntimeRunSummary) {
  const name = validDisplayText(run.sessionName);
  if (name) return name;
  const agent = validDisplayText(run.agentRef);
  if (agent) return agent;
  const parsed = parseRuntimeSessionKey(run.sessionKey);
  return validDisplayText(parsed.agentRef);
}

function runtimeRunTargetLabel(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  const channel = channelDisplayName(source.channel);
  const kind = runtimeChatKind(source);
  if (channel && kind) return `${kind} ${channel}`;
  if (channel) return channel;
  if (source.accountId) return `Runtime account`;
  return null;
}

function runChannelLabel(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  return channelDisplayName(source.channel);
}

function runChatLabel(run: RuntimeRunSummary) {
  const source = runtimeRunSource(run);
  return runtimeChatKind(source) ?? (source.canonicalChatId ? "Chat" : null);
}

function runtimeChatKind(source: ReturnType<typeof runtimeRunSource>) {
  const chatId = validDisplayText(source.chatId);
  const chatKind = validDisplayText(source.chatKind);
  if (chatKind === "group" || chatId?.endsWith("@g.us")) return "Grupo";
  if (chatKind === "thread" || source.threadId) return "Thread";
  if (chatKind === "dm" || chatKind === "chat" || chatId?.endsWith("@s.whatsapp.net") || chatId?.includes("@lid")) return "Chat";
  if (source.canonicalChatId?.startsWith("chat_")) return "Chat";
  return null;
}

function normalizedChatIdentity(chatId: string | null, chatKind: string | null) {
  const value = validDisplayText(chatId);
  if (!value) return null;
  if (value.endsWith("@g.us")) return `group:${value.slice(0, -5)}`;
  if (value.endsWith("@s.whatsapp.net")) return `chat:${value.slice(0, -15)}`;
  if (chatKind && !value.startsWith(`${chatKind}:`)) return `${chatKind}:${value}`;
  return value;
}

function channelDisplayName(channel: string | null) {
  const value = validDisplayText(channel);
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("whatsapp")) return "WhatsApp";
  if (normalized.includes("telegram")) return "Telegram";
  if (normalized.includes("discord")) return "Discord";
  if (normalized.includes("slack")) return "Slack";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("claude")) return "Claude";
  return value;
}

function normalizeRuntimeChannel(channel: string | null) {
  const value = validDisplayText(channel);
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("whatsapp")) return "whatsapp";
  if (normalized.includes("telegram")) return "telegram";
  if (normalized.includes("discord")) return "discord";
  if (normalized.includes("slack")) return "slack";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  return normalized;
}

function parseRuntimeSessionKey(sessionKey: string): ParsedRuntimeSessionKey {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent") {
    return { accountId: null, agentRef: null, channel: null, chatId: null, chatKind: null };
  }
  const agentRef = validDisplayText(parts[1]);
  if (parts.length >= 6) {
    return {
      accountId: validDisplayText(parts[3]),
      agentRef,
      channel: validDisplayText(parts[2]),
      chatId: validDisplayText(parts.slice(5).join(":")),
      chatKind: validDisplayText(parts[4]),
    };
  }
  return {
    accountId: validDisplayText(parts[2]),
    agentRef,
    channel: null,
    chatId: null,
    chatKind: null,
  };
}

function validDisplayText(value: string | null | undefined) {
  const text = value?.trim();
  if (!text || text.toLowerCase() === "generic") return null;
  return text;
}

function consoleFeatureEnabled(features: ConsoleFeatureAccessData | undefined, key: ConsoleFeatureKey) {
  const feature = features?.byKey[key];
  return Boolean(feature?.enabled && feature.visible);
}

function projectRunSort(left: RuntimeRunSummary, right: RuntimeRunSummary) {
  const leftProblem = isProblemRun(left) ? 1 : 0;
  const rightProblem = isProblemRun(right) ? 1 : 0;
  if (leftProblem !== rightProblem) return rightProblem - leftProblem;
  const leftActive = isActiveRunStatus(left.status) ? 1 : 0;
  const rightActive = isActiveRunStatus(right.status) ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;
  return right.updatedAt - left.updatedAt;
}

function isActiveRunStatus(status: string) {
  return ["active", "running", "started", "queued", "provisioning", "connecting"].includes(status);
}

function isProblemRun(run: RuntimeRunSummary) {
  return run.errorCount > 0 || ["error", "failed", "cancelled", "timeout", "degraded"].includes(run.status);
}

function runTone(status: string): "default" | "ok" | "warn" | "err" | "info" {
  if (["completed", "complete", "success", "succeeded", "ok"].includes(status)) return "ok";
  if (["error", "failed", "cancelled", "timeout", "degraded"].includes(status)) return "err";
  if (["active", "running", "started", "queued", "provisioning", "connecting"].includes(status)) return "info";
  if (["warn", "warning", "pending"].includes(status)) return "warn";
  return statusTone(status);
}

function eventTone(severity: string): "default" | "ok" | "warn" | "err" | "info" {
  if (severity === "error") return "err";
  if (severity === "warn" || severity === "warning") return "warn";
  if (severity === "debug") return "default";
  return "info";
}

function safePayloadEntries(payload: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(payload)
    .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => [key, value === null ? "null" : String(value)]);
}

function shortHash(value: string | null) {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDateTime(value: number | null) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function formatDuration(value: number | null) {
  if (value === null) return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function useArtifactColumns() {
  return useMemo<ColumnDef<Artifact>[]>(
    () => [
      {
        header: "Artifact",
        accessorKey: "name",
        cell: ({ row }) => (
          <div className="col gap-4">
            <span className="t-mono">{row.original.name}</span>
            <span className="t-tiny t-mute">{row.original.description}</span>
          </div>
        ),
      },
      { header: "Visibility", accessorKey: "visibility", cell: ({ row }) => <VisibilityTag value={row.original.visibility} /> },
      { header: "Latest", accessorKey: "latestVersion", cell: ({ row }) => <span className="t-mono">{row.original.latestVersion}</span> },
      { header: "Versions", accessorKey: "versions" },
      { header: "Updated", accessorKey: "last", cell: ({ row }) => <span className="t-mono t-mute">{relTime(row.original.last)}</span> },
    ],
    [],
  );
}

function VersionRow({ version }: { version: ArtifactVersion }) {
  return (
    <div className="row card-hover" style={{ borderBottom: "1px solid var(--line)", gap: 12, padding: "13px 18px" }}>
      <StatusDot status={version.status} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono">{version.ver}</span>
          <span className="t-mono t-tiny t-mute">{version.sha}</span>
          {version.on.map((target) => (
            <Tag key={target}>{target}</Tag>
          ))}
        </div>
        <span className="t-small t-mute truncate">{version.msg}</span>
      </div>
      <Avatar color={version.color} mark={version.authorMark} />
      <span className="t-mono t-tiny t-mute">{relTime(version.at)}</span>
    </div>
  );
}

function ProjectSignalRow({
  href,
  icon: Icon,
  isLast = false,
  label,
  status,
  sub,
  value,
}: {
  href?: string;
  icon: typeof Globe2;
  isLast?: boolean;
  label: string;
  status: string;
  sub: string;
  value: string;
}) {
  const content = (
    <>
      <div className="project-signal-icon">
        <Icon size={15} />
      </div>
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono t-small">{label}</span>
          <StatusDot status={status} />
        </div>
        <span className="t-tiny t-mute truncate">{sub}</span>
      </div>
      <span className="t-mono t-small">{value}</span>
    </>
  );

  if (href) {
    return (
      <Link className="project-signal-row card-hover" href={href} style={{ borderBottom: isLast ? 0 : "1px solid var(--line)" }}>
        {content}
      </Link>
    );
  }

  return (
    <div className="project-signal-row" style={{ borderBottom: isLast ? 0 : "1px solid var(--line)" }}>
      {content}
    </div>
  );
}

function ProjectRunPreviewRow({ href, isLast, run }: { href: string; isLast: boolean; run: RuntimeRunSummary }) {
  const preview = run.lastErrorPreview ?? run.lastSafePreview ?? "No safe preview yet.";
  return (
    <Link className="project-preview-row card-hover" href={href} style={{ borderBottom: isLast ? 0 : "1px solid var(--line)" }}>
      <StatusDot status={isProblemRun(run) ? "error" : run.status} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-small truncate">{runDisplayName(run)}</span>
          <Tag tone={runTone(run.status)}>{run.status}</Tag>
          {run.errorCount ? <Tag tone="err">{run.errorCount} err</Tag> : null}
        </div>
        <span className="t-tiny t-mute truncate">{preview}</span>
        <span className="t-mono t-tiny t-mute truncate">
          {run.runtimeProvider}{run.runtimeModel ? ` / ${run.runtimeModel}` : ""} · {run.toolCallCount} tools · {relTime(run.updatedAt)}
        </span>
      </div>
      <ChevronRight size={13} style={{ color: "var(--mute)" }} />
    </Link>
  );
}

function ProjectArtifactPreviewRow({ artifact, href, isLast }: { artifact: Artifact; href: string; isLast: boolean }) {
  return (
    <Link className="project-preview-row card-hover" href={href} style={{ borderBottom: isLast ? 0 : "1px solid var(--line)" }}>
      <Rocket size={14} style={{ color: "var(--mute)", flex: "none" }} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono t-small truncate">{artifact.name}</span>
          <VisibilityTag value={artifact.visibility} />
        </div>
        <span className="t-tiny t-mute truncate">{artifact.description || "No description"}</span>
      </div>
      <div className="col" style={{ alignItems: "flex-end", flex: "none" }}>
        <span className="t-mono t-tiny">{artifact.latestVersion}</span>
        <span className="t-tiny t-mute">{relTime(artifact.last)}</span>
      </div>
      <ChevronRight size={13} style={{ color: "var(--mute)" }} />
    </Link>
  );
}

function PublishedPageUrlTable({ pages }: { pages: PublishedPageSummary[] }) {
  return (
    <div className="page-url-table">
      <div className="page-url-row page-url-row--head">
        <span>Page</span>
        <span>URLs</span>
        <span>Updated</span>
        <span>Status</span>
      </div>
      {pages.map((page) => (
        <PublishedPageUrlRow key={page.id} page={page} />
      ))}
    </div>
  );
}

function PublishedPageUrlRow({ page }: { page: PublishedPageSummary }) {
  return (
    <div className="page-url-row">
      <div className="page-url-identity">
        <div className={`page-url-thumbnail page-url-thumbnail--${page.thumbnail.state}`}>
          {page.thumbnail.url ? (
            <Image alt="" height={45} src={page.thumbnail.url} unoptimized width={72} />
          ) : (
            <Globe2 aria-hidden="true" size={16} />
          )}
        </div>
        <div className="col gap-4 grow truncate">
          <Link className="page-url-title truncate" href={`/p/${page.projectId}/pages/${page.siteId}`}>
            {page.title}
          </Link>
          <span className="page-url-description truncate">{page.description}</span>
        </div>
      </div>
      <div className="page-url-list">
        {page.urls.map((url) => (
          <PageInlineUrl key={url} url={url} />
        ))}
      </div>
      <span className="page-url-updated t-mono t-tiny t-mute">{relTime(page.updatedAt)}</span>
      <span className="page-url-status">
        <StatusDot status={page.siteStatus === "active" ? "active" : page.siteStatus} />
        <span className="truncate">{page.status}</span>
      </span>
    </div>
  );
}

function PageInlineUrl({ url }: { url: string }) {
  const operatorHref = pageOperatorOpenHref(url);
  return (
    <span className="page-inline-url">
      <a className="t-mono truncate" href={operatorHref} rel="noreferrer" target="_blank">
        {displayUrl(url)}
      </a>
      <button
        aria-label={`Copy ${displayUrl(url)}`}
        className="page-inline-url-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(url);
        }}
        title="Copy URL"
        type="button"
      >
        <Copy size={12} />
      </button>
    </span>
  );
}

function PageHostCompactRow({ href, site }: { href: string; site: PageSiteSummary }) {
  return (
    <Link className="compact-list-row card-hover" href={href}>
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono t-small truncate">{site.defaultHostname}</span>
          {site.isDefault ? <Tag tone="info">default</Tag> : null}
        </div>
        <span className="t-tiny t-mute truncate">{site.activeRoutes.length} pages · {site.releaseCount} releases · {site.routeCount} routes</span>
      </div>
      <span className="page-url-status">
        <StatusDot status={site.activeReleaseId ? "active" : "pending"} />
        <span>{site.activeReleaseId ? "live" : "draft"}</span>
      </span>
    </Link>
  );
}

function PageDomainCompactRow({ binding, claim }: { binding: DomainBindingSummary; claim: DomainClaimSummary | null }) {
  return (
    <div className="compact-list-row">
      <div className="col gap-4 grow truncate">
        <span className="t-mono t-small truncate">{binding.hostname}</span>
        <span className="t-tiny t-mute truncate">{claim?.displayDomain ?? claim?.domain ?? "unclaimed"} · {domainBindingSiteId(binding) ?? "no host"}</span>
      </div>
      <span className="page-url-status">
        <StatusDot status={domainBindingIsReady(binding) ? "active" : binding.status} />
        <span>{domainBindingIsReady(binding) ? "live" : binding.status}</span>
      </span>
    </div>
  );
}

function PageUrlRow({
  hostname,
  href,
  isLast,
  label,
  status,
  tone,
}: {
  hostname: string;
  href?: string | null;
  isLast: boolean;
  label: string;
  status: string;
  tone: "default" | "ok" | "warn" | "err" | "info";
}) {
  return (
    <div className="row-between gap-16" style={{ borderBottom: isLast ? 0 : "1px solid var(--line)", padding: "14px 18px" }}>
      <div className="row gap-12 grow" style={{ minWidth: 0 }}>
        <Globe2 size={15} style={{ color: "var(--mute)", flex: "none" }} />
        <div className="col gap-4 grow" style={{ minWidth: 0 }}>
          <div className="row gap-8">
            <Tag tone={tone}>{label}</Tag>
            {href ? (
              <a className="t-mono truncate" href={pageOperatorOpenHref(href)} rel="noreferrer" target="_blank">
                {hostname}
              </a>
            ) : (
              <span className="t-mono truncate">{hostname}</span>
            )}
          </div>
          <span className="t-mono t-tiny t-mute truncate">{status}</span>
        </div>
      </div>
      {href ? (
        <Button href={pageOperatorOpenHref(href)} icon={ArrowUpRight} size="sm" target="_blank">
          Open
        </Button>
      ) : null}
    </div>
  );
}

function PageSiteRow({ href, index, site, total }: { href: string; index: number; site: PageSiteSummary; total: number }) {
  return (
    <Link
      className="row card-hover"
      href={href}
      style={{ borderBottom: index === total - 1 ? 0 : "1px solid var(--line)", gap: 12, padding: "12px 18px" }}
    >
      <StatusDot status={site.status} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono t-small">{site.slug}</span>
          {site.isDefault ? <Tag tone="info">default</Tag> : null}
          <VisibilityTag value={site.defaultVisibility} />
        </div>
        <span className="t-mono t-tiny t-mute truncate">{site.defaultHostname}</span>
      </div>
      <div className="col" style={{ alignItems: "flex-end", flex: "none" }}>
        <span className="t-mono t-tiny">{site.releaseCount} releases</span>
        <span className="t-tiny t-mute">{site.routeCount} routes</span>
      </div>
      <ChevronRight size={13} style={{ color: "var(--mute)" }} />
    </Link>
  );
}

function PageRouteRow({ route, site }: { route: PageReleaseRoute; site: PageSiteDetail }) {
  const href = site.activeReleaseId ? pageRouteHref(site.defaultHostname, route.path) : null;

  return (
    <div className="row" style={{ borderBottom: "1px solid var(--line)", gap: 12, padding: "12px 18px" }}>
      <Tag>{route.matchType}</Tag>
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          {href ? (
            <a className="t-mono" href={pageOperatorOpenHref(href)} rel="noreferrer" target="_blank">
              {route.path}
            </a>
          ) : (
            <span className="t-mono">{route.path}</span>
          )}
          <VisibilityTag value={route.visibility} />
        </div>
        <Link className="t-mono t-tiny t-mute truncate" href={`/p/${site.projectId}/artifacts/${route.artifactId}`}>
          {route.artifactName} / {route.artifactVersion} / {route.entrypoint}
        </Link>
      </div>
      <span className="t-mono t-tiny t-mute">p{route.priority}</span>
    </div>
  );
}

function PageReleaseRow({
  activeReleaseId,
  release,
}: {
  activeReleaseId: string | null;
  release: PageSiteRelease;
}) {
  const isActive = release.id === activeReleaseId;
  return (
    <div className="row" style={{ borderBottom: "1px solid var(--line)", gap: 12, padding: "12px 18px" }}>
      <History size={14} style={{ color: "var(--mute)" }} />
      <div className="col gap-4 grow truncate">
        <div className="row gap-8">
          <span className="t-mono">r{release.releaseNumber}</span>
          <Tag tone={isActive ? "ok" : "default"}>{isActive ? "active" : release.status}</Tag>
        </div>
        <span className="t-mono t-tiny t-mute truncate">{release.reason ?? "release"} / {release.routeCount} routes / {relTime(release.createdAt)}</span>
      </div>
    </div>
  );
}

function MailInbox({
  mailboxes,
  messages,
  onSelect,
  selectedMessage,
}: {
  mailboxes: MailboxSummary[];
  messages: MailMessageSummary[];
  onSelect: (id: string) => void;
  selectedMessage: MailMessageSummary | null;
}) {
  const mailboxById = useMemo(() => new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox])), [mailboxes]);

  if (messages.length === 0) {
    return <div className="empty">No messages yet.</div>;
  }

  const selectedMailbox = selectedMessage ? mailboxById.get(selectedMessage.mailboxId) : null;

  return (
    <div className="mail-inbox">
      <div className="mail-list">
        {messages.map((message) => {
          const isSelected = message.id === selectedMessage?.id;
          const mailbox = mailboxById.get(message.mailboxId);
          const sender = message.direction === "outbound"
            ? `To ${formatAddressLine(message.to)}`
            : formatAddressLine(message.from);
          return (
            <button
              className={`mail-list-item${isSelected ? " is-selected" : ""}`}
              key={message.id}
              onClick={() => onSelect(message.id)}
              type="button"
            >
              <div className="row-between gap-12">
                <span className="t-small truncate">{sender}</span>
                <span className="t-mono t-tiny t-mute">{formatMailTime(message.receivedAt ?? message.sentAt ?? message.updatedAt)}</span>
              </div>
              <div className="t-h3 truncate">{message.subject ?? "(no subject)"}</div>
              <div className="t-small t-mute truncate">{message.bodyPreview ?? "No body content."}</div>
              <div className="row gap-8">
                <span className="t-mono t-tiny t-mute truncate">{mailbox?.address ?? message.mailboxId}</span>
                {message.decryptError ? <Tag tone="warn">content unavailable</Tag> : null}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mail-reader">
        {selectedMessage ? (
          <>
            <div className="mail-reader-head">
              <div className="col gap-8 grow">
                <div className="row gap-8">
                  <Tag>{selectedMessage.direction}</Tag>
                  <Tag tone={statusTone(selectedMessage.status)}>{selectedMessage.status}</Tag>
                </div>
                <h2 className="t-h2">{selectedMessage.subject ?? "(no subject)"}</h2>
                <div className="mail-meta">
                  <MailMeta label="From" value={formatAddressLine(selectedMessage.from)} />
                  <MailMeta label="To" value={formatAddressLine(selectedMessage.to)} />
                  {selectedMessage.cc.length ? <MailMeta label="Cc" value={formatAddressLine(selectedMessage.cc)} /> : null}
                  <MailMeta label="Mailbox" value={selectedMailbox?.address ?? selectedMessage.mailboxId} />
                  <MailMeta label="Date" value={formatMailDate(selectedMessage.receivedAt ?? selectedMessage.sentAt ?? selectedMessage.updatedAt)} />
                </div>
              </div>
            </div>
            <pre className="mail-body">{selectedMessage.bodyText ?? "No readable body content."}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function useMailboxColumns() {
  return useMemo<ColumnDef<MailboxSummary>[]>(
    () => [
      {
        header: "Mailbox",
        accessorKey: "address",
        cell: ({ row }) => (
          <div className="col gap-4">
            <span className="t-mono">{row.original.address}</span>
            <span className="t-tiny t-mute">{row.original.projectName ?? "organization"}{row.original.agentId ? ` / ${row.original.agentId}` : ""}</span>
          </div>
        ),
      },
      { header: "Messages", accessorKey: "messageCount" },
      { header: "Last mail", accessorKey: "lastMessageAt", cell: ({ row }) => <span className="t-mono t-mute">{relTime(row.original.lastMessageAt)}</span> },
    ],
    [],
  );
}

function MailMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="mail-meta-row">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function formatAddressLine(value: string[]) {
  return value.length ? value.join(", ") : "unknown";
}

function formatMailTime(value: number | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatMailDate(value: number | null) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "") || url;
}

function domainClaimTone(claim: DomainClaimSummary): "default" | "ok" | "warn" | "err" | "info" {
  if (claim.verificationStatus === "verified") return "ok";
  if (claim.verificationStatus === "failed" || claim.verificationStatus === "expired") return "err";
  return "warn";
}

function domainBindingTone(binding: DomainBindingSummary, claim?: DomainClaimSummary | null): "default" | "ok" | "warn" | "err" | "info" {
  if (isUnsupportedApexPagesBinding(binding, claim)) return "err";
  if (binding.status === "active") return "ok";
  if (binding.status === "failed" || binding.status === "disabled") return "err";
  if (binding.status === "pending") return "warn";
  return "default";
}

function domainBindingDisplayStatus(binding: DomainBindingSummary, claim?: DomainClaimSummary | null) {
  if (isUnsupportedApexPagesBinding(binding, claim)) return "unsupported";
  return binding.status;
}

function domainVerificationLabel(claim: DomainClaimSummary) {
  if (claim.verificationStatus === "verified") {
    return claim.verifiedAt ? `verified ${relTime(new Date(claim.verifiedAt))}` : "ownership verified";
  }
  const expected = claim.verification.expected;
  if (expected?.name && expected.value) {
    return `${expected.type ?? "TXT"} ${expected.name} = ${expected.value}`;
  }
  return claim.verification.lastCheckedAt ? `checked ${claim.verification.lastCheckedAt}` : "verification pending";
}

function domainReadinessLabel(binding: DomainBindingSummary, claim?: DomainClaimSummary | null) {
  const readiness = objectRecord(binding.readiness);
  const readinessStatus = typeof readiness.status === "string" ? readiness.status : binding.status;
  const reason = typeof readiness.reason === "string" ? readiness.reason : null;
  if (domainBindingIsReady(binding)) return "Ready";
  if (reason === "pages_apex_unsupported") {
    return "Check this hostname again to convert it to an apex redirect.";
  }
  if (readiness.mode === "redirect" && typeof readiness.redirectToHostname === "string") {
    return `Redirects to ${readiness.redirectToHostname}`;
  }
  if (
    reason === "cloudflare_custom_hostname_adapter_unimplemented" ||
    reason === "cloudflare_custom_hostname_not_checked" ||
    reason === "cloudflare_custom_hostname_pending"
  ) {
    return "Waiting for Pages edge provisioning.";
  }
  if (reason === "cloudflare_custom_hostname_adapter_unconfigured") {
    return "Pages edge provider is not configured.";
  }
  if (reason === "cloudflare_custom_hostname_provider_unauthorized") {
    return "Pages edge provider credentials need attention.";
  }
  if (reason === "cloudflare_custom_hostname_zone_unavailable") {
    return "Pages edge zone is not configured.";
  }
  if (reason === "cloudflare_custom_hostname_provider_rate_limited") {
    return "Pages edge provider is rate limited.";
  }
  if (reason === "cloudflare_custom_hostname_provider_failed") {
    return "Pages edge provisioning failed. Try Check again.";
  }
  if (readinessStatus === "pending") return "Waiting for Pages DNS.";
  if (reason) return `${readinessStatus} / ${reason}`;
  return String(readinessStatus);
}

function domainBindingSiteId(binding: DomainBindingSummary) {
  const readiness = objectRecord(binding.readiness);
  return typeof readiness.siteId === "string" ? readiness.siteId : null;
}

function domainBindingIsReady(binding: DomainBindingSummary) {
  const readiness = objectRecord(binding.readiness);
  const readinessStatus = typeof readiness.status === "string" ? readiness.status : binding.status;
  return binding.status === "active" || readinessStatus === "ready";
}

function hostnameIsUnderClaim(hostname: string, claimDomain: string) {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalizedHostname === claimDomain || normalizedHostname.endsWith(`.${claimDomain}`);
}

function recommendedPagesHostnameForClaim(claim: DomainClaimSummary) {
  return `www.${claim.domain}`;
}

function isUnsupportedApexPagesBinding(binding: DomainBindingSummary, claim?: DomainClaimSummary | null) {
  void binding;
  void claim;
  return false;
}

function domainBindingsWithoutReplacedUnsupportedApex(bindings: DomainBindingSummary[], claims: DomainClaimSummary[]) {
  return bindings.filter((binding) => {
    const claim = claims.find((item) => item.id === binding.claimId) ?? null;
    if (!isUnsupportedApexPagesBinding(binding, claim) || !claim) return true;
    const replacementHostname = recommendedPagesHostnameForClaim(claim);
    return !bindings.some(
      (candidate) =>
        candidate.id !== binding.id &&
        candidate.claimId === binding.claimId &&
        candidate.product === "pages" &&
        candidate.hostname === replacementHostname &&
        candidate.status !== "deleted" &&
        candidate.status !== "disabled",
    );
  });
}

function domainBindingDnsRecords(binding: DomainBindingSummary, claim?: DomainClaimSummary | null) {
  if (binding.product !== "pages" || isUnsupportedApexPagesBinding(binding, claim)) return [];
  if (domainBindingIsReady(binding)) return [];
  const readiness = objectRecord(binding.readiness);
  const dns = objectRecord(readiness.dns);
  const records = Array.isArray(dns.records) ? dns.records : [];
  const parsed = records.flatMap((record) => {
    const item = objectRecord(record);
    const type = typeof item.type === "string" ? item.type : null;
    const name = typeof item.name === "string" ? item.name : null;
    const value = typeof item.value === "string" ? item.value : null;
    return type && name && value ? [{ name, type, value }] : [];
  });
  if (parsed.length > 0) return parsed;
  return [{ name: binding.hostname, type: "CNAME", value: "cname.ravi.page" }];
}

function pageRouteHref(hostname: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `https://${hostname}${normalizedPath}`;
}

function pageOperatorOpenHref(url: string) {
  return `/api/pages/auth/start?returnTo=${encodeURIComponent(url)}`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function domainApiErrorMessage(error: unknown) {
  if (!(error instanceof ConsoleApiClientError)) return "Domain operation failed.";
  if (error.payload.error === "domain_unavailable") return "This domain is unavailable.";
  if (error.payload.error === "domain_claim_not_verified") return "Verify the domain claim first.";
  if (error.payload.error === "domain_binding_product_unavailable") return "This domain product is not available.";
  if (error.payload.error === "domain_binding_apex_unsupported") return "Check the existing apex binding to convert it to a redirect.";
  if (error.payload.error === "domain_binding_unavailable") return "This hostname is already bound.";
  if (error.payload.error === "domain_binding_conflict") return "The hostname must be inside the verified domain.";
  if (error.payload.error === "domain_binding_target_required") return "Select a binding target.";
  if (error.payload.error === "domain_binding_target_unavailable") return "The binding target is unavailable.";
  if (error.payload.error === "forbidden") return "You do not have permission for this action.";
  return "Domain operation failed.";
}

function knowledgeSourceStatusTone(status: string): "default" | "ok" | "warn" | "err" | "info" {
  if (status === "active") return "ok";
  if (status === "disabled") return "warn";
  if (status === "revoked" || status === "deleted") return "err";
  return "default";
}

function knowledgeSensitivityTone(sensitivity: string): "default" | "ok" | "warn" | "err" | "info" {
  if (sensitivity === "restricted") return "err";
  if (sensitivity === "confidential") return "warn";
  return "default";
}

function knowledgeApiErrorMessage(error: string) {
  if (error === "project_forbidden" || error === "forbidden") return "You do not have permission for this project.";
  if (error === "knowledge_source_not_found") return "That knowledge source is not available.";
  if (error === "validation_failed") return "Review the highlighted fields.";
  if (error === "payload_too_large") return "The payload is too large.";
  if (error === "unauthenticated") return "Sign in before continuing.";
  return "Knowledge operation failed.";
}

function NotFound() {
  return (
    <Card>
      <CardBody className="col gap-12">
        <SlashMark label="not found" num={0} />
        <h1 className="t-h1">404</h1>
        <div className="t-mute">That Console resource does not exist in the database.</div>
        <Button href="/projects">Back to projects</Button>
      </CardBody>
    </Card>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card>
      <CardBody className="col gap-12">
        <SlashMark label="loading" num={0} />
        <div className="t-mute">{label}</div>
      </CardBody>
    </Card>
  );
}

function apiErrorMessage(error: string) {
  if (error === "forbidden") return "You do not have permission for this action.";
  if (error === "unauthenticated") return "Sign in before continuing.";
  if (error === "slug_unavailable") return null;
  return "Project creation failed.";
}

function settingsApiErrorMessage(error: string) {
  if (error === "forbidden" || error === "project_forbidden") return "You do not have permission to update these settings.";
  if (error === "unauthenticated") return "Sign in before continuing.";
  if (error === "slug_unavailable") return null;
  if (error === "validation_failed") return "Review the highlighted fields.";
  return "Settings update failed.";
}

function memberApiErrorMessage(error: string) {
  if (error === "forbidden") return "You do not have permission to manage organization members.";
  if (error === "owner_required") return "Only an owner can change another owner or grant owner access.";
  if (error === "last_owner_required") return "The organization must keep at least one active owner.";
  if (error === "user_not_found") return "That user was not found.";
  if (error === "validation_failed") return "Review the highlighted member fields.";
  if (error === "unauthenticated") return "Sign in before continuing.";
  return "Member update failed.";
}
