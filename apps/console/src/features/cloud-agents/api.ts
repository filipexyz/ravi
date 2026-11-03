"use client";

// Reads and writes for cloud agents. Every call goes to the Console session
// envelope (`/api/console/cloud-agents/...`); query keys are scoped to the
// organization. A run's detail and events refresh on their own while it is
// active, and lists refresh while one of their runs is.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError, describeError } from "@/lib/api/client";
import { withOrganizationParam } from "@/lib/api/organization";
import { useOrgKey } from "@/features/shell/workspace";
import type { CloudLibraryAgent } from "@/server/console/cloud-agents/library-agents";
import type { CloudAgentsAvailability } from "@/server/console/cloud-agents/service";
import type {
  CloudAgent,
  CloudCredential,
  CloudRun,
  CloudRunEvent,
  CloudRunStatus,
  CloudSchedule,
} from "@/server/console/cloud-agents/types";

import { ACTIVE_LIST_REFRESH_MS, ACTIVE_RUN_REFRESH_MS, isActiveRun } from "./format";

const RUNS_PAGE = 25;
/** The events route answers at most this many per call. */
const EVENTS_PAGE = 200;
const EVENTS_MAX_PAGES = 10;

export function cloudPath(...parts: string[]) {
  return `/api/console/cloud-agents${parts.map((part) => `/${encodeURIComponent(part)}`).join("")}`;
}

/** The download link of a run output; a plain link can't send the organization header. */
export function outputHref(runId: string, outputId: string) {
  return withOrganizationParam(cloudPath("runs", runId, "outputs", outputId));
}

const CODE_TEXT: Record<string, string> = {
  cloud_agents_unconfigured: "Cloud agents aren't set up on this Console yet.",
  cloud_agents_not_enabled: "Cloud agents aren't turned on for this organization.",
  cloud_credential_missing: "Add the organization's Anthropic API key in Organization settings first.",
  cloud_credential_invalid: "Anthropic rejected the organization's API key. An owner or admin can replace it in Organization settings.",
  cloud_run_not_active: "This run no longer takes that action.",
  idempotency_conflict: "This request was already sent with different values. Try again.",
};

/** One sentence for a failed cloud agents call: the server's message when it has one. */
export function cloudErrorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status < 500 && error.message && error.message !== error.code) return error.message;
    if (CODE_TEXT[error.code]) return CODE_TEXT[error.code]!;
  }
  return describeError(error);
}

export function isMissingKey(error: unknown) {
  return error instanceof ApiError && (error.code === "cloud_credential_missing" || error.code === "cloud_credential_invalid");
}

export function useCloudAvailability() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ availability: CloudAgentsAvailability; viewerId: string }>(cloudPath("availability")),
    queryKey: orgKey("cloud-agents", "availability"),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Credential

export function useCloudCredential(enabled = true) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<{ credential: CloudCredential }>(cloudPath("credential")),
    queryKey: orgKey("cloud-agents", "credential"),
    select: (data) => data.credential,
  });
}

function useCredentialMutation<T>(send: (input: T) => Promise<{ credential: CloudCredential }>) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => queryClient.setQueryData(orgKey("cloud-agents", "credential"), data),
  });
}

export function useSetCloudCredential() {
  return useCredentialMutation((input: { apiKey: string; monthlyAlertUsd?: number | null }) =>
    api.post<{ credential: CloudCredential }>(cloudPath("credential"), { provider: "anthropic", ...input }),
  );
}

export function useSetCloudMonthlyAlert() {
  return useCredentialMutation((monthlyAlertUsd: number | null) =>
    api.post<{ credential: CloudCredential }>(cloudPath("credential", "alert"), { monthlyAlertUsd }),
  );
}

export function useRemoveCloudCredential() {
  return useCredentialMutation(() => api.post<{ credential: CloudCredential }>(cloudPath("credential", "remove")));
}

// ---------------------------------------------------------------------------
// Agents

export function useCloudAgents(projectId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ agents: CloudAgent[] }>(`${cloudPath("agents")}?project=${encodeURIComponent(projectId)}`),
    queryKey: orgKey("cloud-agents", projectId, "agents"),
    select: (data) => data.agents,
  });
}

export function useDeployableAgents(projectId: string, enabled = true) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<{ agents: CloudLibraryAgent[] }>(`${cloudPath("library-agents")}?project=${encodeURIComponent(projectId)}`),
    queryKey: orgKey("cloud-agents", projectId, "library-agents"),
    select: (data) => data.agents,
  });
}

export function useAgentHeartbeat(agentId: string | null) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: Boolean(agentId),
    queryFn: () => api.get<{ heartbeat: string | null }>(cloudPath("agents", agentId!, "heartbeat")),
    queryKey: orgKey("cloud-agents", "agents", agentId, "heartbeat"),
    select: (data) => data.heartbeat,
    staleTime: 5 * 60_000,
  });
}

export function useDeployCloudAgent(projectId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agent: string; version?: number }) =>
      api.post<{ agent: CloudAgent; changed: boolean; warnings: string[] }>(cloudPath("agents", "deploy"), { project: projectId, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", projectId) }),
  });
}

export function useArchiveCloudAgent(projectId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.post<{ agent: CloudAgent }>(cloudPath("agents", agentId, "archive")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", projectId) }),
  });
}

// ---------------------------------------------------------------------------
// Runs

export type RunFilter = "all" | "active" | "attention" | "finished";

