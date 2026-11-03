"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api/client";
import type {
  DomainBindingSummary,
  DomainClaimSummary,
  DomainClaimsData,
  PageSiteSummary,
  PublishedPageSummary,
} from "@/features/console/types";
import { useOrgKey } from "@/features/shell/workspace";
import type { AccessGrantSummary } from "@/server/console/access/grants";
import type { AccessRequestDetail } from "@/server/console/access/requests";
import type { PageHistory } from "@/server/console/pages/history";

/** One viewer assertion audience, as the site's audiences endpoint returns it. */
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

const projectPath = (projectId: string) => `/api/console/projects/${encodeURIComponent(projectId)}`;

/**
 * Query keys for the Pages screen. The last part is unique to this screen so a
 * differently shaped cache entry from another screen can never collide; the
 * `*Root` keys are the prefixes to invalidate after a change.
 */
export function usePagesKeys(projectId: string) {
  const orgKey = useOrgKey();
  return {
    access: (siteId: string) => orgKey("projects", projectId, "pages", siteId, "access-grants"),
    accessRequests: (siteId: string) => orgKey("projects", projectId, "pages", siteId, "access-requests"),
    audiences: (siteId: string) => orgKey("projects", projectId, "pages", siteId, "viewer-assertion-audiences"),
    domains: orgKey("domains", "pages-screen"),
    history: (siteId: string, routeId: string | null) =>
      orgKey("projects", projectId, "pages", siteId, "history", routeId ?? "host"),
    domainsRoot: orgKey("domains"),
    published: orgKey("projects", projectId, "published-pages", "pages-screen"),
    publishedRoot: orgKey("projects", projectId, "published-pages"),
    sites: orgKey("projects", projectId, "pages", "sites", "pages-screen"),
    sitesRoot: orgKey("projects", projectId, "pages"),
  };
}

export function useSites(projectId: string) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    queryFn: () => api.get<PageSiteSummary[]>(`${projectPath(projectId)}/pages`),
    queryKey: keys.sites,
  });
}

/** How often the list reads again while a preview is being made. */
const PREVIEW_POLL_MS = 6_000;

export function usePublishedPages(projectId: string) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    queryFn: () => api.get<PublishedPageSummary[]>(`${projectPath(projectId)}/published-pages`),
    queryKey: keys.published,
    // Captures finish a few seconds after they start; read again until none is running.
    refetchInterval: (query) =>
      query.state.data?.some((page) => page.thumbnail.attempt?.status === "pending") ? PREVIEW_POLL_MS : false,
  });
}

export type ThumbnailRequestResult = { items: Array<{ routeId: string; state: "ready" | "pending" | "failed" }> };

/**
 * Asks the Console to capture previews of pages that have none of their
 * current content. Needs project write permission; the server answers 403
 * otherwise, and the pages keep their placeholder.
 */
export function useRequestThumbnails(projectId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: (input: { routeIds: string[]; retry?: boolean }) =>
      api.post<ThumbnailRequestResult>(`${projectPath(projectId)}/pages/thumbnails`, input),
    onSuccess: (result) => {
      if (!result.items.some((item) => item.state === "pending")) return;
      // Captures start right after the response; read again once they show as pending.
      const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.publishedRoot });
      refresh();
      setTimeout(refresh, 2_500);
    },
  });
}

/** The host's history, or one page's when `routeId` is set. Loads only when `enabled`. */
export function usePageHistory(projectId: string, siteId: string, routeId: string | null, enabled: boolean) {
  const keys = usePagesKeys(projectId);
  const params = new URLSearchParams({ siteId });
  if (routeId) params.set("routeId", routeId);
  return useQuery({
    enabled,
    queryFn: () => api.get<PageHistory>(`${projectPath(projectId)}/pages/history?${params.toString()}`),
    queryKey: keys.history(siteId, routeId),
  });
}

export function useDomains(projectId: string, enabled: boolean) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    enabled,
    queryFn: () => api.get<DomainClaimsData>("/api/console/domains"),
    queryKey: keys.domains,
  });
}

export function useAudiences(projectId: string, siteId: string) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    queryFn: () =>
      api.get<{ items: ViewerAssertionAudience[] }>(
        `${projectPath(projectId)}/pages/${encodeURIComponent(siteId)}/viewer-assertion-audiences`,
      ),
    queryKey: keys.audiences(siteId),
  });
}

/** Refreshes everything the Pages screen shows for this project. */
export function useRefreshPages(projectId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.sitesRoot }),
      queryClient.invalidateQueries({ queryKey: keys.publishedRoot }),
      queryClient.invalidateQueries({ queryKey: keys.domainsRoot }),
    ]);
}

