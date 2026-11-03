// `ravi.pages.ship`: publish one HTML page on a route of the project's default
// Pages host, as the person, the way `ravi pages ship` does: the default host
// (created when the project has none), the page kit (theme, widgets, runtime),
// an upload session, a server-side PUT of `index.html`, then finalize with the
// route. MCP only, and always behind the surface's confirmation step.
// See `.ravi/specs/console/operations/SPEC.md`.

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { createPageSite } from "@/server/console/pages";
import type { JsonSchemaObject } from "@/server/console/pages/connectors/catalog";
import { runPageKitAs } from "@/server/console/pages/kit/service";
import { validateRoutePath } from "@/server/console/pages/policy";
import { projectOwnedPagesSlug } from "@/server/console/pages/project-owned";
import {
  createPageObjectStorageFromEnv,
  createPageUploadSession,
  finalizePageUploadSession,
  pagePublishRepositoryForDb,
  type PageObjectStorage,
  type PagePublishContext,
  type PagePublishResult,
} from "@/server/console/pages/publish";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";

import type { BasesCaller } from "@/server/console/bases/context";
import type { OperationActor, OperationChangeLine, OperationSurface } from "./types";

export const PAGES_SHIP_OPERATION_ID = "ravi.pages.ship";

/** Largest page an agent may send; the Worker's internal body cap is 256 KiB. */
export const PAGES_SHIP_MAX_HTML_CHARS = 200_000;

/** Organization roles that publish Pages (`publish.ts` `PUBLISH_ROLES`). */
const SHIP_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "developer"]);

/** Runtime text defaults to pt-BR, so a `body` page the kit gave no language gets this one. */
const SHIP_BODY_FALLBACK_LANG = "pt-BR";
const ENTRYPOINT = "index.html";
const RAVI_BASES_USE_PREFIX = "ravi.bases.";

const VISIBILITIES = ["private", "protected_link", "public"] as const;
type ShipVisibility = (typeof VISIBILITIES)[number];

export const pagesShipInputSchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(PAGES_SHIP_MAX_HTML_CHARS).optional(),
    html: z.string().min(1).max(PAGES_SHIP_MAX_HTML_CHARS).optional(),
    route: z.string().trim().min(1).max(1024).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    theme: z.string().trim().min(1).max(401).optional(),
  })
  .strict()
  .refine((input) => (input.body === undefined) !== (input.html === undefined), {
    message: "Send exactly one of body (an HTML fragment) or html (a full document).",
    path: ["body"],
  });

export type PagesShipInput = z.infer<typeof pagesShipInputSchema>;

export function pagesShipJsonSchema(_surface: OperationSurface): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      project: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Project slug or id the page is published in. Use ravi.projects.list to find one.",
      },
      title: { type: "string", minLength: 1, maxLength: 200, description: "Page title. It does not create a host." },
      body: {
        type: "string",
        minLength: 1,
        maxLength: PAGES_SHIP_MAX_HTML_CHARS,
        description: "An HTML body fragment, wrapped in a simple HTML5 document with the title. Send this or html, not both.",
      },
      html: {
        type: "string",
        minLength: 1,
        maxLength: PAGES_SHIP_MAX_HTML_CHARS,
        description: "A full HTML document, published as is (after the page kit). Send this or body, not both.",
      },
      route: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description: "Route on the project's default host, such as /relatorio. Defaults to / (the project home). Publishing replaces what that route shows; list routes with ravi.pages.published.list first.",
      },
      visibility: {
        type: "string",
        enum: [...VISIBILITIES],
        description: "Who can open the route. Defaults to private (signed-in members). Use public only when the person asked for it.",
      },
      theme: {
        type: "string",
        minLength: 1,
        maxLength: 401,
        description: "A Library theme ref, or none. Defaults to the project theme, else the organization theme.",
      },
    },
    required: ["project", "title"],
  };
}

/** The confirmation card's lines: the project, title, route, visibility and the start of the page. */
export function describePagesShip(raw: Record<string, unknown>): OperationChangeLine[] {
  const lines: OperationChangeLine[] = [{ label: "ação", value: "publicar uma página no Ravi Pages" }];
  if (typeof raw.project === "string") lines.push({ label: "projeto", value: raw.project });
  if (typeof raw.title === "string") lines.push({ label: "título", value: preview(raw.title) });
  const route = typeof raw.route === "string" && raw.route.trim() ? raw.route.trim() : "/";
  lines.push({ label: "rota", value: `${route} (substitui o que essa rota mostra hoje)` });
  lines.push({ label: "visibilidade", value: visibilityLabel(typeof raw.visibility === "string" ? raw.visibility : "private") });
  const content = typeof raw.body === "string" ? raw.body : typeof raw.html === "string" ? raw.html : null;
  if (content) lines.push({ label: "conteúdo", value: preview(content) });
  return lines;
}