const FILTER_STATUSES: Record<RunFilter, CloudRunStatus[] | null> = {
  all: null,
  active: ["starting", "running", "waiting_approval"],
  attention: ["waiting_approval", "failed", "budget_exceeded"],
  finished: ["completed", "failed", "stopped", "budget_exceeded"],
};

/** A page of runs, newest first; `cursor` continues from a previous page. */
export function useCloudRuns(projectId: string, options: { filter?: RunFilter; agentId?: string | null; cursor?: string | null } = {}) {
  const orgKey = useOrgKey();
  const filter = options.filter ?? "all";
  const params = new URLSearchParams({ project: projectId, limit: String(RUNS_PAGE) });
  const statuses = FILTER_STATUSES[filter];
  if (statuses) params.set("status", statuses.join(","));
  if (options.agentId) params.set("agent", options.agentId);
  if (options.cursor) params.set("cursor", options.cursor);
  return useQuery({
    queryFn: () => api.get<{ runs: CloudRun[]; cursor: string | null }>(`${cloudPath("runs")}?${params.toString()}`),
    queryKey: orgKey("cloud-agents", projectId, "runs", filter, options.agentId ?? null, options.cursor ?? null),
    refetchInterval: (query) => (query.state.data?.runs.some(isActiveRun) ? ACTIVE_LIST_REFRESH_MS : false),
  });
}

export function useCloudRun(runId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ run: CloudRun }>(cloudPath("runs", runId)),
    queryKey: orgKey("cloud-agents", "run", runId),
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return run && isActiveRun(run) ? ACTIVE_RUN_REFRESH_MS : false;
    },
    select: (data) => data.run,
  });
}

type EventsData = { events: CloudRunEvent[]; cursor: string | null };

/**
 * The run's events, oldest first. Each refresh asks only for what came after
 * the last one it has and appends it, so a long run is read once.
 */
export function useCloudRunEvents(runId: string, live: boolean) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  const queryKey = orgKey("cloud-agents", "run", runId, "events");
  return useQuery({
    queryFn: async (): Promise<EventsData> => {
      const previous = queryClient.getQueryData<EventsData>(queryKey);
      const events = [...(previous?.events ?? [])];
      let cursor = previous?.cursor ?? null;
      for (let page = 0; page < EVENTS_MAX_PAGES; page += 1) {
        const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
        const next = await api.get<EventsData>(`${cloudPath("runs", runId, "events")}${query}`);
        const known = new Set(events.map((event) => event.seq));
        events.push(...next.events.filter((event) => !known.has(event.seq)));
        cursor = next.cursor ?? cursor;
        if (next.events.length < EVENTS_PAGE) break;
      }
      return { events, cursor };
    },
    queryKey,
    refetchInterval: live ? ACTIVE_RUN_REFRESH_MS : false,
  });
}

function useRunMutation<T>(runId: string, send: (input: T) => Promise<{ run: CloudRun }>) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      queryClient.setQueryData(orgKey("cloud-agents", "run", runId), { run: data.run });
      void queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", "run", runId) });
      void queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", data.run.projectId, "runs") });
    },
  });
}

export function useStartCloudRun(projectId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agent: string; prompt: string; budgetUsd?: number; idempotencyKey: string }) =>
      api.post<{ run: CloudRun }>(cloudPath("runs"), { project: projectId, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", projectId, "runs") }),
  });
}

export function useSendCloudRunMessage(runId: string) {
  return useRunMutation(runId, (text: string) => api.post<{ run: CloudRun }>(cloudPath("runs", runId, "messages"), { text }));
}

export function useStopCloudRun(runId: string) {
  return useRunMutation(runId, () => api.post<{ run: CloudRun }>(cloudPath("runs", runId, "stop")));
}

export function useDecideCloudApproval(runId: string) {
  return useRunMutation(runId, (input: { approvalId: string; decision: "approve" | "deny"; reason?: string }) =>
    api.post<{ run: CloudRun }>(cloudPath("runs", runId, "approvals", input.approvalId), {
      decision: input.decision,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Schedules

export type ScheduleInput = {
  cron: string;
  timezone: string;
  prompt: string | null;
  budgetUsd: number | null;
  enabled?: boolean;
};

export function useCloudSchedules(projectId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ schedules: CloudSchedule[] }>(`${cloudPath("schedules")}?project=${encodeURIComponent(projectId)}`),
    queryKey: orgKey("cloud-agents", projectId, "schedules"),
    select: (data) => data.schedules,
  });
}

function useScheduleMutation<T, R>(projectId: string, send: (input: T) => Promise<R>) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("cloud-agents", projectId, "schedules") }),
  });
}

export function useCreateCloudSchedule(projectId: string) {
  return useScheduleMutation(projectId, (input: ScheduleInput & { agent: string }) =>
    api.post<{ schedule: CloudSchedule }>(cloudPath("schedules"), { project: projectId, ...input }),
  );
}

export function useUpdateCloudSchedule(projectId: string) {
  return useScheduleMutation(projectId, ({ id, ...input }: Partial<ScheduleInput> & { id: string }) =>
    api.post<{ schedule: CloudSchedule }>(cloudPath("schedules", id), input),
  );
}

export function useDeleteCloudSchedule(projectId: string) {
  return useScheduleMutation(projectId, (id: string) => api.post<{ deleted: true; id: string }>(cloudPath("schedules", id, "delete")));
}
