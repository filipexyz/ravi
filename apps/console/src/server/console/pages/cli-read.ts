import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { canAccessProject, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import { memberActorForOrganization } from "../access/common";
import { canUserViewPagesRoute } from "../access/grants";
import type { PageVisibility } from "../pages";
import { createPageObjectStorageFromEnv, type PageObjectStorage } from "./publish";
import { isFinalObjectKeyForArtifact } from "./storage-keys";
import { extractPageText, isPageReadTextPath, type PageReadLink } from "./read-extract";
import {
  effectiveVisibility,
  pagesRouteResolveRepositoryForDb,
  resolvePagesRoute,
  type PagesResolveSite,
  type PagesRouteResolveOkResponse,
  type PagesRouteResolveRepository,
  type PagesRouteResolveResponse,
} from "./resolve";

/**
 * `POST /api/cli/pages/read`: one published Page as text, for the agent that
 * holds a CLI session. The URL is resolved exactly as the Pages Worker would
 * resolve it, and the CLI user is checked with the viewer rule (same org,
 * active membership, project read). The bytes come from the Pages object
 * store, never from the edge, and nothing is executed.
 */

export const PAGE_READ_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const PAGE_READ_DEFAULT_MAX_CHARS = 256_000;
export const PAGE_READ_MAX_FILES = 1_000;
export const PAGE_READ_MAX_FILES_BYTES = 100 * 1024 * 1024;
export const PAGE_READ_FILE_URL_TTL_SECONDS = 300;
const PAGE_READ_MAX_CHARS = 256_000;
const PAGE_READ_MIN_CHARS = 1_000;
const MAX_ROUTES = 200;

const REPRESENTATION_NOTES = {
  markdown:
    "Markdown extracted from the page's HTML: text, headings, lists, tables and links only. Styles, layout, scripts and images are not included, so it does not show how the page looks. For the design, read format html (the entry file's source) or files (every published file).",
  html: "Source of the route's entry file as published. Stylesheets, scripts and images it links to are separate files: read format files to get them all.",
  files:
    "Every file published for this route (HTML, CSS, JS, images), with short-lived download URLs. The text lists their paths.",
} as const;

// resolvePagesRoute only consults the private verifier when a session is
// present; the CLI read passes this marker instead of a viewer cookie.
const CLI_READ_SESSION_MARKER = "cli-read";

export const pageReadInputSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  publicOnly: z.boolean().optional().default(false),
  format: z.enum(["markdown", "html", "files"]).optional().default("markdown"),
  cursor: z.number().int().min(0).optional().default(0),
  maxChars: z.number().int().min(PAGE_READ_MIN_CHARS).max(PAGE_READ_MAX_CHARS).optional(),
});

export type PageReadInput = z.input<typeof pageReadInputSchema>;

export type PageReadFormat = "markdown" | "html" | "files";

export type PageReadFile = {
  path: string;
  contentType: string;
  sizeBytes: number | null;
  sha256: string | null;
  entrypoint: boolean;
  url: string;
};

export type PageReadStoredFile = {
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageJson: Record<string, unknown>;
};

export type PageReadDenyReason = "public_only" | "org_forbidden" | "project_forbidden" | "password_route";

export type PageReadResult = {
  page: {
    url: string;
    host: string;
    path: string;
    title: string;
    description: string | null;
    visibility: PageVisibility;
    siteId: string;
    projectId: string;
    route: { id: string; path: string; matchType: string };
    release: { id: string; number: number };
    artifact: { id: string; versionId: string; versionNumber: number };
    file: { path: string; contentType: string; sizeBytes: number | null; sha256: string | null };
  };
  content: {
    format: PageReadFormat;
    /** What the text is: an extraction, the original source, or a file list. */
    representation: "extracted_markdown" | "entry_source" | "file_list";
    note: string;
    text: string;
    cursor: number;
    nextCursor: number | null;
    totalChars: number;
    truncated: boolean;
  };
  /** Only for format files: the route's published files, each with a short-lived GET URL. */
  files?: PageReadFile[];
  filesExpireAt?: string;
  links: PageReadLink[];
  routes: Array<{ path: string; matchType: string; url: string; visibility: PageVisibility }>;
  signals: {
    scripts: number;
    raviElements: string[];
    staticTextChars: number;
    renderSuggested: boolean;
  };
  contentTrust: "untrusted";
};

export type PageReadAudit = {
  action: "pages.cli_read.allowed" | "pages.cli_read.denied";
  actorId: string;
  organizationId: string;
  projectId: string;
  requestId: string;
  siteId: string;
  metadataJson: Record<string, unknown>;
};

