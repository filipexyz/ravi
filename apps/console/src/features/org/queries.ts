"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api/client";
import type {
  DomainClaimSummary,
  DomainClaimsData,
  Event,
  FeedbackData,
  OrganizationGithubConfig,
  OrganizationRole,
  OrganizationSettingsData,
  PageSiteSummary,
  Project,
  SettingsData,
} from "@/features/console/types";
import { useOrgKey } from "@/features/shell/workspace";

/**
 * A 4xx answer (no access, not found, bad request) won't change on its own,
 * so show it right away instead of retrying for several seconds.
 */
function retryUnlessClientError(failureCount: number, error: unknown) {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/** Organization metadata only; membership has its own action/DTO/endpoint. */
export function useOrgSettings(options: { enabled?: boolean } = {}) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.get<OrganizationSettingsData>("/api/console/settings?scope=org"),
    retry: retryUnlessClientError,
    queryKey: orgKey("settings", "org"),
  });
}

export function useSaveOrgSettings() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      api.post<OrganizationSettingsData>("/api/console/settings", { name: input.name, scope: "org", slug: input.slug }),
    onSuccess: async (settings) => {
      queryClient.setQueryData(orgKey("settings", "org"), settings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey("organizations") }),
        queryClient.invalidateQueries({ queryKey: orgKey("events") }),
      ]);
    },
  });
}

export function useUpsertMember() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { email: string; role: OrganizationRole }) =>
      api.post<SettingsData>("/api/console/settings/members/upsert", input),
    onSuccess: async (settings) => {
      queryClient.setQueryData(orgKey("settings", "org"), settings);
      await queryClient.invalidateQueries({ queryKey: orgKey("events") });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { userRef: string }) => api.post<SettingsData>("/api/console/settings/members/remove", input),
    onSuccess: async (settings) => {
      queryClient.setQueryData(orgKey("settings", "org"), settings);
      await queryClient.invalidateQueries({ queryKey: orgKey("events") });
    },
  });
}

export type OrganizationInvite = {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedBy: string | null;
  role: OrganizationRole;
};

/** Invites still waiting to be accepted (owner/admin only). */
export function useOrgInvites(options: { enabled?: boolean } = {}) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.get<{ invites: OrganizationInvite[] }>("/api/console/settings/invites"),
    retry: retryUnlessClientError,
    queryKey: orgKey("settings", "invites"),
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { email: string; role: OrganizationRole }) =>
      api.post<{ invite: OrganizationInvite; url: string }>("/api/console/settings/invites/create", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey("settings", "invites") }),
        queryClient.invalidateQueries({ queryKey: orgKey("events") }),
      ]);
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: { inviteId: string }) =>
      api.post<{ revoked: boolean }>("/api/console/settings/invites/revoke", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey("settings", "invites") }),
        queryClient.invalidateQueries({ queryKey: orgKey("events") }),
      ]);
    },
  });
}

/** Domain ownership claims and the hostnames bound under them. */
export function useDomainInventory(options: { enabled?: boolean } = {}) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.get<DomainClaimsData>("/api/console/domains"),
    retry: retryUnlessClientError,
    queryKey: orgKey("domains"),
  });
}

export function useAddDomain() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (domain: string) =>
      api.post<{ claim: DomainClaimSummary }>("/api/console/domains/claims", { domain, ownershipMode: "customer_managed" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey("domains") }),
        queryClient.invalidateQueries({ queryKey: orgKey("events") }),
      ]);
    },
  });
}

export function useVerifyDomain() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (claimId: string) =>
      api.post<{ claim: DomainClaimSummary }>(`/api/console/domains/claims/${encodeURIComponent(claimId)}/verify`, {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orgKey("domains") }),
        queryClient.invalidateQueries({ queryKey: orgKey("events") }),
      ]);
    },
  });
}

/**
 * Page hosts of every project, to name the project and host behind each
 * custom hostname. Only runs when there is a hostname to name.
 */
export function usePageSitesByProject(projects: Project[], enabled: boolean) {
  const orgKey = useOrgKey();
  return useQueries({
    queries: projects.map((project) => ({
      enabled,
      queryFn: () => api.get<PageSiteSummary[]>(`/api/console/projects/${encodeURIComponent(project.id)}/pages`),
      retry: retryUnlessClientError,
      queryKey: orgKey("projects", project.id, "pages"),
      staleTime: 60_000,
    })),
  });
}

/** The organization's audit events, newest first (the server keeps the latest 200). */
export function useOrgEvents(projectId?: string) {
  const orgKey = useOrgKey();
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return useQuery({
    queryFn: () => api.get<Event[]>(`/api/console/events${query}`),
    retry: retryUnlessClientError,
    queryKey: orgKey("events", projectId ?? "all"),
  });
}

export function useFeedbackList() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<FeedbackData>("/api/console/feedback"),
    retry: retryUnlessClientError,
    queryKey: orgKey("feedback", "list"),
  });
}

/** The organization's linked GitHub accounts, and what the signed-in GitHub user can still link. */
export function useOrgGithub(options: { enabled?: boolean } = {}) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.get<OrganizationGithubConfig>("/api/console/github"),
    retry: retryUnlessClientError,
    queryKey: orgKey("github", "org"),
  });
}

export function useLinkGithubInstallation() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (installationId: string) =>
      api.post<OrganizationGithubConfig>("/api/console/github/installations", { installationId }),
    onSuccess: async (config) => {
      queryClient.setQueryData(orgKey("github", "org"), config);
      await queryClient.invalidateQueries({ queryKey: orgKey("projects") });
    },
  });
}

export function useUnlinkGithubInstallation() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.delete<OrganizationGithubConfig>(`/api/console/github/installations/${encodeURIComponent(connectionId)}`),
    onSuccess: async (config) => {
      queryClient.setQueryData(orgKey("github", "org"), config);
      await queryClient.invalidateQueries({ queryKey: orgKey("projects") });
    },
  });
}
