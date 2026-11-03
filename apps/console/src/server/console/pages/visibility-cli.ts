import { z } from "zod";

import type { ConsoleRole } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageSiteForProject } from "@/server/console/pages";
import { updateAuthorizedPagesRouteVisibility } from "@/server/console/pages/operator";
import { resolvePagesPasswordRouteContext } from "@/server/console/pages/password-access";
import { validateRoutePath } from "@/server/console/pages/policy";

export const PAGES_ROUTE_VISIBILITY_CLI_WRITE_SCOPES = [
  "console.projects.link",
  "artifacts.publish",
] as const;

const visibilityCliInputSchema = z.object({
  path: z.string().min(1).max(2_048),
  siteRef: z.string().min(1).max(200),
  visibility: z.enum(["public", "private", "protected_link"]),
}).strict();

export type PagesRouteVisibilityCliInput = z.infer<typeof visibilityCliInputSchema>;

export type PagesRouteVisibilityCliWorkspace = {
  membership: { role: ConsoleRole };
  mode: "workos";
  organization: { id: string };
  scopes: string[];
  user: { id: string };
};

type PagesRouteVisibilityCliDeps = {
  getSite?: typeof getPageSiteForProject;
  resolveRouteContext?: typeof resolvePagesPasswordRouteContext;
  updateRouteVisibility?: typeof updateAuthorizedPagesRouteVisibility;
};

export function cliHasPagesRouteVisibilityWriteScopes(scopes: readonly string[]) {
  return PAGES_ROUTE_VISIBILITY_CLI_WRITE_SCOPES.every((scope) => scopes.includes(scope));
}

export async function updatePagesRouteVisibilityFromCli(input: {
  body: unknown;
  projectRef: string;
  requestId: string;
  workspace: PagesRouteVisibilityCliWorkspace;
}, deps: PagesRouteVisibilityCliDeps = {}) {
  const parsed = parseVisibilityCliInput(input.body);
  const normalizedPath = validateRoutePath(parsed.path);
  if (!normalizedPath.ok) {
    throw new ConsoleApiError(400, { error: "invalid_path" });
  }

  const site = await (deps.getSite ?? getPageSiteForProject)({
    action: "write",
    projectRef: input.projectRef,
    siteRef: parsed.siteRef,
    workspace: input.workspace,
  });
  const context = await (deps.resolveRouteContext ?? resolvePagesPasswordRouteContext)(
    { host: site.defaultHostname, path: normalizedPath.path },
  );
  if (!context || context.site.id !== site.id || context.site.projectId !== site.projectId) {
    throw new ConsoleApiError(404, { error: "route_not_found" });
  }

  const visibility = await (deps.updateRouteVisibility ?? updateAuthorizedPagesRouteVisibility)({
    context: {
      actorId: input.workspace.user.id,
      actorType: "cli",
      membershipRole: input.workspace.membership.role,
      organizationId: input.workspace.organization.id,
      scopes: input.workspace.scopes,
    },
    reason: "cli_visibility_update",
    release: { id: context.release.id, number: context.release.releaseNumber },
    requestId: input.requestId,
    route: {
      bindingId: context.route.id,
      effectiveVisibility: context.effectiveVisibility,
      id: context.route.routeId,
      path: context.route.path,
      visibility: context.route.visibility,
    },
    site: {
      defaultVisibility: context.site.defaultVisibility,
      id: context.site.id,
      projectId: context.site.projectId,
    },
    visibility: parsed.visibility,
  });

  const route = visibility.route;
  return {
    changed: visibility.changed,
    path: route.path,
    projectRef: input.projectRef,
    release: visibility.release,
    route,
    site: {
      defaultHostname: context.site.defaultHostname,
      defaultVisibility: context.site.defaultVisibility,
      id: visibility.site.id,
      projectId: visibility.site.projectId,
    },
    siteRef: parsed.siteRef,
    url: new URL(route.path, `https://${context.site.defaultHostname}`).toString(),
  };
}

function parseVisibilityCliInput(input: unknown): PagesRouteVisibilityCliInput {
  const parsed = visibilityCliInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ConsoleApiError(400, {
    error: "validation_failed",
    fieldErrors: Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join(".") || "request", issue.message]),
    ),
  });
}
