import { and, eq, or } from "drizzle-orm";
import { z } from "zod";

import type { ConsoleRole } from "@/lib/auth/session";
import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageSiteForProject, type PageSite } from "@/server/console/pages";
import { normalizeHostname } from "@/server/console/pages/resolve";
import { normalizeViewerAssertionAudience } from "@/server/console/pages/viewer-assertions/audience";
import {
  createViewerAssertionAudienceForSite,
  serializeViewerAssertionAudience,
  viewerAssertionRegistryRepositoryForDb,
  type ViewerAssertionRegistryRepository,
} from "@/server/console/pages/viewer-assertions/registry";
import {
  findAccessibleProjectRecord,
  type ProjectAccessWorkspace,
} from "@/server/console/project-access";
import { db, schema } from "@/server/db";

import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";

const setBodySchema = z
  .object({
    aud: z.string().optional(),
    audience: z.string().optional(),
    origins: z.array(z.string()).min(1).max(8),
  })
  .strict();

export const VIEWER_ASSERTION_AUDIENCE_CLI_READ_SCOPE = "console.projects.read";
export const VIEWER_ASSERTION_AUDIENCE_CLI_WRITE_SCOPE = "console.projects.link";

export type ViewerAssertionCliWorkspace = ProjectAccessWorkspace & {
  membership: { role: ConsoleRole };
  mode: "workos";
  organization: { id: string };
  user: { id: string };
};

export type ViewerAssertionCliSite = {
  defaultHostname: string;
  id: string;
  organizationId: string;
  projectId: string;
  status: string;
};

type SiteResolverDeps = {
  findProject?: typeof findAccessibleProjectRecord;
  findSiteByHost?: (input: {
    host: string;
    organizationId: string;
    projectId: string;
  }) => Promise<PageSite | null>;
  getSiteForProject?: typeof getPageSiteForProject;
};

export type ViewerAssertionAudienceCliDeps = {
  repository?: ViewerAssertionRegistryRepository;
  resolveSite?: (input: {
    action: "read" | "write";
    projectRef: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  }) => Promise<ViewerAssertionCliSite>;
};

export function cliHasViewerAssertionAudienceReadScope(scopes: readonly string[]) {
  return scopes.includes(VIEWER_ASSERTION_AUDIENCE_CLI_READ_SCOPE);
}

export function cliHasViewerAssertionAudienceWriteScope(scopes: readonly string[]) {
  return scopes.includes(VIEWER_ASSERTION_AUDIENCE_CLI_WRITE_SCOPE);
}