export type PagesShipDeps = {
  findProject?: typeof findAccessibleProjectRecord;
  findDefaultSite?: (projectId: string) => Promise<ShipSite | null>;
  createDefaultSite?: (input: {
    actor: OperationActor;
    project: { id: string; slug: string };
    visibility: ShipVisibility;
  }) => Promise<ShipSite>;
  runKit?: typeof runPageKitAs;
  /** The registry's `basesCallerForActor`, passed in so this module never imports the registry. */
  basesCaller: (actor: OperationActor) => BasesCaller;
  findUploadSessionId?: (input: {
    context: PagePublishContext;
    projectId: string;
    idempotencyKey: string;
  }) => Promise<{ id: string; status: string } | null>;
  createUploadSession?: typeof createPageUploadSession;
  finalize?: typeof finalizePageUploadSession;
  storage?: PageObjectStorage;
  fetch?: typeof fetch;
};

type ShipSite = { id: string; slug: string; defaultHostname: string; defaultVisibility: string };

export type PagesShipOutput = {
  url: string | null;
  route: string;
  visibility: string;
  title: string;
  host: string;
  siteSlug: string;
  artifactId: string;
  releaseId: string | null;
  createdHost: boolean;
  uses?: string[];
  warnings?: string[];
};

/**
 * Publishes the page as `actor`. Called only by the registry after the
 * person confirmed; `seed` (the confirmation token id) makes a replay of the
 * same confirmation return the first publish instead of publishing again.
 */
