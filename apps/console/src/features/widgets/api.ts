"use client";

// Reads and writes the theme and widget screens add to the Library's: theme
// pointers (`themes/active`), the widget catalog, scaffolds from a view, and
// items of another kind than the screen's (the effective theme on a widget
// screen, the org's widgets on a theme screen). Same envelope and query keys
// as `@/features/library/api`.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { baseDetailQuery, useBasesList } from "@/features/bases/api";
import { libraryPath } from "@/features/library/api";
import type { LibraryKind } from "@/features/library/kind";
import type {
  ActiveThemes,
  CatalogWidgetSummary,
  LibraryItem,
  LibraryItemVersion,
  ThemePointerResult,
  WidgetScaffold,
} from "@/features/library/types";
import { useOrgKey } from "@/features/shell/workspace";
import { api } from "@/lib/api/client";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";

import { previewTheme } from "./preview";

type OrgKey = ReturnType<typeof useOrgKey>;

/** `org/<slug>` or `<project>/<slug>`; a bare slug is an org item. */
export function splitItemRef(ref: string): [string, string] {
  const [first = "", second] = ref.split("/");
  return second === undefined ? ["org", first] : [first, second];
}

/** One item with its files; the key matches `useLibraryItem`, so screens share the cache. */
function itemQuery(orgKey: OrgKey, kind: LibraryKind, ref: string, version: number | null) {
  const [scope, slug] = splitItemRef(ref);
  return {
    queryFn: () =>
      api.get<{ item: LibraryItem; version: LibraryItemVersion }>(`${libraryPath(kind, scope, slug)}${version ? `?version=${version}` : ""}`),
    queryKey: orgKey("library", kind, "item", scope, slug, version),
  };
}

/** The org's theme pointer and, with a project, the project's and the one that applies there. */
export function useActiveThemes(projectId: string | null) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<ActiveThemes>(`${libraryPath("theme", "active")}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`),
    queryKey: orgKey("library", "theme", "active", projectId),
  });
}

export type SetActiveThemeInput = { scope: "org" | "project"; project?: string; ref: string | null; dryRun?: boolean };

/** `POST themes/active`: with `dryRun` only the plan (affected hosts); without, applies it. */
export function useSetActiveTheme() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetActiveThemeInput) => api.post<ThemePointerResult>(libraryPath("theme", "active"), body),
    onSuccess: (result) => {
      if (result.applied) void queryClient.invalidateQueries({ queryKey: orgKey("library", "theme", "active") });
    },
  });
}

/**
 * The compiled theme previews use: the effective pointer's current version
 * (`themes/active` → its files → compileTheme), else the default theme.
 * When `themes/active` or that version does not load, previews still get
 * the default theme, and `error` says so (with `retry`), so the screen does
 * not present the default as the theme in effect.
 */
export function useEffectiveTheme(projectId: string | null) {
  const orgKey = useOrgKey();
  const active = useActiveThemes(projectId);
  const effective = active.data?.effective ?? null;
  const item = useQuery({
    ...itemQuery(orgKey, "theme", effective?.ref ?? "", effective?.version ?? null),
    enabled: Boolean(effective),
  });
  const files = item.data?.version.files ?? null;
  const theme = useMemo(() => (files ? previewTheme(files).theme : defaultCompiledTheme()), [files]);
  // A failed background refetch over cached data is not a load failure.
  const failed = active.isError && !active.data ? active : effective && !files && item.isError ? item : null;
  return {
    theme,
    /** The theme in use, or null for the default one. */
    effective: files ? effective : null,
    isPending: active.isPending || (Boolean(effective) && item.isPending),
    /** The active theme or its version did not load; the preview uses the default theme meanwhile. */
    isError: Boolean(failed),
    error: failed?.error ?? null,
    /** A retry of the failed load is running. */
    isRetrying: Boolean(failed?.isFetching),
    retry: () => void failed?.refetch(),
  };
}

export type EffectiveThemeState = ReturnType<typeof useEffectiveTheme>;

/** The org's widgets (and the project's) from `widgets/catalog`. */
export function useWidgetCatalog(projectId: string | null) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () =>
      api.get<{ widgets: CatalogWidgetSummary[] }>(`${libraryPath("widget", "catalog")}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`),
    queryKey: orgKey("library", "widget", "catalog", projectId),
    select: (data) => data.widgets,
  });
}

/** Current versions of several widgets, by ref. */
export function useWidgetItems(refs: readonly string[]) {
  const orgKey = useOrgKey();
  return useQueries({ queries: refs.map((ref) => itemQuery(orgKey, "widget", ref, null)) });
}

/** `POST widgets/scaffold`: widget.html, widget.json and example.json from a view's columns (schema only). */
export function useWidgetScaffold() {
  return useMutation({
    mutationFn: (body: { slug: string; view?: string; project?: string }) => api.post<WidgetScaffold>(libraryPath("widget", "scaffold"), body),
  });
}

/** A project's bases, for the "start from a view" picker. */
export function useScaffoldBases(projectId: string) {
  return useBasesList(projectId, false);
}

/** One base's views; idle until a base is picked. */
export function useScaffoldViews(projectId: string, baseId: string | null) {
  const orgKey = useOrgKey();
  return useQuery({
    ...baseDetailQuery(orgKey, projectId, baseId ?? ""),
    enabled: Boolean(baseId),
    // Managers get full views (with a status); everyone else only the views open to them.
    select: (data) => data.views.filter((view) => !("status" in view) || view.status === "active"),
  });
}