export type PageReadDeps = {
  repository?: PagesRouteResolveRepository;
  storage?: PageObjectStorage;
  canReadProject?: (workspace: ProjectAccessWorkspace, projectId: string, action: "read") => Promise<boolean>;
  audit?: (input: PageReadAudit) => Promise<void>;
  listFiles?: (input: { artifactId: string; artifactVersionId: string }) => Promise<PageReadStoredFile[]>;
  /** The CLI user's role in another organization they also belong to, or null. */
  memberRoleIn?: (input: { organizationId: string; userId: string }) => Promise<string | null>;
  /** Whether the CLI user was given this route (alone or through its site). */
  canViewGrant?: (input: { routeId: string; siteId: string; userId: string }) => Promise<boolean>;
  now?: () => Date;
};

export async function readPageForCli({
  deps = {},
  input,
  requestId,
  workspace,
}: {
  deps?: PageReadDeps;
  input: unknown;
  requestId: string;
  workspace: ProjectAccessWorkspace;
}): Promise<PageReadResult> {
  const parsed = pageReadInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([key, messages]) => [key, (messages ?? []).join(" ")]),
      ),
    });
  }
  const request = parsed.data;
  const target = parsePageUrl(request.url);
  if (!target) throw new ConsoleApiError(400, { error: "invalid_url" });

  const repository = deps.repository ?? pagesRouteResolveRepositoryForDb();
  const canReadProject = deps.canReadProject ?? canAccessProject;
  const audit = deps.audit ?? insertPageReadAudit;

  const memberRoleIn = deps.memberRoleIn ?? memberRoleInOrganization;
  const canViewGrant = deps.canViewGrant ?? canUserViewPagesRoute;

  const access: {
    denyReason: PageReadDenyReason | null;
    deniedSite: PagesResolveSite | null;
    /** Admitted by a grant on this route, not by membership. */
    guestSite: PagesResolveSite | null;
    memberSite: PagesResolveSite | null;
  } = { denyReason: request.publicOnly ? "public_only" : null, deniedSite: null, guestSite: null, memberSite: null };
  const resolveOnce = (host: string, path: string, search: string) =>
    resolvePagesRoute({
      input: {
        host,
        method: "GET",
        pagesSession: request.publicOnly ? null : CLI_READ_SESSION_MARKER,
        path,
        requestId,
        search,
      },
      guestAccessVerifier: async ({ routeId, site }) => {
        // A route share is not an escape hatch from member policy or a linked
        // installation ceiling. Explicit outside-org HUMAN shares are unchanged.
        if (workspace.authorization && site.organizationId !== workspace.organization.id) {
          access.denyReason = "org_forbidden"; access.deniedSite = site; return false;
        }
        if (site.organizationId === workspace.organization.id && !(await canReadProject(workspace, site.projectId, "read"))) {
          access.denyReason = "project_forbidden"; access.deniedSite = site; return false;
        }
        if (!(await canViewGrant({ routeId, siteId: site.id, userId: workspace.user.id }))) return false;
        access.guestSite = site;
        return true;
      },
      pageChatAvailability: async () => false,
      passwordAccessVerifier: async () => false,
      privateAccessVerifier: async ({ site }) => {
        // A Page of another organization the CLI user also belongs to is
        // checked with their own role there.
        let viewer: ProjectAccessWorkspace = workspace;
        if (site.organizationId !== workspace.organization.id) {
          if (workspace.authorization) {
            access.denyReason = "org_forbidden";
            access.deniedSite = site;
            return false;
          }
          const role = await memberRoleIn({ organizationId: site.organizationId, userId: workspace.user.id });
          if (!role) {
            access.denyReason = "org_forbidden";
            access.deniedSite = site;
            return false;
          }
          viewer = { membership: { role }, organization: { id: site.organizationId }, user: workspace.user };
        }
        if (!(await canReadProject(viewer, site.projectId, "read"))) {
          access.denyReason = "project_forbidden";
          access.deniedSite = site;
          return false;
        }
        access.memberSite = site;
        return true;
      },
      repository,
    });

  let host = target.host;
  let path = target.path;
  let resolved: PagesRouteResolveResponse = await resolveOnce(host, path, target.search);
  if (resolved.status === "redirect" && resolved.redirect) {
    const next = parsePageUrl(resolved.redirect.location);
    if (next) {
      host = next.host;
      path = next.path;
      resolved = await resolveOnce(host, path, next.search);
    }
  }

  if (resolved.status !== "ok") {
    if (resolved.status === "private" || resolved.status === "password_required") {
      const reason: PageReadDenyReason =
        access.denyReason ?? (resolved.status === "password_required" ? "password_route" : "project_forbidden");
      if (access.deniedSite) {
        await audit({
          action: "pages.cli_read.denied",
          actorId: workspace.user.id,
          metadataJson: { host, path, reason },
          organizationId: access.deniedSite.organizationId,
          projectId: access.deniedSite.projectId,
          requestId,
          siteId: access.deniedSite.id,
        });
      }
      throw new ConsoleApiError(403, { error: "page_access_denied", fieldErrors: { reason } });
    }
    if (resolved.status === "error" && resolved.httpStatus === 503) {
      throw new ConsoleApiError(503, { error: "page_unavailable", fieldErrors: { code: resolved.code } });
    }
    throw new ConsoleApiError(404, { error: "page_not_found" });
  }

  const ok: PagesRouteResolveOkResponse = resolved;
  const visibility = effectiveVisibility(ok.site.visibility, ok.route.visibility);
  const readAsMember = access.memberSite !== null && visibility !== "public";
  const readAsGuest = !readAsMember && access.guestSite !== null && visibility !== "public";

  const isText = isPageReadTextPath(ok.object.path);
  const fitsTextLimit = ok.object.sizeBytes === null || ok.object.sizeBytes <= PAGE_READ_MAX_SOURCE_BYTES;
  if (request.format !== "files") {
    if (!isText) {
      throw new ConsoleApiError(415, {
        error: "page_content_unsupported",
        fieldErrors: { contentType: ok.object.contentType, path: ok.object.path },
      });
    }
    if (!fitsTextLimit) {
      throw new ConsoleApiError(413, {
        error: "page_too_large",
        fieldErrors: { sizeBytes: String(ok.object.sizeBytes) },
      });
    }
  }

  const storage = deps.storage ?? createPageObjectStorageFromEnv();
  const pageUrl = `https://${host}${path}`;
  let source: string | null = null;
  if (isText && fitsTextLimit && storage.readObjectText) {
    source = await storage.readObjectText({ key: ok.object.r2Key, maxBytes: PAGE_READ_MAX_SOURCE_BYTES });
  }
  if (source === null && request.format !== "files") {
    throw new ConsoleApiError(503, { error: "page_content_unavailable" });
  }
  const extraction =
    source === null
      ? emptyExtraction(ok.object.path)
      : extractPageText({ baseUrl: pageUrl, path: ok.object.path, source });

  let files: PageReadFile[] | undefined;
  let filesExpireAt: string | undefined;
  if (request.format === "files") {
    const listed = await listRouteFiles({
      artifactId: ok.artifact.id,
      artifactVersionId: ok.artifact.versionId,
      entrypoint: ok.object.path,
      listFiles: deps.listFiles ?? listArtifactVersionFiles,
      storage,
    });
    files = listed;
    filesExpireAt = new Date(
      (deps.now ?? (() => new Date()))().getTime() + PAGE_READ_FILE_URL_TTL_SECONDS * 1000,
    ).toISOString();
  }

  const fullText =
    request.format === "html" ? (source ?? "") : files ? fileListText(files) : extraction.markdown;
  const maxChars = request.maxChars ?? PAGE_READ_DEFAULT_MAX_CHARS;
  const start = Math.min(request.cursor, fullText.length);
  const text = fullText.slice(start, start + maxChars);
  const end = start + text.length;

  const routes = (await repository.listReleaseRoutes(ok.release.id))
    .map((route) => ({
      path: route.path,
      matchType: route.matchType,
      url: `https://${host}${route.path}`,
      visibility: effectiveVisibility(ok.site.visibility, route.visibility),
    }))
    .filter(
      (route) =>
        route.visibility === "public" ||
        access.memberSite !== null ||
        (readAsGuest && route.path === ok.route.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_ROUTES);

  if (readAsMember || readAsGuest) {
    await audit({
      action: "pages.cli_read.allowed",
      actorId: workspace.user.id,
      metadataJson: {
        ...(readAsGuest ? { access: "grant" } : {}),
        format: request.format,
        host,
        path,
        routeId: ok.route.id,
        visibility,
        ...(files ? { fileCount: files.length } : {}),
      },
      organizationId: ok.site.organizationId,
      projectId: ok.site.projectId,
      requestId,
      siteId: ok.site.id,
    });
  }

  return {
    page: {
      url: pageUrl,
      host,
      path,
      title: extraction.title,
      description: extraction.description,
      visibility,
      siteId: ok.site.id,
      projectId: ok.site.projectId,
      route: { id: ok.route.id, path: ok.route.path, matchType: ok.route.matchType },
      release: { id: ok.release.id, number: ok.release.number },
      artifact: { id: ok.artifact.id, versionId: ok.artifact.versionId, versionNumber: ok.artifact.versionNumber },
      file: {
        path: ok.object.path,
        contentType: ok.object.contentType,
        sizeBytes: ok.object.sizeBytes,
        sha256: ok.object.sha256,
      },
    },
    content: {
      format: request.format,
      representation:
        request.format === "html" ? "entry_source" : request.format === "files" ? "file_list" : "extracted_markdown",
      note: REPRESENTATION_NOTES[request.format],
      text,
      cursor: start,
      nextCursor: end < fullText.length ? end : null,
      totalChars: fullText.length,
      truncated: end < fullText.length,
    },
    ...(files ? { files, filesExpireAt } : {}),
    links: extraction.links,
    routes,
    signals: extraction.signals,
    contentTrust: "untrusted",
  };
}