export async function runPagesShip(
  actor: OperationActor,
  raw: Record<string, unknown>,
  seed: string | undefined,
  deps: PagesShipDeps,
): Promise<PagesShipOutput> {
  if (actor.kind !== "member" || !actor.orgRole || !SHIP_ROLES.has(actor.orgRole)) {
    throw forbidden("Only owners, admins and developers of the organization publish Pages.");
  }
  const parsed = pagesShipInputSchema.parse(raw);
  const route = validateRoutePath(parsed.route ?? "/");
  if (!route.ok) throw invalid("route", "Not a Pages route path; use something like / or /relatorio.");
  const visibility: ShipVisibility = parsed.visibility ?? "private";

  const workspace: ProjectAccessWorkspace = {
    user: { id: actor.userId },
    organization: { id: actor.organizationId },
    membership: { role: actor.orgRole },
  };
  const project = await (deps.findProject ?? findAccessibleProjectRecord)(workspace, parsed.project, "write");
  if (!project || project.status === "deleted") throw forbidden("The person cannot publish in this project.");
  if (actor.boundProjectId && project.id !== actor.boundProjectId) {
    throw forbidden("A cloud run works only in its own project.");
  }

  let site = await (deps.findDefaultSite ?? findDefaultSite)(project.id);
  let createdHost = false;
  if (!site) {
    site = await (deps.createDefaultSite ?? createDefaultSite)({ actor, project, visibility });
    createdHost = true;
  }

  const document = parsed.body !== undefined ? wrapHtml5Document(parsed.title, parsed.body) : parsed.html!;
  let kit;
  try {
    kit = await (deps.runKit ?? runPageKitAs)({
      context: {
        user: { id: actor.userId },
        organization: { id: actor.organizationId },
        membership: { role: actor.orgRole },
        bases: deps.basesCaller(actor),
      },
      body: {
        project: project.id,
        site: site.slug,
        route: route.path,
        visibility,
        theme: parsed.theme ?? null,
        files: [{ path: ENTRYPOINT, html: document }],
      },
    });
  } catch (error) {
    throw kitError(error);
  }
  const kitErrors = kit.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (kitErrors.length > 0) {
    throw invalid(
      parsed.body !== undefined ? "body" : "html",
      kitErrors
        .slice(0, 5)
        .map((diagnostic) => diagnostic.message)
        .join(" "),
    );
  }
  const kitFile = kit.files.find((file) => file.path === ENTRYPOINT);
  let html = kitFile?.changed && typeof kitFile.html === "string" ? kitFile.html : document;
  // Only the wrapper this operation wrote gets the fallback language; a full document keeps its own.
  if (parsed.body !== undefined) html = withHtmlLang(html, SHIP_BODY_FALLBACK_LANG);

  const uses = [...new Set(kit.uses)].sort();
  // A public route never gets the Pages session that ravi.bases.* connectors need.
  const basesUses = uses.filter((use) => use.startsWith(RAVI_BASES_USE_PREFIX));
  if (visibility === "public" && basesUses.length > 0) {
    throw invalid(
      "visibility",
      `A public route cannot show live Bases data (${basesUses.join(", ")}). Keep it private for members, or publish a snapshot without <ravi-view> tags for outsiders.`,
    );
  }

  const context: PagePublishContext = {
    authorization: actor.authorization,
    actorId: actor.userId,
    actorType: "user",
    membershipRole: actor.orgRole,
    organizationId: actor.organizationId,
  };
  const storage = deps.storage ?? createPageObjectStorageFromEnv();
  const bytes = Buffer.from(html, "utf8");
  const packageManifest = {
    entrypoint: ENTRYPOINT,
    files: [{ path: ENTRYPOINT, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength, contentType: "text/html; charset=utf-8" }],
    ...(uses.length > 0 ? { uses } : {}),
  };
  const idempotencyKey = seed ? `mcp-ship:${sha256Hex(Buffer.from(`${actor.userId}:${seed}`)).slice(0, 40)}` : null;
  const finalizeInput = (uploadSessionId: string) => ({
    uploadSessionId,
    idempotencyKey,
    packageManifest,
    artifact: { name: parsed.title },
    publish: {
      siteRef: site.id,
      activate: true,
      replaceRelease: false,
      reason: "ravi.pages.ship (MCP)",
      visibility,
      route: { path: route.path, visibility },
      ...(uses.length > 0 ? { uses } : {}),
      ...(kit.presentation ? { presentation: kit.presentation } : {}),
    },
    source: { tool: "mcp ravi.pages.ship" },
  });
  const finalize = deps.finalize ?? finalizePageUploadSession;

  let result: PagePublishResult;
  try {
    // A replayed confirmation finds its own finished upload and returns that publish.
    const previous = idempotencyKey
      ? await (deps.findUploadSessionId ?? findUploadSessionId)({ context, projectId: project.id, idempotencyKey })
      : null;
    if (previous?.status === "finalized") {
      result = await finalize({ context, input: finalizeInput(previous.id), requestId: actor.requestId, storage });
    } else {
      const session = await (deps.createUploadSession ?? createPageUploadSession)({
        context,
        input: { projectRef: project.id, siteRef: site.id, idempotencyKey, packageManifest },
        requestId: actor.requestId,
        storage,
      });
      const fetchImpl = deps.fetch ?? fetch;
      for (const file of uploadPolicyFiles(session.uploadPolicy)) {
        // The metadata-only driver (local development) keeps no bytes.
        if (file.method !== "PUT" || !file.url) continue;
        const response = await fetchImpl(file.url, { method: "PUT", headers: file.headers, body: bytes });
        if (!response.ok) throw new ConsoleApiError(502, { error: "publish_storage_failed" });
      }
      result = await finalize({
        context,
        input: finalizeInput(session.uploadSession.id),
        requestId: actor.requestId,
        storage,
      });
    }
  } catch (error) {
    throw publishFailure(error);
  }

  const publishedRoute = result.routes.find((candidate) => candidate.path === route.path) ?? null;
  const effectiveVisibility = publishedRoute?.visibility ?? visibility;
  const warnings = [...kit.warnings];
  if (effectiveVisibility !== visibility) {
    warnings.push(`The route is ${effectiveVisibility}, not ${visibility}: the host's default visibility (${site.defaultVisibility}) wins.`);
  }
  return {
    url: result.url ?? `https://${site.defaultHostname}${route.path === "/" ? "/" : route.path}`,
    route: route.path,
    visibility: effectiveVisibility,
    title: parsed.title,
    host: site.defaultHostname,
    siteSlug: site.slug,
    artifactId: result.artifact.id,
    releaseId: result.release?.id ?? null,
    createdHost,
    ...(uses.length > 0 ? { uses } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * The `body` document. `<html>` has no `lang` on purpose: the page kit sets
 * the theme's locale, and the pt-BR fallback applies when it did not.
 * Same wrapper as `ravi pages ship --body`.
 */
export function wrapHtml5Document(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
${body.trim()}
</body>
</html>
`;
}

const HTML_OPEN_TAG = /<html\b[^>]*>/i;
const LANG_ATTRIBUTE = /\slang\s*=/i;

/** The document with `lang` on its first `<html>` tag, or unchanged when that tag already has one. */
export function withHtmlLang(html: string, lang: string): string {
  const match = HTML_OPEN_TAG.exec(html);
  if (!match || LANG_ATTRIBUTE.test(match[0])) return html;
  const at = match.index + "<html".length;
  return `${html.slice(0, at)} lang="${lang}"${html.slice(at)}`;
}

async function findDefaultSite(projectId: string): Promise<ShipSite | null> {
  const [site] = await db
    .select({
      id: schema.pageSites.id,
      slug: schema.pageSites.slug,
      defaultHostname: schema.pageSites.defaultHostname,
      defaultVisibility: schema.pageSites.defaultVisibility,
    })
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.projectId, projectId), eq(schema.pageSites.isDefault, true), eq(schema.pageSites.status, "active")))
    .limit(1);
  return site ?? null;
}

/** The project's default host `<org>-<project>`, as `ravi pages ship` creates it on a project's first page. */
async function createDefaultSite(input: {
  actor: OperationActor;
  project: { id: string; slug: string };
  visibility: ShipVisibility;
}): Promise<ShipSite> {
  const [organization] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, input.actor.organizationId))
    .limit(1);
  if (!organization?.slug) throw invalid("project", "This project has no default Pages host and none can be named.");
  const slug = projectOwnedPagesSlug({ organizationSlug: organization.slug, projectSlug: input.project.slug });
  if (/^ravi(?:-|$)/.test(slug)) {
    throw invalid("project", `This project has no default Pages host, and ${slug} is a reserved name. Create the host in the Console first.`);
  }
  const site = await createPageSite({
    input: { slug, isDefault: true, defaultVisibility: input.visibility },
    projectRef: input.project.id,
    requestId: input.actor.requestId,
    workspace: {
      authorization: input.actor.authorization,
      mode: "workos",
      user: { id: input.actor.userId },
      organization: { id: input.actor.organizationId },
      membership: { role: input.actor.orgRole ?? "" },
    } as Parameters<typeof createPageSite>[0]["workspace"],
  });
  return { id: site.id, slug: site.slug, defaultHostname: site.defaultHostname, defaultVisibility: site.defaultVisibility };
}

async function findUploadSessionId(input: { context: PagePublishContext; projectId: string; idempotencyKey: string }) {
  const session = await pagePublishRepositoryForDb().findUploadSessionByIdempotencyKey({
    organizationId: input.context.organizationId,
    projectId: input.projectId,
    actorType: input.context.actorType,
    actorId: input.context.actorId,
    idempotencyKey: input.idempotencyKey,
  });
  return session ? { id: session.id, status: session.status } : null;
}

function uploadPolicyFiles(policy: Record<string, unknown>) {
  const files = Array.isArray(policy.files) ? policy.files : [];
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const record = file as Record<string, unknown>;
    const headers =
      record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
        ? Object.fromEntries(
            Object.entries(record.headers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {};
    return [{ method: typeof record.method === "string" ? record.method : null, url: typeof record.url === "string" ? record.url : null, headers }];
  });
}

/**
 * The MCP Worker turns only the registry's own codes into tool errors the
 * model can act on, so publish errors leave as `operation_forbidden`,
 * `payload_invalid` (with the reason in `fieldErrors`) or `operation_unavailable`.
 */
function publishFailure(error: unknown): ConsoleApiError {
  if (!(error instanceof ConsoleApiError)) return new ConsoleApiError(503, { error: "operation_unavailable" });
  const code = typeof error.payload.error === "string" ? error.payload.error : "";
  if (code === "publish_forbidden") return forbidden("The person cannot publish in this project.");
  if (code === "publish_unread_comments") {
    const fieldErrors = error.payload.fieldErrors;
    const message =
      fieldErrors && typeof fieldErrors === "object" && typeof (fieldErrors as Record<string, unknown>).comments === "string"
        ? String((fieldErrors as Record<string, unknown>).comments)
        : "This route has unread Page comments.";
    return invalid("route", `${message} The person reads them in the Ravi Console, then publish again.`);
  }
  if (code === "publish_site_unavailable") return invalid("project", "The project's default Pages host is not active.");
  if (code === "operation_forbidden" || code === "payload_invalid" || code === "operation_unavailable") return error;
  if (error.status >= 500) return new ConsoleApiError(503, { error: "operation_unavailable" });
  return invalid("publish", `The Console refused the publish (${code || "publish_failed"}).`);
}

function kitError(error: unknown): ConsoleApiError {
  if (error instanceof CliApiError) {
    if (error.status === 403) return forbidden("The person cannot publish in this project.");
    if (error.status === 404) return invalid("project", error.message);
    if (error.status < 500) return invalid("html", error.message);
    return new ConsoleApiError(503, { error: "operation_unavailable" });
  }
  if (error instanceof ConsoleApiError) return publishFailure(error);
  return new ConsoleApiError(503, { error: "operation_unavailable" });
}

function forbidden(reason: string) {
  return new ConsoleApiError(403, { error: "operation_forbidden", reason });
}

function invalid(field: string, message: string) {
  return new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { [field]: message } });
}

function visibilityLabel(visibility: string) {
  if (visibility === "public") return "pública (qualquer pessoa com o link)";
  if (visibility === "protected_link") return "link protegido";
  return "privada (só membros com acesso)";
}

function preview(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function sha256Hex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
