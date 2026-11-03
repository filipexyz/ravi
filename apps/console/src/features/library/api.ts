"use client";

// Reads and writes for the Library. Every call goes to the Console session
// envelope (`/api/console/library/...`); query keys are scoped to the
// organization.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api/client";
import { useOrgKey } from "@/features/shell/workspace";
import type { WidgetScriptAudit, WidgetScriptAuditStatus, WidgetScriptViolation } from "@/shared/widgets/types";

import { KIND_WORDS, type LibraryKind, useLibraryKind } from "./kind";
import type {
  DirectoryAgent,
  LibraryCan,
  LibraryComment,
  LibraryItem,
  LibraryInstallation,
  LibraryItemVersion,
  LibraryPin,
  LibraryProposal,
  LibraryProposalDetail,
  LibraryProposalInput,
  LibraryVersionSummary,
} from "./types";

const SEARCH_LIMIT = 50;

export function libraryPath(kind: LibraryKind, ...parts: string[]) {
  return `/api/console/library/${KIND_WORDS[kind].segment}${parts.map((part) => `/${encodeURIComponent(part)}`).join("")}`;
}

/** Search (or, with an empty query, the newest items) in the org, plus the project when given. */
export function useLibrarySearch(query: string, projectId: string | null) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const params = new URLSearchParams({ limit: String(SEARCH_LIMIT) });
  if (query.trim()) params.set("q", query.trim());
  if (projectId) params.set("project", projectId);
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.get<{ items: LibraryItem[]; can?: LibraryCan }>(`${libraryPath(kind)}?${params.toString()}`),
    queryKey: orgKey("library", kind, "search", projectId, query.trim()),
  });
}

/** Open proposals the viewer can see: the org's, plus the project's when given. */
export function useOpenLibraryProposals(projectId: string | null) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const params = new URLSearchParams({ state: "open" });
  if (projectId) params.set("project", projectId);
  return useQuery({
    queryFn: () => api.get<{ proposals: LibraryProposal[] }>(`${libraryPath(kind, "proposals")}?${params.toString()}`),
    queryKey: orgKey("library", kind, "proposals", "open", projectId),
    select: (data) => data.proposals,
  });
}

export function useItemProposals(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () =>
      api.get<{ item: LibraryItem; can: LibraryCan; proposals: LibraryProposal[] }>(libraryPath(kind, scope, slug, "proposals")),
    queryKey: orgKey("library", kind, "proposals", "item", scope, slug),
  });
}

export function useLibraryProposal(scope: string, slug: string, number: number) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<LibraryProposalDetail>(libraryPath(kind, scope, slug, "proposals", String(number))),
    queryKey: orgKey("library", kind, "proposal", scope, slug, number),
  });
}

export function useCreateLibraryProposal() {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LibraryProposalInput & { scope: "org" | "project"; project?: string; slug: string }) =>
      api.post<{ proposal: LibraryProposal }>(libraryPath(kind, "proposals"), body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export function useUpdateLibraryProposal(scope: string, slug: string, number: number) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LibraryProposalInput) =>
      api.post<{ proposal: LibraryProposal }>(libraryPath(kind, scope, slug, "proposals", String(number), "update"), body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export type ProposalAction = "submit" | "withdraw" | "publish" | "reject";

export function useLibraryProposalAction(scope: string, slug: string, number: number) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, reason }: { action: ProposalAction; reason?: string }) =>
      api.post<{ proposal: LibraryProposal | null; item?: LibraryItem; deleted?: boolean; itemDeleted?: boolean }>(
        libraryPath(kind, scope, slug, "proposals", String(number), action),
        reason ? { reason } : {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

/** Publishes a proposal named at call time: the editor saves a draft, then publishes it. */
export function usePublishLibraryProposal() {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, number }: { ref: string; number: number }) => {
      const [scope = "", slug = ""] = ref.split("/");
      return api.post<{ proposal: LibraryProposal; item: LibraryItem }>(
        libraryPath(kind, scope, slug, "proposals", String(number), "publish"),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

/**
 * Stores a widget version's accessibility audit (`POST widgets/<scope>/<slug>/versions/<n>/audit`,
 * org owner or admin). The ref and version are named at call time: the editor learns the version when it publishes.
 */
export function useRecordWidgetAudit() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ audit, ref, version }: { ref: string; version: number; audit: { status: WidgetScriptAuditStatus; violations: WidgetScriptViolation[]; scriptSha256: string } }) => {
      const [scope = "", slug = ""] = ref.split("/");
      return api.post<{ audit: WidgetScriptAudit }>(libraryPath("widget", scope, slug, "versions", String(version), "audit"), audit);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export function useLibraryComment(scope: string, slug: string, number: number) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { body: string; path?: string; line?: number; parentId?: string }) =>
      api.post<{ comment: LibraryComment; comments: LibraryComment[] }>(
        libraryPath(kind, scope, slug, "proposals", String(number), "comments"),
        body,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library", kind, "proposal", scope, slug, number) }),
  });
}

export function useResolveLibraryComment(scope: string, slug: string, number: number) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.post<{ comment: LibraryComment }>(
        libraryPath(kind, scope, slug, "proposals", String(number), "comments", id, resolved ? "resolve" : "reopen"),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export function useRevertLibraryItem(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      api.post<{ item: LibraryItem; version: { number: number } }>(libraryPath(kind, scope, slug, "versions", String(version), "revert")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export function useLibraryItem(scope: string, slug: string, version: number | null) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () =>
      api.get<{ item: LibraryItem; version: LibraryItemVersion }>(
        `${libraryPath(kind, scope, slug)}${version ? `?version=${version}` : ""}`,
      ),
    queryKey: orgKey("library", kind, "item", scope, slug, version),
  });
}

export function useLibraryVersions(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ versions: LibraryVersionSummary[] }>(libraryPath(kind, scope, slug, "versions")),
    queryKey: orgKey("library", kind, "versions", scope, slug),
    select: (data) => data.versions,
  });
}

export function useArchiveLibraryItem(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ item: LibraryItem }>(libraryPath(kind, scope, slug, "archive")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library") }),
  });
}

export function useLibraryPins(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ pins: LibraryPin[]; can: { pin: boolean } }>(libraryPath(kind, scope, slug, "pins")),
    queryKey: orgKey("library", kind, "pins", scope, slug),
  });
}

/** Installations with the agents they reported; only reviewers may ask. */
export function useLibraryInstallations(projectId: string | null, enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<{ installations: LibraryInstallation[] }>(
        `/api/console/library/installations${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
      ),
    queryKey: orgKey("library", "installations", projectId),
    select: (data) => data.installations,
  });
}

export function useLibraryPinAction(scope: string, slug: string) {
  const kind = useLibraryKind();
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: "pin" | "unpin"; installationId: string; agentId: string }) =>
      api.post<unknown>(libraryPath(kind, scope, slug, input.action), { agentId: input.agentId, installationId: input.installationId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("library", kind, "pins", scope, slug) }),
  });
}

/** Agents running on the org's linked installations that the viewer may see. */
export function useAgentDirectory(query: string, projectId: string | null) {
  const orgKey = useOrgKey();
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (projectId) params.set("project", projectId);
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get<{ agents: DirectoryAgent[]; can: { ask: boolean } }>(`/api/console/library/directory?${params.toString()}`),
    queryKey: orgKey("library", "directory", projectId, query.trim()),
  });
}

/** The server's own sentence for Library errors, which already says what to do. */
export function libraryErrorText(error: unknown) {
  if (error instanceof ApiError && error.message && error.message !== error.code) return error.message;
  return null;
}
