"use client";

import * as Sentry from "@sentry/nextjs";
import { useMutation, useQuery } from "@tanstack/react-query";

import { organizationHeaders } from "@/lib/api/organization";

import type {
  AdminBugListFilters,
  AdminBugReportDetail,
  AdminBugReportList,
  Artifact,
  ArtifactVersion,
  BugReportPriority,
  BugReportStatus,
  ConsoleFeatureAccessData,
  DomainClaimsData,
  Event,
  BugReportDetail,
  BugReportList,
  FeedbackData,
  FeedbackItem,
  FeedbackKind,
  FeedbackSeverity,
  FeedbackSource,
  KnowledgeSensitivity,
  KnowledgeIngestionResult,
  KnowledgeRetrievalResult,
  KnowledgeSourceSummary,
  KnowledgeSourceType,
  MailOverviewData,
  ManagedRaviAggregate,
  ManagedRaviCommandResponse,
  ManagedRaviInstancesData,
  ManagedRaviOperationAction,
  ManagedRaviSessionData,
  ManagedRaviSessionEventsData,
  OrganizationRole,
  Org,
  PageRouteMatchType,
  PageSiteDetail,
  PageSiteSummary,
  PublishedPageSummary,
  Project,
  ProjectGithubAppConfig,
  RaviControlChatData,
  RaviControlInstallationsData,
  RaviControlMessageResponse,
  RaviControlOperationResponse,
  RuntimeRunDetail,
  RuntimeRunsData,
  SettingsData,
  Visibility,
} from "./types";

export type CreateProjectInput = {
  name: string;
  slug: string;
  description?: string | null;
  defaultVisibility?: Visibility;
  createDefaultPageSite?: boolean;
  defaultPageSiteSlug?: string | null;
};

export type CreateProjectResponse = {
  project: Project;
  redirectTo: string;
};

export type CreatePageSiteInput = {
  slug: string;
  defaultVisibility?: Visibility;
};

export type CreatePageSiteReleaseInput = {
  projectRef: string;
  routes: Array<{
    path: string;
    matchType: PageRouteMatchType;
    priority?: number;
    artifactVersionId: string;
    entrypoint?: string;
    assetBase?: string;
    visibility?: Visibility;
  }>;
  activate?: boolean;
  replaceRelease?: boolean;
  reason?: string | null;
};

export type CreateMailDomainInput = {
  domain: string;
};

export type CreateDomainClaimInput = {
  domain: string;
  ownershipMode?: "customer_managed" | "ravi_managed";
};

export type CreateDomainBindingInput = {
  claimId: string;
  hostname?: string;
  product: "pages";
  target?: {
    siteId?: string;
  };
};

export type CreateMailboxInput = {
  agentId?: string | null;
  domainRef: string;
  localPart: string;
};

export type UpdateSettingsInput = {
  scope: "org" | "project";
  projectId?: string;
  name: string;
  slug: string;
  visibility?: Visibility;
};

export type UpsertOrganizationMemberInput = {
  email: string;
  role: OrganizationRole;
};

export type RemoveOrganizationMemberInput = {
  userRef: string;
};

export type SubmitFeedbackInput = {
  kind?: FeedbackKind;
  severity?: FeedbackSeverity;
  title?: string | null;
  message: string;
  surface?: string | null;
  projectRef?: string | null;
  url?: string | null;
  tags?: string[] | string;
  source?: FeedbackSource;
  metadata?: Record<string, unknown>;
};

export type CreateKnowledgeSourceInput = {
  sourceType?: KnowledgeSourceType;
  title: string;
  description?: string | null;
  sensitivity?: KnowledgeSensitivity;
  sourceRef?: Record<string, unknown>;
  retentionPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  allowedConsumers?: string[];
};

