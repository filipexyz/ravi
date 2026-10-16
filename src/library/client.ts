// Console Library client: transport only. The Console owns access, search
// ranking and versioning (spec `console/library`); this side reads and
// publishes with the `ravi login` credentials.
//
//   GET  /api/cli/library/skills?q=&project=&limit=
//   GET  /api/cli/library/skills/<slug>?project=
//   GET  /api/cli/library/skills/<scope>/<slug>?version=
//   POST /api/cli/library/skills
//   GET  /api/cli/library/skills/proposals?project=&state=&mine=1
//   POST /api/cli/library/skills/proposals
//   GET  /api/cli/library/skills/<scope>/<slug>/proposals
//   GET  /api/cli/library/skills/<scope>/<slug>/proposals/<n>
//   POST /api/cli/library/skills/<scope>/<slug>/proposals/<n>/update
//
// The same routes serve every kind under its own segment (`themes`,
// `widgets`, `agents`; see kinds.ts). Themes and widgets add:
//
//   GET  /api/cli/library/themes/default
//   POST /api/cli/library/themes/check
//   GET  /api/cli/library/themes/active?project=
//   POST /api/cli/library/themes/active
//   GET  /api/cli/library/widgets/catalog?project=
//   POST /api/cli/library/widgets/check
//   POST /api/cli/library/widgets/preview
//   POST /api/cli/library/widgets/scaffold