/** Creates the project's own host with the existing create-site endpoint. */
export function useTurnOnPages(projectId: string) {
  const refresh = useRefreshPages(projectId);
  return useMutation({
    mutationFn: (slug: string) => api.post<PageSiteSummary>(`${projectPath(projectId)}/pages`, { isDefault: true, slug }),
    onSuccess: () => refresh(),
  });
}

/** The four domain endpoints the add-domain flow chains in the browser. */
export const domainApi = {
  checkBinding: (bindingId: string) =>
    api.post<{ binding: DomainBindingSummary }>(`/api/console/domains/bindings/${encodeURIComponent(bindingId)}/check`, {}),
  createBinding: (claimId: string, hostname: string, siteId: string) =>
    api.post<{ binding: DomainBindingSummary }>(`/api/console/domains/claims/${encodeURIComponent(claimId)}/bindings`, {
      hostname,
      product: "pages",
      target: { siteId },
    }),
  createClaim: (domain: string) =>
    api.post<{ claim: DomainClaimSummary }>("/api/console/domains/claims", { domain, ownershipMode: "customer_managed" }),
  verifyClaim: (claimId: string) =>
    api.post<{ claim: DomainClaimSummary }>(`/api/console/domains/claims/${encodeURIComponent(claimId)}/verify`, {}),
};

export function useCheckBinding(projectId: string) {
  const refresh = useRefreshPages(projectId);
  return useMutation({
    mutationFn: (bindingId: string) => domainApi.checkBinding(bindingId),
    onSettled: () => refresh(),
  });
}

export function useAddAudience(projectId: string, siteId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: (input: { audience: string; origins: string[] }) =>
      api.post<ViewerAssertionAudience>(
        `${projectPath(projectId)}/pages/${encodeURIComponent(siteId)}/viewer-assertion-audiences`,
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.audiences(siteId) }),
  });
}

export function useRemoveAudience(projectId: string, siteId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: (audienceId: string) =>
      api.delete<{ id: string }>(
        `${projectPath(projectId)}/pages/${encodeURIComponent(siteId)}/viewer-assertion-audiences/${encodeURIComponent(audienceId)}`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.audiences(siteId) }),
  });
}

/** A 4xx (no right to share, host gone) won't change on its own; show it right away. */
function retryUnlessClientError(failureCount: number, error: unknown) {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * People given access to one host or its pages. The server answers 403 when
 * the viewer can't share this project's pages, which is how the screen knows
 * to hide the Share actions.
 */
export function useSiteAccess(projectId: string, siteId: string | null) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    enabled: Boolean(siteId),
    queryFn: () =>
      api.get<{ siteId: string; grants: AccessGrantSummary[] }>(
        `/api/console/pages/access?siteId=${encodeURIComponent(siteId ?? "")}`,
      ),
    queryKey: keys.access(siteId ?? ""),
    retry: retryUnlessClientError,
  });
}

export type ShareAccessInput = {
  email: string;
  expiresAt: string | null;
  routeId: string | null;
  siteId: string;
};

export function useShareAccess(projectId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: ({ routeId, ...input }: ShareAccessInput) =>
      api.post<{ created: boolean; userCreated: boolean; grant: AccessGrantSummary }>("/api/console/pages/access/share", {
        ...input,
        ...(routeId ? { routeId } : {}),
      }),
    onSuccess: (_result, input) => queryClient.invalidateQueries({ queryKey: keys.access(input.siteId) }),
  });
}

export function useUnshareAccess(projectId: string, siteId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: (grantId: string) => api.post<{ revoked: boolean }>("/api/console/pages/access/unshare", { grantId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.access(siteId) }),
  });
}

export function useSiteAccessRequests(projectId: string, siteId: string | null) {
  const keys = usePagesKeys(projectId);
  return useQuery({
    enabled: Boolean(siteId),
    queryFn: () =>
      api.get<{ requests: AccessRequestDetail[] }>(
        `/api/console/pages/access/requests?siteId=${encodeURIComponent(siteId ?? "")}`,
      ),
    queryKey: keys.accessRequests(siteId ?? ""),
    retry: retryUnlessClientError,
  });
}

export function useDecideAccessRequest(projectId: string) {
  const queryClient = useQueryClient();
  const keys = usePagesKeys(projectId);
  return useMutation({
    mutationFn: ({ siteId: _siteId, ...input }: { decision: "approve" | "deny"; id: string; scope: "route" | "site"; siteId: string }) =>
      api.post<{ request: { id: string; status: string } }>("/api/console/pages/access/requests/decide", input),
    onSettled: (_result, _error, input) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.access(input.siteId) }),
        queryClient.invalidateQueries({ queryKey: keys.accessRequests(input.siteId) }),
      ]),
  });
}