export function viewerAssertionAudienceCliError(error: ConsoleApiError) {
  if (error.payload.error === "payload_invalid" || error.payload.error === "validation_failed") {
    return cliApiError(400, "PAYLOAD_INVALID", fieldErrorMessage(error.payload.fieldErrors));
  }
  if (error.payload.error === "viewer_assertion_audience_unknown") {
    return cliApiError(
      404,
      "PAYLOAD_INVALID",
      "The requested viewer assertion audience is not registered on this site.",
    );
  }
  if (
    error.payload.error === "forbidden" ||
    error.payload.error === "not_found" ||
    error.payload.error === "project_forbidden" ||
    error.payload.error === "project_not_found" ||
    error.payload.error === "site_not_found"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE", "Pages viewer assertion audiences are temporarily unavailable.");
}

export async function resolveViewerAssertionCliSite(
  input: {
    action: "read" | "write";
    projectRef: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  },
  deps: SiteResolverDeps = {},
): Promise<ViewerAssertionCliSite> {
  const getSiteForProject = deps.getSiteForProject ?? getPageSiteForProject;
  let siteByRef: PageSite | null = null;
  try {
    siteByRef = await getSiteForProject({
      action: input.action,
      projectRef: input.projectRef,
      siteRef: input.siteRef,
      workspace: input.workspace,
    });
  } catch (error) {
    if (!(error instanceof ConsoleApiError) || error.payload.error !== "site_not_found") {
      throw error;
    }
  }
  if (siteByRef) {
    if (siteByRef.status !== "active") {
      throw new ConsoleApiError(404, { error: "site_not_found" });
    }
    return toCliSite(siteByRef);
  }

  const host = normalizeHostname(input.siteRef);
  if (!host || !host.includes(".")) {
    throw new ConsoleApiError(404, { error: "site_not_found" });
  }

  const project = await (deps.findProject ?? findAccessibleProjectRecord)(
    input.workspace,
    input.projectRef,
    input.action,
  );
  if (!project || project.organizationId !== input.workspace.organization.id) {
    throw new ConsoleApiError(404, { error: "project_not_found" });
  }

  const site = await (deps.findSiteByHost ?? findActiveSiteByHost)({
    host,
    organizationId: input.workspace.organization.id,
    projectId: project.id,
  });
  if (
    !site ||
    site.status !== "active" ||
    site.projectId !== project.id ||
    site.organizationId !== input.workspace.organization.id
  ) {
    throw new ConsoleApiError(404, { error: "site_not_found" });
  }
  return toCliSite(site);
}

export async function listViewerAssertionAudiencesFromCli(
  input: {
    projectRef: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  },
  deps: ViewerAssertionAudienceCliDeps = {},
) {
  const site = await resolveSite(input, "read", deps);
  const repository = deps.repository ?? viewerAssertionRegistryRepositoryForDb();
  const items = await repository.listAudiences(site.id);
  return {
    items: items.map(serializeViewerAssertionAudience),
    projectRef: input.projectRef,
    siteRef: input.siteRef,
  };
}

export async function setViewerAssertionAudienceFromCli(
  input: {
    body: unknown;
    projectRef: string;
    requestId: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  },
  deps: ViewerAssertionAudienceCliDeps = {},
) {
  const site = await resolveSite(input, "write", deps);
  const repository = deps.repository ?? viewerAssertionRegistryRepositoryForDb();
  const record = await createViewerAssertionAudienceForSite({
    body: setBodyForRegistry(input.body),
    repository,
    requestId: input.requestId,
    site,
    userId: input.workspace.user.id,
  });
  return {
    ...serializeViewerAssertionAudience(record),
    projectRef: input.projectRef,
    siteRef: input.siteRef,
  };
}

export async function removeViewerAssertionAudienceFromCli(
  input: {
    audience: string;
    projectRef: string;
    requestId: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  },
  deps: ViewerAssertionAudienceCliDeps = {},
) {
  const site = await resolveSite(input, "write", deps);
  const repository = deps.repository ?? viewerAssertionRegistryRepositoryForDb();
  const audience = normalizeRemoveAudience(input.audience);
  const existing = (await repository.listAudiences(site.id)).find((item) => item.audience === audience);
  if (!existing) {
    throw new ConsoleApiError(404, { error: "viewer_assertion_audience_unknown" });
  }

  const deleted = await repository.deleteAudience({ id: existing.id, siteId: site.id });
  if (!deleted || deleted.audience !== audience) {
    throw new ConsoleApiError(404, { error: "viewer_assertion_audience_unknown" });
  }

  await repository.insertAudit({
    action: "pages.viewer_assertion_audience.deleted",
    actorId: input.workspace.user.id,
    metadataJson: {
      audience: deleted.audience,
      requestId: input.requestId,
      siteId: site.id,
    },
    organizationId: site.organizationId,
    projectId: site.projectId,
    requestId: input.requestId,
    targetId: deleted.id,
  });

  return {
    audience: deleted.audience,
    id: deleted.id,
    projectRef: input.projectRef,
    siteRef: input.siteRef,
  };
}

export function audienceFromCliRemoveRequest(request: Request, body: unknown) {
  const search = new URL(request.url).searchParams;
  const fromQuery = search.get("aud") ?? search.get("audience");
  const fromBody = audienceFromBody(body);
  if (fromQuery && fromBody && fromQuery !== fromBody) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { audience: "Query and body audience values must match." },
    });
  }
  const audience = fromQuery ?? fromBody;
  if (!audience || !audience.trim()) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { audience: "Audience is required." },
    });
  }
  return audience;
}