export type CreateKnowledgeIngestionInput = {
  content: string;
  title?: string | null;
  mimeType?: string | null;
  language?: string | null;
  filename?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateKnowledgeRetrievalInput = {
  query: string;
  limit?: number;
  sourceIds?: string[];
  strategyKey?: string;
  metadata?: Record<string, unknown>;
};

export type CreateManagedRaviInput = {
  displayName: string;
  idempotencyKey: string;
};

export type ManagedRaviOperationInput = {
  action: ManagedRaviOperationAction;
  backupRef?: string;
  idempotencyKey: string;
};

export type ManagedRaviCommandInput = {
  action: "session_sync" | "prompt_send" | "turn_interrupt";
  idempotencyKey: string;
  prompt?: string;
};

export type RaviControlMessageInput = {
  clientMessageId: string;
  idempotencyKey: string;
  replyToMessageId?: string;
  targetAgentId?: string;
  text: string;
};

export type RaviControlSyncInput = {
  idempotencyKey: string;
  targetAgentId?: string;
};

export type RaviControlInterruptInput = RaviControlSyncInput & {
  targetCommandId?: string;
};

type ConsoleApiErrorPayload = {
  error: string;
  eventId?: string;
  fieldErrors?: Record<string, string>;
};

export class ConsoleApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ConsoleApiErrorPayload,
  ) {
    super(payload.error);
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json", ...organizationHeaders() },
  });

  if (!response.ok) {
    const payload = await tryReadConsoleApiError(response) ?? { error: `Console API failed ${response.status}: ${path}` };
    captureConsoleApiFailure({ method: "GET", path, payload, response });
    throw new ConsoleApiClientError(response.status, payload);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...organizationHeaders(),
    },
    method: "POST",
  });

  if (!response.ok) {
    const payload = await tryReadConsoleApiError(response) ?? { error: `Console API failed ${response.status}: ${path}` };
    captureConsoleApiFailure({ method: "POST", path, response, payload });
    throw new ConsoleApiClientError(response.status, payload);
  }

  return response.json() as Promise<T>;
}

async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json", ...organizationHeaders() },
    method: "DELETE",
  });

  if (!response.ok) {
    const payload = await tryReadConsoleApiError(response) ?? { error: `Console API failed ${response.status}: ${path}` };
    captureConsoleApiFailure({ method: "DELETE", path, response, payload });
    throw new ConsoleApiClientError(response.status, payload);
  }

  return response.json() as Promise<T>;
}

export function useOrganization() {
  return useQuery({
    queryKey: ["console", "organization"],
    queryFn: () => fetchJson<Org>("/api/console/organization"),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["console", "projects"],
    queryFn: () => fetchJson<Project[]>("/api/console/projects"),
  });
}

export function useCreateProject() {
  return useMutation({
    mutationFn: (input: CreateProjectInput) => postJson<CreateProjectResponse>("/api/console/projects", input),
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: ["console", "projects", projectId],
    enabled: Boolean(projectId),
    queryFn: () => fetchJson<Project | null>(`/api/console/projects/${projectId as string}`),
  });
}

export function useArtifacts(projectId: string) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "artifacts"],
    queryFn: () => fetchJson<Artifact[]>(`/api/console/projects/${projectId}/artifacts`),
  });
}

export function useKnowledgeSources(projectId: string | undefined) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "knowledge", "sources"],
    enabled: Boolean(projectId),
    queryFn: () => fetchJson<KnowledgeSourceSummary[]>(`/api/console/projects/${projectId as string}/knowledge/sources`),
  });
}

export function useKnowledgeSource(projectId: string | undefined, sourceId: string | undefined) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "knowledge", "sources", sourceId],
    enabled: Boolean(projectId && sourceId),
    queryFn: () =>
      fetchJson<KnowledgeSourceSummary | null>(
        `/api/console/projects/${projectId as string}/knowledge/sources/${sourceId as string}`,
      ),
  });
}

export function useCreateKnowledgeSource(projectId: string) {
  return useMutation({
    mutationFn: (input: CreateKnowledgeSourceInput) =>
      postJson<KnowledgeSourceSummary>(`/api/console/projects/${projectId}/knowledge/sources`, input),
  });
}

export function useDeleteKnowledgeSource(projectId: string) {
  return useMutation({
    mutationFn: (sourceId: string) =>
      deleteJson<KnowledgeSourceSummary>(`/api/console/projects/${projectId}/knowledge/sources/${sourceId}`),
  });
}

export function useCreateKnowledgeIngestion(projectId: string, sourceId: string) {
  return useMutation({
    mutationFn: (input: CreateKnowledgeIngestionInput) =>
      postJson<KnowledgeIngestionResult>(
        `/api/console/projects/${projectId}/knowledge/sources/${sourceId}/ingestions`,
        input,
      ),
  });
}

export function useCreateKnowledgeRetrieval(projectId: string) {
  return useMutation({
    mutationFn: (input: CreateKnowledgeRetrievalInput) =>
      postJson<KnowledgeRetrievalResult>(`/api/console/projects/${projectId}/knowledge/retrieval-runs`, input),
  });
}