async function listRouteFiles({
  artifactId,
  artifactVersionId,
  entrypoint,
  listFiles,
  storage,
}: {
  artifactId: string;
  artifactVersionId: string;
  entrypoint: string;
  listFiles: NonNullable<PageReadDeps["listFiles"]>;
  storage: PageObjectStorage;
}): Promise<PageReadFile[]> {
  if (!storage.presignObjectGet) throw new ConsoleApiError(503, { error: "page_content_unavailable" });
  const stored = (await listFiles({ artifactId, artifactVersionId })).sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = stored.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  if (stored.length > PAGE_READ_MAX_FILES || totalBytes > PAGE_READ_MAX_FILES_BYTES) {
    throw new ConsoleApiError(413, {
      error: "page_too_large",
      fieldErrors: { fileCount: String(stored.length), sizeBytes: String(totalBytes) },
    });
  }
  const presign = storage.presignObjectGet.bind(storage);
  return Promise.all(
    stored.map(async (file) => {
      const key = storedObjectKey({ artifactId, artifactVersionId, file });
      if (!key) throw new ConsoleApiError(503, { error: "page_content_unavailable" });
      return {
        path: file.path,
        contentType: file.mimeType ?? "application/octet-stream",
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        entrypoint: file.path === entrypoint,
        url: await presign({ key, expiresInSeconds: PAGE_READ_FILE_URL_TTL_SECONDS }),
      };
    }),
  );
}