async function resolveSite(
  input: {
    projectRef: string;
    siteRef: string;
    workspace: ViewerAssertionCliWorkspace;
  },
  action: "read" | "write",
  deps: ViewerAssertionAudienceCliDeps,
) {
  const resolve = deps.resolveSite ?? resolveViewerAssertionCliSite;
  return resolve({ ...input, action });
}

function setBodyForRegistry(body: unknown) {
  const parsed = setBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "payload_invalid" });
  }
  if (parsed.data.audience && parsed.data.aud && parsed.data.audience !== parsed.data.aud) {
    throw new ConsoleApiError(400, {
      error: "payload_invalid",
      fieldErrors: { audience: "Audience must be an exact string without spaces or wildcards." },
    });
  }
  const audience = parsed.data.audience ?? parsed.data.aud;
  if (!audience) {
    throw new ConsoleApiError(400, {
      error: "payload_invalid",
      fieldErrors: { audience: "Audience must be an exact string without spaces or wildcards." },
    });
  }
  return { audience, origins: parsed.data.origins };
}

function normalizeRemoveAudience(value: string) {
  return normalizeViewerAssertionAudience(value);
}

function audienceFromBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.audience === "string") return record.audience;
  if (typeof record.aud === "string") return record.aud;
  return null;
}

function fieldErrorMessage(fieldErrors: Record<string, string> | undefined) {
  if (!fieldErrors) return undefined;
  const messages = Object.values(fieldErrors).map((value) => value.trim()).filter(Boolean);
  return messages.length > 0 ? messages.join(" ") : undefined;
}

function toCliSite(site: {
  defaultHostname: string;
  id: string;
  organizationId: string;
  projectId: string;
  status: string;
}): ViewerAssertionCliSite {
  return {
    defaultHostname: site.defaultHostname,
    id: site.id,
    organizationId: site.organizationId,
    projectId: site.projectId,
    status: site.status,
  };
}

async function findActiveSiteByHost(input: {
  host: string;
  organizationId: string;
  projectId: string;
}): Promise<PageSite | null> {
  const host = normalizeHostname(input.host);
  if (!host) return null;
  const hostedSlug = hostedSlugFromPagesHost(host);
  const hostPredicate = hostedSlug
    ? or(eq(schema.pageSites.defaultHostname, host), eq(schema.pageSites.slug, hostedSlug))
    : eq(schema.pageSites.defaultHostname, host);

  const [byHost] = await db
    .select()
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.organizationId, input.organizationId),
        eq(schema.pageSites.projectId, input.projectId),
        eq(schema.pageSites.status, "active"),
        hostPredicate,
      ),
    )
    .limit(1);
  if (byHost) return byHost;

  const [byCustomHost] = await db
    .select({ site: schema.pageSites })
    .from(schema.pageDomainBindings)
    .innerJoin(
      schema.domainBindings,
      eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id),
    )
    .innerJoin(schema.pageSites, eq(schema.pageDomainBindings.pageSiteId, schema.pageSites.id))
    .where(
      and(
        eq(schema.pageDomainBindings.hostname, host),
        eq(schema.domainBindings.product, "pages"),
        eq(schema.domainBindings.status, "active"),
        eq(schema.pageSites.organizationId, input.organizationId),
        eq(schema.pageSites.projectId, input.projectId),
        eq(schema.pageSites.status, "active"),
      ),
    )
    .limit(1);
  return byCustomHost?.site ?? null;
}

function hostedSlugFromPagesHost(host: string) {
  const domain = hostedPagesDomain();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix) || host === domain) return null;
  const slug = host.slice(0, -suffix.length);
  return slug && !slug.includes(".") ? slug : null;
}
