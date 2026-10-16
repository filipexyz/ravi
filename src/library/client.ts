// Console Library client: transport only. The Console owns access, search
// ranking and versioning (spec `console/library`); this side reads and
// publishes with the `ravi login` credentials.
//
//   GET  /api/cli/library/skills?q=&project=&limit=
//   GET  /api/cli/library/skills/<slug>?project=
//   GET  /api/cli/library/skills/<scope>/<slug>?version=
//   POST /api/cli/library/skills

import { ConsoleApiClient, normalizeConsoleUrl, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, classifyConsoleNetworkError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { resolveConsoleScope, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import type { ConsoleScopeProject } from "../console-scope/types.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import type { LibraryRef } from "./refs.js";
import type {
  LibraryItem,
  LibraryPublishBody,
  LibraryPublishResponse,
  LibrarySearchItem,
  LibrarySearchResponse,
  LibraryShowResponse,
  LibraryVersion,
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

  constructor(
    private readonly session: {
      client: ConsoleApiClient;
      credentials: CloudCredentials;
      write: typeof writeCloudCredentials;
      delete: typeof deleteCloudCredentials;
    },
  ) {
    this.credentials = session.credentials;
  }

  get consoleUrl(): string {
    return this.credentials.consoleUrl;
  }

  async search(input: { query: string; project?: string | null; limit?: number }): Promise<LibrarySearchResponse> {
    const params = new URLSearchParams({ q: input.query });
    if (input.project) params.set("project", input.project);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const payload = await this.request<Partial<LibrarySearchResponse>>("GET", `?${params.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items.map((item) => requireItem(item)) : [];
    return { items: items as LibrarySearchItem[], query: input.query, project: payload?.project ?? null };
  }

  /** `GET /skills/<scope>/<slug>`: the item a ref names. */
  async showRef(ref: LibraryRef, options: { version?: number } = {}): Promise<LibraryShowResponse> {
    const scope = ref.scope === "org" ? "org" : (ref.project ?? "");
    const query = options.version !== undefined ? `?version=${encodeURIComponent(String(options.version))}` : "";
    const payload = await this.request<unknown>(
      "GET",
      `/${encodeURIComponent(scope)}/${encodeURIComponent(ref.slug)}${query}`,
    );
    return requireShow(payload);
  }

  /** `GET /skills/<slug>?project=`: the item a bare slug names in the caller's view. */
  async showSlug(slug: string, options: { project?: string | null } = {}): Promise<LibraryShowResponse> {
    const query = options.project ? `?project=${encodeURIComponent(options.project)}` : "";
    const payload = await this.request<unknown>("GET", `/${encodeURIComponent(slug)}${query}`);
    return requireShow(payload);
  }

  async publish(body: LibraryPublishBody): Promise<LibraryPublishResponse> {
    const payload = await this.request<Partial<LibraryPublishResponse>>("POST", "", body);
    const version = payload?.version;
    if (!version || typeof version.number !== "number") {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a publish result without a version.");
    }
    return { item: requireItem(payload?.item), version, unchanged: payload?.unchanged === true };
  }

  private async request<T>(method: string, relativePath: string, body?: unknown): Promise<T> {
    const path = `${LIBRARY_SKILLS_PATH}${relativePath}`;
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
    }),
    consoleUrl: credentials.consoleUrl,
    orgId: credentials.organization?.id?.trim() || credentials.organization?.slug?.trim() || "default",
    project,
  };
}

export function libraryLoginRequiredError(): CloudAuthError {
  return new CloudAuthError("AUTH_REQUIRED", "The Library needs a Ravi Cloud login. Run `ravi login`.");
}

function requireShow(payload: unknown): LibraryShowResponse {
  const record = objectValue(payload);
  const version = objectValue(record?.version);
  if (!record || !version || typeof version.number !== "number" || !Array.isArray(version.files)) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected Library skill.");
  }
  const files = version.files.map((file) => {
    const entry = objectValue(file);
    if (!entry || typeof entry.path !== "string" || typeof entry.content !== "string") {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a Library file without a path or content.");
    }
    return {
      path: entry.path,
      content: entry.content,
      bytes: typeof entry.bytes === "number" ? entry.bytes : Buffer.byteLength(entry.content, "utf8"),
      sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
    };
  });
  const normalized: LibraryVersion = {
    number: version.number,
    note: typeof version.note === "string" ? version.note : null,
    contentHash: typeof version.contentHash === "string" ? version.contentHash : "",
    publishedAt: typeof version.publishedAt === "string" ? version.publishedAt : null,
    files,
  };
  return { item: requireItem(record.item), version: normalized };
}

function requireItem(value: unknown): LibraryItem {
  const item = objectValue(value);
  if (
    !item ||
    typeof item.slug !== "string" ||
    (item.scope !== "org" && item.scope !== "project") ||
    typeof item.version !== "number"
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
    kind: typeof item.kind === "string" ? item.kind : "skill",
    scope: item.scope,
    slug,
    name: typeof item.name === "string" && item.name ? item.name : slug,
    description: typeof item.description === "string" ? item.description : "",
    externalAllowed: item.externalAllowed === true,
    version: item.version,
    contentHash: typeof item.contentHash === "string" ? item.contentHash : "",
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
