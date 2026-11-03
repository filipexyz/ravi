"use client";

// Reads for the Bases inspector. Every call goes to the Console session
// envelope (`/api/console/projects/<p>/bases/...`) or the project's Pages
// list. Rows are read only through a view; the screen makes no writes. Query
// keys are scoped to the organization, the project and the base.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { PageSiteSummary } from "@/features/console/types";
import type {
  BaseActivityResponse,
  BaseChart,
  BaseChartPublic,
  BaseDetail,
  BaseQueryRequest,
  BaseQueryResponse,
  BaseRowHistoryResponse,
  BaseRowWriteResponse,
  BaseSort,
  BaseSubscription,
  BaseSummary,
  BaseView,
  BaseViewPublic,
} from "@/shared/bases/types";

export const ROWS_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 50;

function basesPath(projectId: string, ...parts: string[]) {
  const suffix = parts.map((part) => `/${encodeURIComponent(part)}`).join("");
  return `/api/console/projects/${encodeURIComponent(projectId)}/bases${suffix}`;
}

export function useBasesList(projectId: string, includeArchived: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () =>
      api.get<{ bases: BaseSummary[] }>(`${basesPath(projectId)}${includeArchived ? "?includeArchived=1" : ""}`),
    queryKey: orgKey("projects", projectId, "bases", "list", includeArchived ? "with-archived" : "active"),
    select: (data) => data.bases,
  });
}

export function baseDetailKey(orgKey: ReturnType<typeof useOrgKey>, projectId: string, baseRef: string) {
  return orgKey("projects", projectId, "bases", "base", baseRef, "detail");
}

export function baseDetailQuery(orgKey: ReturnType<typeof useOrgKey>, projectId: string, baseRef: string) {
  return {
    queryFn: () => api.get<BaseDetail>(basesPath(projectId, baseRef)),
    queryKey: baseDetailKey(orgKey, projectId, baseRef),
    staleTime: 30_000,
  };
}

export function useBaseDetail(projectId: string, baseRef: string) {
  const orgKey = useOrgKey();
  return useQuery(baseDetailQuery(orgKey, projectId, baseRef));
}

/** What the Rows tab reads a view with besides the view itself: a sort, a free-text search, and a member to view as. */
export type ViewRowsOptions = { sort: BaseSort | null; search: string; asUserId: string | null };

/** One page of rows through a view. The request sort replaces the view's saved sort; without one the view's sort applies. */
export function fetchViewRows(
  projectId: string,
  baseRef: string,
  viewId: string,
  options: ViewRowsOptions & { cursor: string | null; includeBody: boolean; limit: number },
) {
  const body: BaseQueryRequest = { includeBody: options.includeBody, limit: options.limit };
  if (options.sort) body.sort = [options.sort];
  if (options.search) body.search = options.search;
  if (options.asUserId) body.asUserId = options.asUserId;
  if (options.cursor) body.cursor = options.cursor;
  return api.post<BaseQueryResponse>(basesPath(projectId, baseRef, "views", viewId, "query"), body);
}

/** Rows through one view, a page at a time. */
export function useViewRows(projectId: string, baseRef: string, viewId: string | null, options: ViewRowsOptions) {
  const orgKey = useOrgKey();
  return useInfiniteQuery({
    enabled: Boolean(viewId),
    getNextPageParam: (page: BaseQueryResponse) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchViewRows(projectId, baseRef, viewId as string, { ...options, cursor: pageParam, includeBody: true, limit: ROWS_PAGE_SIZE }),
    queryKey: viewRowsKey(orgKey, projectId, baseRef, viewId, options),
  });
}

export function viewRowsKey(
  orgKey: ReturnType<typeof useOrgKey>,
  projectId: string,
  baseRef: string,
  viewId: string | null,
  options: ViewRowsOptions,
) {
  return orgKey(
    "projects",
    projectId,
    "bases",
    "base",
    baseRef,
    "view",
    viewId,
    "rows",
    options.sort ? `${options.sort.prop}:${options.sort.dir}` : "saved",
    options.search,
    options.asUserId ?? "me",
  );
}

/**
 * One row through the view, fresh from the server: as the caller, or as the
 * member a manager views as (`asUserId`). The row from the list shows until
 * it arrives.
 */
export function useViewRow(
  projectId: string,
  baseRef: string,
  viewId: string,
  rowId: string | null,
  asUserId: string | null,
  placeholder: BaseRowWriteResponse | undefined,
) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: Boolean(rowId),
    placeholderData: placeholder,
    queryFn: () => {
      const query = asUserId ? `?${new URLSearchParams({ asUserId }).toString()}` : "";
      return api.get<BaseRowWriteResponse>(`${basesPath(projectId, baseRef, "views", viewId, "rows", rowId as string)}${query}`);
    },
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "view", viewId, "row", rowId, asUserId ?? "me"),
  });
}

/** Ledger of one row through the view: only projected columns, actors only when the view shows them. */
export function useRowHistory(projectId: string, baseRef: string, viewId: string, rowId: string | null) {
  const orgKey = useOrgKey();
  return useInfiniteQuery({
    enabled: Boolean(rowId),
    getNextPageParam: (page: BaseRowHistoryResponse) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (pageParam) params.set("cursor", pageParam);
      return api.get<BaseRowHistoryResponse>(
        `${basesPath(projectId, baseRef, "views", viewId, "rows", rowId as string, "history")}?${params.toString()}`,
      );
    },
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "view", viewId, "history", rowId),
  });
}

/** Views and charts including archived ones, so old activity still has names. Managers only. */
export function useArchivedNames(projectId: string, baseRef: string, enabled: boolean) {
  const orgKey = useOrgKey();
  const views = useQuery({
    enabled,
    queryFn: () => api.get<{ views: Array<BaseView | BaseViewPublic> }>(`${basesPath(projectId, baseRef, "views")}?includeArchived=1`),
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "views", "with-archived"),
    select: (data) => data.views,
  });
  const charts = useQuery({
    enabled,
    queryFn: () =>
      api.get<{ charts: Array<BaseChart | BaseChartPublic> }>(`${basesPath(projectId, baseRef, "charts")}?includeArchived=1`),
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "charts", "with-archived"),
    select: (data) => data.charts,
  });
  return { charts, views };
}

export function useSubscriptions(projectId: string, baseRef: string, enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<{ subscriptions: BaseSubscription[] }>(basesPath(projectId, baseRef, "subscriptions")),
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "subscriptions"),
    select: (data) => data.subscriptions,
  });
}

/** The project's Pages sites, to turn a view's site id into the host people open. */
export function usePageSites(projectId: string, enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<PageSiteSummary[]>(`/api/console/projects/${encodeURIComponent(projectId)}/pages`),
    queryKey: orgKey("projects", projectId, "bases", "page-sites"),
    staleTime: 60_000,
  });
}

/** The base's `bases.*` audit events, newest first, 50 at a time. Managers only. */
export function useBaseActivity(projectId: string, baseRef: string) {
  const orgKey = useOrgKey();
  return useInfiniteQuery({
    getNextPageParam: (page: BaseActivityResponse) => page.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = pageParam ? `?${new URLSearchParams({ cursor: pageParam }).toString()}` : "";
      return api.get<BaseActivityResponse>(`${basesPath(projectId, baseRef, "activity")}${query}`);
    },
    queryKey: orgKey("projects", projectId, "bases", "base", baseRef, "activity"),
  });
}