// Only final keys of this artifact version are signed, as the Worker serves them.
function storedObjectKey({
  artifactId,
  artifactVersionId,
  file,
}: {
  artifactId: string;
  artifactVersionId: string;
  file: PageReadStoredFile;
}) {
  for (const name of ["r2Key", "objectKey", "key"]) {
    const value = file.storageJson[name];
    if (typeof value !== "string" || value.length === 0) continue;
    return isFinalObjectKeyForArtifact({ artifactId, artifactVersionId, key: value, path: file.path }) ? value : null;
  }
  return null;
}

function fileListText(files: PageReadFile[]) {
  return files
    .map((file) => {
      const size = file.sizeBytes === null ? "" : ` (${file.sizeBytes} bytes)`;
      return `- ${file.path}${size}${file.entrypoint ? " [entry]" : ""}`;
    })
    .join("\n");
}

function emptyExtraction(path: string) {
  return {
    title: path,
    description: null,
    markdown: "",
    links: [] as PageReadLink[],
    signals: { scripts: 0, raviElements: [] as string[], staticTextChars: 0, renderSuggested: false },
  };
}

async function listArtifactVersionFiles(input: {
  artifactId: string;
  artifactVersionId: string;
}): Promise<PageReadStoredFile[]> {
  return db
    .select({
      path: schema.assets.path,
      mimeType: schema.assets.mimeType,
      sizeBytes: schema.assets.sizeBytes,
      sha256: schema.assets.sha256,
      storageJson: schema.assets.storageJson,
    })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.artifactId, input.artifactId), eq(schema.assets.artifactVersionId, input.artifactVersionId)),
    )
    .limit(PAGE_READ_MAX_FILES + 1);
}

export function parsePageUrl(value: string): { host: string; path: string; search: string } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return { host: url.host.toLowerCase(), path: url.pathname || "/", search: url.search };
}

async function insertPageReadAudit(input: PageReadAudit) {
  await db.insert(schema.auditEvents).values({
    action: input.action,
    actorId: input.actorId,
    actorType: "user",
    metadataJson: input.metadataJson,
    organizationId: input.organizationId,
    projectId: input.projectId,
    requestId: input.requestId,
    targetId: input.siteId,
    targetType: "page_site",
  });
}

async function memberRoleInOrganization(input: { organizationId: string; userId: string }) {
  return (await memberActorForOrganization(input))?.role ?? null;
}