export function usePageSites(projectId: string | undefined) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "pages", "sites"],
    enabled: Boolean(projectId),
    queryFn: () => fetchJson<PageSiteSummary[]>(`/api/console/projects/${projectId as string}/pages`),
  });
}

export function usePublishedPages(projectId: string | undefined) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "published-pages"],
    enabled: Boolean(projectId),
    queryFn: () => fetchJson<PublishedPageSummary[]>(`/api/console/projects/${projectId as string}/published-pages`),
  });
}

export function usePageSite(projectId: string, siteId: string) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "pages", "sites", siteId],
    queryFn: () => fetchJson<PageSiteDetail | null>(`/api/console/projects/${projectId}/pages/${siteId}`),
  });
}

export type ViewerAssertionAudience = {
  audience: string;
  id: string;
  organizationId: string;
  origins: string[];
  projectId: string;
  siteId: string;
  status: "active" | "disabled";
  updatedAt: string;
};

export function useViewerAssertionAudiences(projectId: string, siteId: string) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "pages", "sites", siteId, "viewer-assertion-audiences"],
    queryFn: () =>
      fetchJson<{ items: ViewerAssertionAudience[] }>(
        `/api/console/projects/${projectId}/pages/${siteId}/viewer-assertion-audiences`,
      ),
  });
}

export function useCreateViewerAssertionAudience(projectId: string, siteId: string) {
  return useMutation({
    mutationFn: (input: { audience: string; origins: string[] }) =>
      postJson<ViewerAssertionAudience>(
        `/api/console/projects/${projectId}/pages/${siteId}/viewer-assertion-audiences`,
        input,
      ),
  });
}

export function useDeleteViewerAssertionAudience(projectId: string, siteId: string) {
  return useMutation({
    mutationFn: (audienceId: string) =>
      deleteJson<{ id: string }>(
        `/api/console/projects/${projectId}/pages/${siteId}/viewer-assertion-audiences/${audienceId}`,
      ),
  });
}

export function useCreatePageSite(projectId: string) {
  return useMutation({
    mutationFn: (input: CreatePageSiteInput) =>
      postJson<PageSiteSummary>(`/api/console/projects/${projectId}/pages`, input),
  });
}

export function useCreatePageSiteRelease(siteId: string) {
  return useMutation({
    mutationFn: (input: CreatePageSiteReleaseInput) =>
      postJson<{ release: PageSiteDetail["activeRelease"]; routes: PageSiteDetail["activeRoutes"] }>(
        `/api/console/pages/sites/${siteId}/releases`,
        input,
      ),
  });
}

export function useActivatePageSiteRelease(siteId: string) {
  return useMutation({
    mutationFn: (releaseId: string) =>
      postJson<PageSiteReleaseActivationResponse>(`/api/console/pages/sites/${siteId}/releases/${releaseId}/activate`, {}),
  });
}

type PageSiteReleaseActivationResponse = PageSiteDetail["activeRelease"];

export function useArtifact(artifactId: string) {
  return useQuery({
    queryKey: ["console", "artifacts", artifactId],
    queryFn: () => fetchJson<Artifact | null>(`/api/console/artifacts/${artifactId}`),
  });
}

export function useEvents(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return useQuery({
    queryKey: ["console", "events", projectId ?? "organization"],
    queryFn: () => fetchJson<Event[]>(`/api/console/events${query}`),
  });
}

export function useFeedback(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return useQuery({
    queryKey: ["console", "feedback", projectId ?? "organization"],
    queryFn: () => fetchJson<FeedbackData>(`/api/console/feedback${query}`),
  });
}

export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: SubmitFeedbackInput) => postJson<FeedbackItem>("/api/console/feedback", input),
  });
}

export function useBugReports() {
  return useQuery({
    queryKey: ["console", "bugs"],
    queryFn: () => fetchJson<BugReportList>("/api/console/bugs"),
  });
}

export function useBugReport(id: string | null) {
  return useQuery({
    queryKey: ["console", "bugs", id],
    enabled: Boolean(id),
    queryFn: () => fetchJson<BugReportDetail>(`/api/console/bugs/${id as string}`),
  });
}

function adminBugListQuery(filters: AdminBugListFilters) {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.priority) query.set("priority", filters.priority);
  if (filters.surface) query.set("surface", filters.surface);
  if (filters.q) query.set("q", filters.q);
  if (filters.assigneeUserId) query.set("assigneeUserId", filters.assigneeUserId);
  if (filters.limit) query.set("limit", String(filters.limit));
  if (filters.offset) query.set("offset", String(filters.offset));
  const encoded = query.toString();
  return encoded ? `/api/console/manage/bugs?${encoded}` : "/api/console/manage/bugs";
}