import { ConsoleApiClient, normalizeConsoleUrl, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, classifyConsoleNetworkError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { resolveConsoleScope, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import type { ConsoleScopeProject } from "../console-scope/types.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import { normalizeDiagnostics, type LibraryDiagnostic } from "./diagnostics.js";
import { libraryKindPath, type LibraryKind } from "./kinds.js";
import type { LibraryRef } from "./refs.js";
import type {
  LibraryContrastReport,
  LibraryEffectiveTheme,
  LibraryFileText,
  LibraryGeneratedFiles,
  LibraryItem,
  LibraryItemProposalsResponse,
  LibraryProposal,
  LibraryProposalComment,
  LibraryProposalContent,
  LibraryProposalCreateBody,
  LibraryProposalItem,
  LibraryProposalListResponse,
  LibraryProposalShowResponse,
  LibraryProposalStatus,
  LibraryPublishBody,
  LibraryPublishResponse,
  LibrarySearchItem,
  LibrarySearchResponse,
  LibraryShowResponse,
  LibraryThemeActive,
  LibraryThemeCheck,
  LibraryThemePointer,
  LibraryThemeUseBody,
  LibraryThemeUsePlan,
  LibraryThemeUseResult,
  LibraryVersion,
  LibraryVersionFile,
  LibraryWidgetCatalog,
  LibraryWidgetCheck,
  LibraryWidgetField,
  LibraryWidgetPreview,
  LibraryWidgetSummary,
} from "./types.js";

export const LIBRARY_SKILLS_PATH = "/api/cli/library/skills";
export const LIBRARY_SEARCH_DEFAULT_LIMIT = 10;
export const LIBRARY_SEARCH_MAX_LIMIT = 50;

/** Console failures that mean "could not reach it": the cache may answer instead. */
export const LIBRARY_OFFLINE_CODES: ReadonlySet<string> = new Set([
  "SERVER_UNAVAILABLE",
  "HOST_UNREACHABLE",
  "RATE_LIMITED",
]);

export function isLibraryOfflineError(error: unknown): error is CloudAuthError {
  return isCloudAuthError(error) && LIBRARY_OFFLINE_CODES.has(error.code);
}

export function isLibraryNotFoundError(error: unknown): error is CloudAuthError {
  return isCloudAuthError(error) && (error.code === "NOT_FOUND" || error.status === 404);
}

export class LibraryClient {
  private credentials: CloudCredentials;
  /** The kind every route of this client serves (`skills/...` by default). */
  readonly kind: LibraryKind;

  constructor(
    private readonly session: {
      client: ConsoleApiClient;
      credentials: CloudCredentials;
      write: typeof writeCloudCredentials;
      delete: typeof deleteCloudCredentials;
      kind?: LibraryKind;
    },
  ) {
    this.credentials = session.credentials;
    this.kind = session.kind ?? "skill";
  }

  get consoleUrl(): string {
    return this.credentials.consoleUrl;
  }

  async search(input: { query: string; project?: string | null; limit?: number }): Promise<LibrarySearchResponse> {
    const params = new URLSearchParams({ q: input.query });
    if (input.project) params.set("project", input.project);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const payload = await this.request<Partial<LibrarySearchResponse>>("GET", `?${params.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items.map((item) => requireItem(item, this.kind)) : [];
    return { items: items as LibrarySearchItem[], query: input.query, project: payload?.project ?? null };
  }

  /** `GET /skills/<scope>/<slug>`: the item a ref names. */
  async showRef(ref: LibraryRef, options: { version?: number } = {}): Promise<LibraryShowResponse> {
    const query = options.version !== undefined ? `?version=${encodeURIComponent(String(options.version))}` : "";
    const payload = await this.request<unknown>("GET", `${refPath(ref)}${query}`);
    return requireShow(payload, this.kind);
  }

  /** `GET /skills/<slug>?project=`: the item a bare slug names in the caller's view. */
  async showSlug(slug: string, options: { project?: string | null } = {}): Promise<LibraryShowResponse> {
    const query = options.project ? `?project=${encodeURIComponent(options.project)}` : "";
    const payload = await this.request<unknown>("GET", `/${encodeURIComponent(slug)}${query}`);
    return requireShow(payload, this.kind);
  }

  async publish(body: LibraryPublishBody): Promise<LibraryPublishResponse> {
    const payload = await this.request<Partial<LibraryPublishResponse>>("POST", "", body);
    const version = payload?.version;
    if (!version || typeof version.number !== "number") {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a publish result without a version.");
    }
    return {
      item: requireItem(payload?.item, this.kind),
      version,
      unchanged: payload?.unchanged === true,
      ...(Array.isArray(payload?.diagnostics) ? { diagnostics: normalizeDiagnostics(payload.diagnostics) } : {}),
    };
  }

  /** `GET /skills/proposals`: proposals the caller can see (open ones by default). */
  async listProposals(
    input: { project?: string | null; state?: "open" | "closed" | "all"; mine?: boolean } = {},
  ): Promise<LibraryProposalListResponse> {
    const params = new URLSearchParams();
    if (input.project) params.set("project", input.project);
    if (input.state) params.set("state", input.state);
    if (input.mine) params.set("mine", "1");
    const encoded = params.toString();
    const query = encoded ? `?${encoded}` : "";
    const payload = objectValue(await this.request<unknown>("GET", `/proposals${query}`));
    if (!payload || !Array.isArray(payload.proposals)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected proposal list.");
    }
    return {
      proposals: payload.proposals.map((proposal) => requireProposal(proposal, this.consoleUrl)),
      state: typeof payload.state === "string" ? payload.state : (input.state ?? "open"),
      project: typeof payload.project === "string" ? payload.project : null,
    };
  }

  /** `GET /skills/<scope>/<slug>/proposals`: the item's proposals, newest first. */
  async listItemProposals(ref: LibraryRef): Promise<LibraryItemProposalsResponse> {
    const payload = objectValue(await this.request<unknown>("GET", `${refPath(ref)}/proposals`));
    if (!payload || !Array.isArray(payload.proposals)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected proposal list.");
    }
    const can = objectValue(payload.can);
    return {
      item: requireProposalItem(payload.item, this.kind),
      can: { propose: can?.propose === true, review: can?.review === true },
      proposals: payload.proposals.map((proposal) => requireProposal(proposal, this.consoleUrl)),
    };
  }

  /** `GET /skills/<scope>/<slug>/proposals/<n>`: one proposal with its files, base files and comments. */
  async showProposal(ref: LibraryRef, number: number): Promise<LibraryProposalShowResponse> {
    const payload = objectValue(await this.request<unknown>("GET", `${refPath(ref)}/proposals/${number}`));
    if (!payload || !Array.isArray(payload.files)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected proposal.");
    }
    const base = objectValue(payload.base);
    return {
      item: requireProposalItem(payload.item, this.kind),
      proposal: requireProposal(payload.proposal, this.consoleUrl),
      files: payload.files.map(requireFile),
      base:
        base && typeof base.number === "number"
          ? { number: base.number, files: Array.isArray(base.files) ? base.files.map(requireFile) : [] }
          : null,
      comments: Array.isArray(payload.comments) ? payload.comments.map(requireComment) : [],
    };
  }

  /** `POST /skills/proposals`: a new draft (`submit` false) or proposal. */
  async createProposal(body: LibraryProposalCreateBody): Promise<LibraryProposal> {
    return (await this.createProposalWithDiagnostics(body)).proposal;
  }

  /** {@link createProposal}, with the compiler's warnings for themes and widgets. */
  async createProposalWithDiagnostics(
    body: LibraryProposalCreateBody,
  ): Promise<{ proposal: LibraryProposal; diagnostics: LibraryDiagnostic[] }> {
    const payload = objectValue(await this.request<unknown>("POST", "/proposals", body));
    return {
      proposal: requireProposal(payload?.proposal, this.consoleUrl),
      diagnostics: normalizeDiagnostics(payload?.diagnostics),
    };
  }

  /** `POST /skills/<scope>/<slug>/proposals/<n>/update`: replace a proposal's whole content (author only). */
  async updateProposal(ref: LibraryRef, number: number, body: LibraryProposalContent): Promise<LibraryProposal> {
    return (await this.updateProposalWithDiagnostics(ref, number, body)).proposal;
  }

  /** {@link updateProposal}, with the compiler's warnings for themes and widgets. */
  async updateProposalWithDiagnostics(
    ref: LibraryRef,
    number: number,
    body: LibraryProposalContent,
  ): Promise<{ proposal: LibraryProposal; diagnostics: LibraryDiagnostic[] }> {
    const payload = objectValue(
      await this.request<unknown>("POST", `${refPath(ref)}/proposals/${number}/update`, body),
    );
    return {
      proposal: requireProposal(payload?.proposal, this.consoleUrl),
      diagnostics: normalizeDiagnostics(payload?.diagnostics),
    };
  }

  // -------------------------------------------------------------------------
  // Themes (this client's kind must be `theme`)

  /** `GET themes/default`: the built-in default theme's files. */
  async themeDefault(): Promise<LibraryGeneratedFiles> {
    this.assertKind("theme");
    return requireGeneratedFiles(await this.request<unknown>("GET", "/default"));
  }

  /** `POST themes/check`: compile and measure contrast; writes nothing. */
  async checkTheme(files: readonly LibraryFileText[]): Promise<LibraryThemeCheck> {
    this.assertKind("theme");
    const payload = objectValue(await this.request<unknown>("POST", "/check", { files: fileTexts(files) }));
    if (!payload) throw unexpected("theme check");
    const diagnostics = normalizeDiagnostics(payload.diagnostics);
    return {
      ok: payload.ok === true,
      diagnostics,
      contrast: normalizeContrast(payload.contrast),
      css: typeof payload.css === "string" ? payload.css : null,
    };
  }

  /** `GET themes/active?project=`: the org and project pointers and the effective theme. */
  async themeActive(project: string | null): Promise<LibraryThemeActive> {
    this.assertKind("theme");
    const query = project ? `?project=${encodeURIComponent(project)}` : "";
    const payload = objectValue(await this.request<unknown>("GET", `/active${query}`));
    if (!payload) throw unexpected("active theme");
    const effective = normalizePointer(payload.effective);
    const effectiveRecord = objectValue(payload.effective);
    return {
      org: normalizePointer(payload.org),
      project: normalizePointer(payload.project),
      effective:
        effective && effectiveRecord
          ? ({
              ...effective,
              version: numberOr(effectiveRecord.version, 0),
              hash: stringOr(effectiveRecord.hash, ""),
              source: effectiveRecord.source === "project" ? "project" : "org",
            } satisfies LibraryEffectiveTheme)
          : null,
      warnings: stringArray(payload.warnings),
    };
  }

  /** `POST themes/active`: plan (`dryRun`) or set an org or project pointer. */
  async setThemeActive(body: LibraryThemeUseBody): Promise<LibraryThemeUseResult> {
    this.assertKind("theme");
    const payload = objectValue(await this.request<unknown>("POST", "/active", body));
    const plan = objectValue(payload?.plan);
    if (!payload || !plan) throw unexpected("theme pointer plan");
    return {
      plan: {
        scope: plan.scope === "project" ? "project" : "org",
        project: normalizePlanProject(plan.project),
        from: normalizePointer(plan.from),
        to: normalizePointer(plan.to),
        affectedHosts: Array.isArray(plan.affectedHosts)
          ? plan.affectedHosts.flatMap((entry) => {
              const host = objectValue(entry);
              if (!host || typeof host.hostname !== "string") return [];
              return [
                { siteSlug: stringOr(host.siteSlug, ""), hostname: host.hostname, routes: numberOr(host.routes, 0) },
              ];
            })
          : [],
      },
      applied: payload.applied === true,
      // The Console answers `applied: true, unchanged: true` when the pointer already names the target.
      unchanged: payload.unchanged === true,
    };
  }

  // -------------------------------------------------------------------------
  // Widgets (this client's kind must be `widget`)

  /** `GET widgets/catalog?project=`: the Markdown for agents and the org's widgets. */
  async widgetCatalog(project: string | null): Promise<LibraryWidgetCatalog> {
    this.assertKind("widget");
    const query = project ? `?project=${encodeURIComponent(project)}` : "";
    const payload = objectValue(await this.request<unknown>("GET", `/catalog${query}`));
    if (!payload || typeof payload.text !== "string") throw unexpected("widget catalog");
    return {
      text: payload.text,
      widgets: Array.isArray(payload.widgets)
        ? payload.widgets.flatMap((entry) => {
            const widget = objectValue(entry);
            if (!widget || typeof widget.ref !== "string") return [];
            return [
              {
                ref: widget.ref,
                name: stringOr(widget.name, widget.ref),
                description: stringOr(widget.description, ""),
                fields: normalizeWidgetFields(widget.fields),
                variants: stringArray(widget.variants),
              },
            ];
          })
        : [],
    };
  }

  /** `POST widgets/check`: compile; writes nothing. */
  async checkWidget(files: readonly LibraryFileText[]): Promise<LibraryWidgetCheck> {
    this.assertKind("widget");
    const payload = objectValue(await this.request<unknown>("POST", "/check", { files: fileTexts(files) }));
    if (!payload) throw unexpected("widget check");
    return {
      ok: payload.ok === true,
      diagnostics: normalizeDiagnostics(payload.diagnostics),
      widget: normalizeWidgetSummary(payload.compiled),
    };
  }

  /** `POST widgets/preview`: a standalone HTML document with every variant. */
  async previewWidget(body: {
    files: readonly LibraryFileText[];
    theme?: string | null;
    data?: unknown;
    project?: string;
  }): Promise<LibraryWidgetPreview> {
    this.assertKind("widget");
    const payload = objectValue(
      await this.request<unknown>("POST", "/preview", { ...body, files: fileTexts(body.files) }),
    );
    if (!payload) throw unexpected("widget preview");
    return {
      html: typeof payload.html === "string" ? payload.html : "",
      diagnostics: normalizeDiagnostics(payload.diagnostics),
    };
  }

  /** `POST widgets/scaffold`: `widget.html`, `widget.json` and `example.json` to start from. */
  async scaffoldWidget(body: { slug: string; view?: string; project?: string }): Promise<LibraryGeneratedFiles> {
    this.assertKind("widget");
    return requireGeneratedFiles(await this.request<unknown>("POST", "/scaffold", body));
  }

  private assertKind(kind: LibraryKind): void {
    if (this.kind !== kind) throw new Error(`This Library client serves ${this.kind} routes, not ${kind} routes.`);
  }

  private async request<T>(method: string, relativePath: string, body?: unknown): Promise<T> {
    const path = `${libraryKindPath(this.kind)}${relativePath}`;
    try {
      try {
        return await this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken);
      } catch (error) {
        if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
      }
      this.credentials = await refreshCredentialsForStore({
        client: this.session.client,
        credentials: this.credentials,
        write: this.session.write,
        delete: this.session.delete,
      });
      return await this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw classifyConsoleNetworkError(error, inspectExecutionPlane());
    }
  }
}

export interface LibrarySessionOptions {
  console?: string;
  /** The kind the client's routes serve (default `skill`). */
  kind?: LibraryKind;
  /** Explicit project ref; otherwise the Console scope resolver decides. */
  project?: string | null;
  /** Skip project resolution (publish names its own scope). */
  resolveProject?: boolean;
}

export interface LibrarySessionDeps extends ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface LibrarySession {
  client: LibraryClient;
  consoleUrl: string;
  /** Organization of the `ravi login` session; names the cache directory. */
  orgId: string;
  /** The caller's Console project, or null (org items only). */
  project: ConsoleScopeProject | null;
}

/**
 * A Library client bound to the `ravi login` session, or null when there is
 * no session (Library parts are then skipped). No project resolved is not an
 * error: the view is org items only.
 */
export async function openLibrarySession(
  options: LibrarySessionOptions = {},
  deps: LibrarySessionDeps = {},
): Promise<LibrarySession | null> {
  const readCredentials = deps.readCredentials ?? readCloudCredentials;
  const credentials = readCredentials();
  if (!credentials) return null;
  if (options.console && normalizeConsoleUrl(options.console) !== credentials.consoleUrl) return null;
  let project: ConsoleScopeProject | null = null;
  if (options.resolveProject !== false) {
    try {
      const scope = await resolveConsoleScope(
        { consoleUrl: options.console, explicitProject: options.project ?? null },
        { ...deps, readCredentials },
      );
      project = scope.project?.ref ? scope.project : null;
    } catch {
      project = options.project ? { ref: options.project } : null;
    }
  }
  return {
    client: new LibraryClient({
      client: deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl }),
      credentials,
      write: deps.writeCredentials ?? writeCloudCredentials,
      delete: deps.deleteCredentials ?? deleteCloudCredentials,
      ...(options.kind ? { kind: options.kind } : {}),
    }),
    consoleUrl: credentials.consoleUrl,
    orgId: credentials.organization?.id?.trim() || credentials.organization?.slug?.trim() || "default",
    project,
  };
}

export function libraryLoginRequiredError(): CloudAuthError {
  return new CloudAuthError("AUTH_REQUIRED", "The Library needs a Ravi Cloud login. Run `ravi login`.");
}

function refPath(ref: LibraryRef): string {
  const scope = ref.scope === "org" ? "org" : (ref.project ?? "");
  return `/${encodeURIComponent(scope)}/${encodeURIComponent(ref.slug)}`;
}

function requireShow(payload: unknown, kind: LibraryKind): LibraryShowResponse {
  const record = objectValue(payload);
  const version = objectValue(record?.version);
  if (!record || !version || typeof version.number !== "number" || !Array.isArray(version.files)) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", `The Console returned an unexpected Library ${kind}.`);
  }
  const files = version.files.map(requireFile);
  const normalized: LibraryVersion = {
    number: version.number,
    note: typeof version.note === "string" ? version.note : null,
    contentHash: typeof version.contentHash === "string" ? version.contentHash : "",
    publishedAt: typeof version.publishedAt === "string" ? version.publishedAt : null,
    files,
  };
  return { item: requireItem(record.item, kind), version: normalized };
}

function requireFile(value: unknown): LibraryVersionFile {
  const entry = objectValue(value);
  if (!entry || typeof entry.path !== "string" || typeof entry.content !== "string") {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a Library file without a path or content.");
  }
  return {
    path: entry.path,
    content: entry.content,
    bytes: typeof entry.bytes === "number" ? entry.bytes : Buffer.byteLength(entry.content, "utf8"),
    sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
  };
}

function requireItem(value: unknown, kind: LibraryKind): LibraryItem {
  const item = requireItemFields(value, kind);
  if (item.version === null) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a Library item without a published version.");
  }
  return { ...item, version: item.version, contentHash: item.contentHash ?? "" };
}

/** An item from the proposal routes, which may have no published version yet. */
function requireProposalItem(value: unknown, kind: LibraryKind): LibraryProposalItem {
  return requireItemFields(value, kind);
}

function requireItemFields(value: unknown, fallbackKind: LibraryKind): LibraryProposalItem {
  const item = objectValue(value);
  if (
    !item ||
    typeof item.slug !== "string" ||
    (item.scope !== "org" && item.scope !== "project") ||
    (typeof item.version !== "number" && item.version !== null)
  ) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a Library item without a slug or scope.");
  }
  const project = objectValue(item.project);
  if (item.scope === "project" && (!project || typeof project.slug !== "string")) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a project item without its project.");
  }
  const slug = item.slug.toLowerCase();
  const publishedBy = objectValue(item.publishedBy);
  // Only the contract's fields: the result is cached and returned as JSON.
  return {
    ref: typeof item.ref === "string" ? item.ref : "",
    kind: typeof item.kind === "string" ? item.kind : fallbackKind,
    scope: item.scope,
    slug,
    name: typeof item.name === "string" && item.name ? item.name : slug,
    description: typeof item.description === "string" ? item.description : "",
    externalAllowed: item.externalAllowed === true,
    version: typeof item.version === "number" ? item.version : null,
    contentHash: typeof item.contentHash === "string" ? item.contentHash : null,
    publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : null,
    publishedBy: publishedBy ? { name: typeof publishedBy.name === "string" ? publishedBy.name : null } : null,
    archived: item.archived === true,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
    project: project
      ? {
          id: typeof project.id === "string" ? project.id : "",
          slug: String(project.slug).toLowerCase(),
          name: typeof project.name === "string" ? project.name : null,
        }
      : null,
  };
}

const PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "proposed",
  "published",
  "superseded",
  "rejected",
  "withdrawn",
]);

/** The proposal's Console page; only a same-origin path is accepted. */
function reviewUrl(consoleUrl: string, path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const url = new URL(path, consoleUrl);
    return url.origin === new URL(consoleUrl).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function requireProposal(value: unknown, consoleUrl: string): LibraryProposal {
  const proposal = objectValue(value);
  if (
    !proposal ||
    typeof proposal.ref !== "string" ||
    typeof proposal.number !== "number" ||
    typeof proposal.status !== "string" ||
    !PROPOSAL_STATUSES.has(proposal.status)
  ) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a proposal without a ref, number or status.");
  }
  const can = objectValue(proposal.can);
  const decidedBy = objectValue(proposal.decidedBy);
  // Only the contract's fields: the result is returned as JSON.
  return {
    ref: proposal.ref.toLowerCase(),
    number: proposal.number,
    status: proposal.status as LibraryProposalStatus,
    round: numberOr(proposal.round, 1),
    baseVersion: numberOr(proposal.baseVersion, 0),
    currentVersion: numberOr(proposal.currentVersion, 0),
    stale: proposal.stale === true,
    publishedVersion: typeof proposal.publishedVersion === "number" ? proposal.publishedVersion : null,
    name: stringOr(proposal.name, ""),
    description: stringOr(proposal.description, ""),
    externalAllowed: proposal.externalAllowed === true,
    note: stringOrNull(proposal.note),
    contentHash: stringOr(proposal.contentHash, ""),
    fileCount: numberOr(proposal.fileCount, 0),
    totalBytes: numberOr(proposal.totalBytes, 0),
    author: requireAuthor(proposal.author),
    createdAt: stringOrNull(proposal.createdAt),
    updatedAt: stringOrNull(proposal.updatedAt),
    proposedAt: stringOrNull(proposal.proposedAt),
    decidedAt: stringOrNull(proposal.decidedAt),
    decidedBy: decidedBy ? { name: stringOrNull(decidedBy.name) } : null,
    decisionReason: stringOrNull(proposal.decisionReason),
    openComments: numberOr(proposal.openComments, 0),
    reviewUrl: reviewUrl(consoleUrl, proposal.reviewPath),
    can: {
      edit: can?.edit === true,
      submit: can?.submit === true,
      withdraw: can?.withdraw === true,
      publish: can?.publish === true,
      reject: can?.reject === true,
    },
  };
}

function requireComment(value: unknown): LibraryProposalComment {
  const comment = objectValue(value);
  if (!comment || typeof comment.id !== "string" || typeof comment.body !== "string") {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a comment without an id or body.");
  }
  const resolvedBy = objectValue(comment.resolvedBy);
  const can = objectValue(comment.can);
  return {
    id: comment.id,
    parentId: stringOrNull(comment.parentId),
    path: stringOrNull(comment.path),
    line: typeof comment.line === "number" ? comment.line : null,
    round: numberOr(comment.round, 1),
    outdated: comment.outdated === true,
    body: comment.body,
    author: requireAuthor(comment.author),
    createdAt: stringOrNull(comment.createdAt),
    resolvedAt: stringOrNull(comment.resolvedAt),
    resolvedBy: resolvedBy ? { name: stringOrNull(resolvedBy.name) } : null,
    can: { resolve: can?.resolve === true },
  };
}

function requireAuthor(value: unknown): { name: string | null; agentId: string | null; self: boolean } {
  const author = objectValue(value);
  return {
    name: stringOrNull(author?.name),
    agentId: stringOrNull(author?.agentId),
    self: author?.self === true,
  };
}

function requireGeneratedFiles(payload: unknown): LibraryGeneratedFiles {
  const record = objectValue(payload);
  if (!record || !Array.isArray(record.files)) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned no files.");
  }
  return {
    files: record.files.map((entry) => {
      const file = objectValue(entry);
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
        throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a file without a path or content.");
      }
      return { path: file.path, content: file.content };
    }),
    diagnostics: normalizeDiagnostics(record.diagnostics),
  };
}

/** Only `path` and `content` travel: a package file also carries its size and hash. */
function fileTexts(files: readonly LibraryFileText[]): LibraryFileText[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

function normalizeContrast(value: unknown): LibraryContrastReport | null {
  const report = objectValue(value);
  if (!report) return null;
  const checks = Array.isArray(report.checks)
    ? report.checks.flatMap((entry) => {
        const check = objectValue(entry);
        if (!check || !Array.isArray(check.pair) || check.pair.length !== 2) return [];
        const [fg, bg] = check.pair;
        if (typeof fg !== "string" || typeof bg !== "string") return [];
        return [
          {
            mode: check.mode === "dark" ? ("dark" as const) : ("light" as const),
            pair: [fg, bg] as [string, string],
            ratio: numberOr(check.ratio, 0),
            min: numberOr(check.min, 0),
            ok: check.ok === true,
          },
        ];
      })
    : [];
  return { ok: report.ok === true, checks };
}

function normalizePointer(value: unknown): LibraryThemePointer | null {
  const pointer = objectValue(value);
  if (!pointer || typeof pointer.ref !== "string") return null;
  const setBy = objectValue(pointer.setBy);
  return {
    ref: pointer.ref,
    itemId: stringOr(pointer.itemId, ""),
    scope: pointer.scope === "project" ? "project" : "org",
    slug: stringOr(pointer.slug, pointer.ref.split("/").pop() ?? pointer.ref),
    name: stringOr(pointer.name, pointer.ref),
    setAt: stringOrNull(pointer.setAt),
    setBy: typeof pointer.setBy === "string" ? pointer.setBy : stringOrNull(setBy?.name),
  };
}

/** `plan.project` of `POST themes/active`: the Console's `{ id, slug, name }` (a bare slug is accepted too). */
function normalizePlanProject(value: unknown): LibraryThemeUsePlan["project"] {
  if (typeof value === "string") return value ? { id: "", slug: value, name: null } : null;
  const project = objectValue(value);
  if (!project || typeof project.slug !== "string") return null;
  return { id: stringOr(project.id, ""), slug: project.slug, name: stringOrNull(project.name) };
}

function normalizeWidgetFields(value: unknown): Record<string, LibraryWidgetField> {
  const fields = objectValue(value);
  if (!fields) return {};
  const normalized: Record<string, LibraryWidgetField> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const field = objectValue(entry);
    if (!field || typeof field.type !== "string") continue;
    normalized[key] = {
      type: field.type,
      role: stringOrNull(field.role),
      required: field.required === true,
      label: stringOrNull(field.label),
      description: stringOrNull(field.description),
    };
  }
  return normalized;
}

function normalizeWidgetSummary(value: unknown): LibraryWidgetSummary | null {
  const compiled = objectValue(value);
  if (!compiled) return null;
  const variants = objectValue(compiled.variants);
  return {
    name: stringOr(compiled.name, ""),
    description: stringOr(compiled.description, ""),
    fields: normalizeWidgetFields(compiled.fields),
    variants: variants ? Object.keys(variants) : stringArray(compiled.variants),
    actions: Array.isArray(compiled.actions) ? compiled.actions.length : 0,
    hash: stringOrNull(compiled.hash),
  };
}

function unexpected(what: string): CloudAuthError {
  return new CloudAuthError("SERVER_UNAVAILABLE", `The Console returned an unexpected ${what}.`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
