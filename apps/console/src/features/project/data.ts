"use client";

import { useQuery, type Query } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type {
  Event,
  PageSiteSummary,
  PageVisibility,
  ProjectGithubAppConfig,
  PublishedPageSummary,
  SettingsData,
} from "@/features/console/types";
import { useFeature, useOrgKey } from "@/features/shell/workspace";

/** One base as `GET /api/console/projects/:id/bases` lists it. */
export type ProjectBaseSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  rowCount: number;
  status: string;
  updatedAt: string;
};

/**
 * Query keys for this area. Each one ends in a part no other screen uses, so a
 * different response shape cached by another screen for the same endpoint can
 * never collide; invalidating `orgKey("projects", id)` still refreshes them.
 */
export function useProjectKeys(projectId: string) {
  const orgKey = useOrgKey();
  return {
    all: orgKey("projects", projectId),
    bases: orgKey("projects", projectId, "bases", "project-summary"),
    events: orgKey("projects", projectId, "events", "project-activity"),
    githubApp: orgKey("projects", projectId, "github-app", "project-integrations"),
    publishedPages: orgKey("projects", projectId, "published-pages", "project-summary"),
    settings: orgKey("projects", projectId, "settings", "project-general"),
    sites: orgKey("projects", projectId, "pages", "sites", "project-summary"),
  };
}

const path = (projectId: string) => `/api/console/projects/${encodeURIComponent(projectId)}`;

export function usePublishedPagesQuery(projectId: string, enabled = true) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled,
    queryFn: () => api.get<PublishedPageSummary[]>(`${path(projectId)}/published-pages`),
    queryKey: keys.publishedPages,
  });
}

export function useSitesQuery(projectId: string, enabled = true) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled,
    queryFn: () => api.get<PageSiteSummary[]>(`${path(projectId)}/pages`),
    queryKey: keys.sites,
  });
}

export function useBasesQuery(projectId: string, enabled = true) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled,
    queryFn: async () => (await api.get<{ bases: ProjectBaseSummary[] }>(`${path(projectId)}/bases`)).bases ?? [],
    queryKey: keys.bases,
  });
}

export function useEventsQuery(projectId: string, enabled = true) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled,
    queryFn: () => api.get<Event[]>(`/api/console/events?projectId=${encodeURIComponent(projectId)}`),
    queryKey: keys.events,
  });
}

export function useProjectSettingsQuery(projectId: string, enabled = true) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<SettingsData>(
        `/api/console/settings?${new URLSearchParams({ projectId, scope: "project" }).toString()}`,
      ),
    queryKey: keys.settings,
  });
}

export function useGithubAppQuery(
  projectId: string,
  options: {
    enabled?: boolean;
    refetchInterval?: number | false | ((query: Query<ProjectGithubAppConfig, Error>) => number | false);
  } = {},
) {
  const keys = useProjectKeys(projectId);
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () => api.get<ProjectGithubAppConfig>(`${path(projectId)}/github-app`),
    queryKey: keys.githubApp,
    refetchInterval: options.refetchInterval,
  });
}

/**
 * Names for the user ids audit events carry. Only owners and admins can read
 * the member list (it comes with project settings), so everyone else sees
 * "A member" for people other than themselves.
 */
export function useActorNames(projectId: string) {
  const canReadMembers = useFeature("console.settings");
  const settings = useProjectSettingsQuery(projectId, canReadMembers);
  const names = new Map<string, string>();
  for (const member of settings.data?.members ?? []) names.set(member.id, member.name || member.email);
  return { currentUserId: settings.data?.currentUserId ?? null, names };
}

/** The project's default host: the site marked default, or the first one. */
export function defaultSite(sites: PageSiteSummary[] | undefined) {
  if (!sites?.length) return undefined;
  return sites.find((site) => site.isDefault && site.status === "active") ?? sites.find((site) => site.status === "active") ?? sites[0];
}

export function pageUrl(hostname: string, routePath: string) {
  return `https://${hostname}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

/** Private pages need a Pages session first; the auth start route sets it and returns to the page. */
export function openPageHref(url: string) {
  return `/api/pages/auth/start?returnTo=${encodeURIComponent(url)}`;
}

export const VISIBILITY_LABEL: Record<PageVisibility, string> = {
  password: "Password",
  private: "Private",
  protected_link: "Protected",
  public: "Public",
};

/** Who opens a page marked Public on a host with this default. */
export const PUBLIC_PAGES_AUDIENCE: Record<PageVisibility, string> = {
  password: "people who have the password",
  private: "people in this organization who can open the project, after signing in",
  protected_link: "signed-in people who can open the project",
  public: "anyone with the link",
};