export function useAdminBugReports(filters: AdminBugListFilters) {
  return useQuery({
    queryKey: ["console", "manage", "bugs", filters],
    queryFn: () => fetchJson<AdminBugReportList>(adminBugListQuery(filters)),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((item) => !item.triage && (item.triageJob?.status === "queued" || item.triageJob?.status === "running"))
        ? 8000
        : false;
    },
  });
}

export function useAdminBugReport(id: string | null) {
  return useQuery({
    queryKey: ["console", "manage", "bugs", "detail", id],
    enabled: Boolean(id),
    queryFn: () => fetchJson<AdminBugReportDetail>(`/api/console/manage/bugs/${id as string}`),
    refetchInterval: (query) => {
      const report = query.state.data;
      return report && !report.triageJson && (report.triageJob?.status === "queued" || report.triageJob?.status === "running")
        ? 4000
        : false;
    },
  });
}

export type UpdateAdminBugStatusInput = {
  status: BugReportStatus;
  statusNote?: string | null;
  priority?: BugReportPriority | null;
  duplicateOf?: string | null;
  assigneeUserId?: string | null;
};

export type ApplyAdminBugTriageInput = {
  applyPriority?: boolean;
  applyStatus?: boolean;
  applyDuplicate?: boolean;
  priority?: BugReportPriority;
  status?: BugReportStatus;
  duplicateOf?: string;
};

export function useUpdateAdminBugStatus(id: string) {
  return useMutation({
    mutationFn: (input: UpdateAdminBugStatusInput) =>
      postJson<AdminBugReportDetail>(`/api/console/manage/bugs/${id}/status`, input),
  });
}

export function useApplyAdminBugTriage(id: string) {
  return useMutation({
    mutationFn: (input: ApplyAdminBugTriageInput) =>
      postJson<AdminBugReportDetail>(`/api/console/manage/bugs/${id}/apply-triage`, input),
  });
}

export function useStoreAdminBugTriage(id: string) {
  return useMutation({
    mutationFn: (triage: unknown) =>
      postJson<AdminBugReportDetail>(`/api/console/manage/bugs/${id}/triage`, { triage }),
  });
}

export function useEnqueueAdminBugTriage(id: string) {
  return useMutation({
    mutationFn: () => postJson<AdminBugReportDetail>(`/api/console/manage/bugs/${id}/triage`, {}),
  });
}

export type DeleteAdminBugReportResult = {
  id: string;
  deleted: true;
};

export function useDeleteAdminBugReport(id: string) {
  return useMutation({
    mutationFn: () => deleteJson<DeleteAdminBugReportResult>(`/api/console/manage/bugs/${id}`),
  });
}

export function useRuntimeRuns(projectId?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["console", "runs", projectId ?? "organization"],
    enabled: options.enabled ?? true,
    queryFn: () =>
      fetchJson<RuntimeRunsData | null>(
        projectId ? `/api/console/projects/${projectId}/runs` : "/api/console/runs",
      ),
  });
}

export function useRuntimeRunDetail(traceSessionId: string | null) {
  return useQuery({
    queryKey: ["console", "runs", "detail", traceSessionId],
    enabled: Boolean(traceSessionId),
    queryFn: () => fetchJson<RuntimeRunDetail | null>(`/api/console/runs/${traceSessionId as string}`),
  });
}

export function useManagedRavis(projectId: string) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "managed-ravis"],
    queryFn: () =>
      fetchJson<ManagedRaviInstancesData>(
        `/api/console/projects/${projectId}/managed-runtime/instances`,
      ),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((item) => managedRaviIsTransitioning(item)) ? 1_500 : 10_000;
    },
  });
}

export function useManagedRavi(projectId: string, instanceId: string | null) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "managed-ravis", instanceId],
    enabled: Boolean(instanceId),
    queryFn: () =>
      fetchJson<ManagedRaviAggregate>(
        `/api/console/projects/${projectId}/managed-runtime/instances/${instanceId as string}`,
      ),
    refetchInterval: (query) =>
      query.state.data && managedRaviIsTransitioning(query.state.data) ? 1_000 : 5_000,
  });
}

export function useCreateManagedRavi(projectId: string) {
  return useMutation({
    mutationFn: (input: CreateManagedRaviInput) =>
      postJson<ManagedRaviAggregate>(
        `/api/console/projects/${projectId}/managed-runtime/instances`,
        input,
      ),
  });
}

export function useManagedRaviOperation(projectId: string, instanceId: string) {
  return useMutation({
    mutationFn: (input: ManagedRaviOperationInput) =>
      postJson<ManagedRaviAggregate>(
        `/api/console/projects/${projectId}/managed-runtime/instances/${instanceId}/operations`,
        input,
      ),
  });
}

export function useManagedRaviSession(
  projectId: string,
  instanceId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "managed-ravis", instanceId, "session"],
    enabled: (options.enabled ?? true) && Boolean(instanceId),
    queryFn: () =>
      fetchJson<ManagedRaviSessionData>(
        `/api/console/projects/${projectId}/managed-runtime/instances/${instanceId as string}/sessions/current`,
      ),
    refetchInterval: (query) => {
      const commands = query.state.data?.commands ?? [];
      return commands.some((command) => ["pending", "claimed", "running"].includes(command.status))
        ? 1_000
        : 5_000;
    },
  });
}

export function useManagedRaviEvents(
  projectId: string,
  instanceId: string | null,
  sessionId: string | null,
) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "managed-ravis", instanceId, "sessions", sessionId, "events"],
    enabled: Boolean(instanceId && sessionId),
    queryFn: () =>
      fetchJson<ManagedRaviSessionEventsData>(
        `/api/console/projects/${projectId}/managed-runtime/instances/${instanceId as string}/sessions/${sessionId as string}/events?after=0&limit=100`,
      ),
    refetchInterval: 10_000,
  });
}

export function useManagedRaviCommand(
  projectId: string,
  instanceId: string,
  sessionId: string,
) {
  return useMutation({
    mutationFn: (input: ManagedRaviCommandInput) =>
      postJson<ManagedRaviCommandResponse>(
        `/api/console/projects/${projectId}/managed-runtime/instances/${instanceId}/sessions/${sessionId}/commands`,
        input,
      ),
  });
}

export function useRaviControlChat(
  projectId: string,
  instanceId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "ravi-control", instanceId, "chat"],
    enabled: (options.enabled ?? true) && Boolean(instanceId),
    queryFn: () =>
      fetchJson<RaviControlChatData>(
        `/api/console/projects/${projectId}/ravi-control/instances/${instanceId as string}/chat`,
      ),
    refetchInterval: (query) =>
      query.state.data?.messages.some((message) =>
        ["queued", "accepted"].includes(message.status),
      )
        ? 1_000
        : 5_000,
  });
}

export function useRaviControlInstallations() {
  return useQuery({
    queryKey: ["console", "ravi-control", "installations"],
    queryFn: () =>
      fetchJson<RaviControlInstallationsData>(
        "/api/console/organizations/current/control/installations",
      ),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => managedRaviIsTransitioning(item))
        ? 1_500
        : 10_000,
  });
}

export function useSendRaviControlMessage(projectId: string, instanceId: string) {
  return useMutation({
    mutationFn: (input: RaviControlMessageInput) =>
      postJson<RaviControlMessageResponse>(
        `/api/console/projects/${projectId}/ravi-control/instances/${instanceId}/chat/messages`,
        input,
      ),
  });
}

export function useSyncRaviControlChat(projectId: string, instanceId: string) {
  return useMutation({
    mutationFn: (input: RaviControlSyncInput) =>
      postJson<RaviControlOperationResponse>(
        `/api/console/projects/${projectId}/ravi-control/instances/${instanceId}/chat/sync`,
        input,
      ),
  });
}

export function useInterruptRaviControlTurn(projectId: string, instanceId: string) {
  return useMutation({
    mutationFn: (input: RaviControlInterruptInput) =>
      postJson<RaviControlOperationResponse>(
        `/api/console/projects/${projectId}/ravi-control/instances/${instanceId}/chat/interrupt`,
        input,
      ),
  });
}

export function useArtifactVersions(artifactId: string) {
  return useQuery({
    queryKey: ["console", "artifacts", artifactId, "versions"],
    queryFn: () => fetchJson<ArtifactVersion[]>(`/api/console/artifacts/${artifactId}/versions`),
  });
}

export function useOrgs() {
  return useQuery({
    queryKey: ["console", "organizations"],
    queryFn: () => fetchJson<Org[]>("/api/console/organizations"),
  });
}

export function useConsoleFeatures() {
  return useQuery({
    queryKey: ["console", "features"],
    queryFn: () => fetchJson<ConsoleFeatureAccessData>("/api/console/features"),
  });
}

export function useMailOverview(projectId?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["console", "mail", projectId ?? "organization"],
    enabled: options.enabled ?? true,
    queryFn: () =>
      fetchJson<MailOverviewData>(
        projectId ? `/api/console/projects/${projectId}/mail` : "/api/console/mail",
      ),
  });
}

export function useProjectGithubApp(
  projectId: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: ["console", "projects", projectId, "github-app"],
    enabled: options.enabled ?? Boolean(projectId),
    queryFn: () => fetchJson<ProjectGithubAppConfig | null>(`/api/console/projects/${projectId}/github-app`),
    refetchInterval: options.refetchInterval,
  });
}

export function useCreateMailDomain() {
  return useMutation({
    mutationFn: (input: CreateMailDomainInput) =>
      postJson<unknown>("/api/console/mail/domains", input),
  });
}

export function useDomainClaims(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["console", "domains"],
    enabled: options.enabled ?? true,
    queryFn: () => fetchJson<DomainClaimsData>("/api/console/domains"),
  });
}

export function useCreateDomainClaim() {
  return useMutation({
    mutationFn: (input: CreateDomainClaimInput) =>
      postJson<unknown>("/api/console/domains/claims", input),
  });
}

export function useVerifyDomainClaim() {
  return useMutation({
    mutationFn: (claimId: string) =>
      postJson<unknown>(`/api/console/domains/claims/${claimId}/verify`, {}),
  });
}

export function useCreateDomainBinding() {
  return useMutation({
    mutationFn: (input: CreateDomainBindingInput) =>
      postJson<unknown>(`/api/console/domains/claims/${input.claimId}/bindings`, {
        hostname: input.hostname,
        product: input.product,
        target: input.target,
      }),
  });
}

export function useCheckDomainBinding() {
  return useMutation({
    mutationFn: (bindingId: string) =>
      postJson<unknown>(`/api/console/domains/bindings/${bindingId}/check`, {}),
  });
}

export function useCreateMailbox(projectId?: string) {
  return useMutation({
    mutationFn: (input: CreateMailboxInput) =>
      postJson<unknown>(
        projectId ? `/api/console/projects/${projectId}/mail/mailboxes` : "/api/console/mail/mailboxes",
        input,
      ),
  });
}

export function useSettings(scope: "org" | "project", projectId?: string) {
  const query = new URLSearchParams({ scope });
  if (projectId) query.set("projectId", projectId);

  return useQuery({
    queryKey: ["console", "settings", scope, projectId ?? "current"],
    queryFn: () => fetchJson<SettingsData | null>(`/api/console/settings?${query.toString()}`),
  });
}

export function useUpdateSettings() {
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => postJson<SettingsData>("/api/console/settings", input),
  });
}

export function useUpsertOrganizationMember() {
  return useMutation({
    mutationFn: (input: UpsertOrganizationMemberInput) =>
      postJson<SettingsData>("/api/console/settings/members/upsert", input),
  });
}

export function useRemoveOrganizationMember() {
  return useMutation({
    mutationFn: (input: RemoveOrganizationMemberInput) =>
      postJson<SettingsData>("/api/console/settings/members/remove", input),
  });
}

function captureConsoleApiFailure({
  method,
  path,
  payload,
  response,
}: {
  method: string;
  path: string;
  payload?: ConsoleApiErrorPayload;
  response: Response;
}) {
  if (response.status < 500) return;
  Sentry.captureMessage("Console API request failed", {
    level: "error",
    tags: {
      feature: "console-api",
      method,
      status: String(response.status),
      surface: "console-client",
    },
    contexts: {
      consoleApi: {
        error: payload?.error ?? null,
        eventId: payload?.eventId ?? null,
        path,
        status: response.status,
      },
    },
  });
}

async function tryReadConsoleApiError(response: Response): Promise<ConsoleApiErrorPayload | null> {
  try {
    return (await response.json()) as ConsoleApiErrorPayload;
  } catch {
    return null;
  }
}

function managedRaviIsTransitioning(value: ManagedRaviAggregate) {
  return [
    "provisioning",
    "starting",
    "stopping",
    "restarting",
    "deleting",
  ].includes(value.instance.observedState);
}
