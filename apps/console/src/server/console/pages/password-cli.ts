import { z } from "zod";

import type { ConsoleRole } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageSiteForProject } from "@/server/console/pages";
import {
  configureAuthorizedPagesPasswordPolicy,
  disableAuthorizedPagesPasswordPolicy,
  getAuthorizedPagesPasswordPolicyStatus,
  pagesPasswordAccessRepositoryForDb,
  resolvePagesPasswordRouteContext,
  type AuthorizedPagesPasswordPolicyContext,
  type PagesPasswordAccessRepository,
} from "@/server/console/pages/password-access";
import { updateAuthorizedPagesRouteVisibility } from "@/server/console/pages/operator";
import { validateRoutePath } from "@/server/console/pages/policy";

const passwordCliInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    password: z.string().max(512),
    path: z.string().min(1).max(2_048),
    siteRef: z.string().min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("status"),
    path: z.string().min(1).max(2_048),
    siteRef: z.string().min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("remove"),
    path: z.string().min(1).max(2_048),
    siteRef: z.string().min(1).max(200),
    visibility: z.enum(["public", "protected_link", "private"]),
  }).strict(),
]);

export type PagesPasswordCliInput = z.infer<typeof passwordCliInputSchema>;

export type PagesPasswordCliWorkspace = {
  membership: { role: ConsoleRole };
  mode: "workos";
  organization: { id: string };
  scopes: string[];
  user: { id: string };
};

type PagesPasswordCliDeps = {
  configurePolicy?: typeof configureAuthorizedPagesPasswordPolicy;
  disablePolicy?: typeof disableAuthorizedPagesPasswordPolicy;
  getPolicyStatus?: typeof getAuthorizedPagesPasswordPolicyStatus;
  getSite?: typeof getPageSiteForProject;
  passwordRepository?: PagesPasswordAccessRepository;
  resolveRouteContext?: typeof resolvePagesPasswordRouteContext;
  updateRouteVisibility?: typeof updateAuthorizedPagesRouteVisibility;
};

export async function managePagesPasswordFromCli(input: {
  body: unknown;
  projectRef: string;
  requestId: string;
  workspace: PagesPasswordCliWorkspace;
}, deps: PagesPasswordCliDeps = {}) {
  const parsed = parsePasswordCliInput(input.body);
  const normalizedPath = validateRoutePath(parsed.path);
  if (!normalizedPath.ok) {
    throw new ConsoleApiError(400, { error: "invalid_path" });
  }

  const site = await (deps.getSite ?? getPageSiteForProject)({
    action: parsed.action === "status" ? "read" : "write",
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

  const passwordRepository = deps.passwordRepository ?? pagesPasswordAccessRepositoryForDb();
  const policyContext: AuthorizedPagesPasswordPolicyContext = {
    ...context,
    actorId: input.workspace.user.id,
    actorType: "cli",
  };

  if (parsed.action === "status") {
    const status = await (deps.getPolicyStatus ?? getAuthorizedPagesPasswordPolicyStatus)(
      { context: policyContext, scope: "route" },
      passwordRepository,
    );
    return passwordProjection({
      action: parsed.action,
      configured: status.configured,
      context: policyContext,
      policy: status.policy,
      projectRef: input.projectRef,
      siteRef: parsed.siteRef,
    });
  }

  const updateVisibility = deps.updateRouteVisibility ?? updateAuthorizedPagesRouteVisibility;
  if (parsed.action === "set") {
    const policy = await (deps.configurePolicy ?? configureAuthorizedPagesPasswordPolicy)({
      context: policyContext,
      host: site.defaultHostname,
      password: parsed.password,
      requestId: input.requestId,
      scope: "route",
      source: "pages_password_cli",
    }, passwordRepository);
    const visibility = await updateVisibility({
      context: {
        actorId: input.workspace.user.id,
        actorType: "cli",
        membershipRole: input.workspace.membership.role,
        organizationId: input.workspace.organization.id,
        scopes: input.workspace.scopes,
      },
      reason: "cli_password_set",
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
      visibility: "password",
    }, { passwordRepository });
    return passwordProjection({
      action: parsed.action,
      configured: true,
      context: policyContext,
      policy,
      projectRef: input.projectRef,
      siteRef: parsed.siteRef,
      visibility,
    });
  }

  const visibility = await updateVisibility({
    context: {
      actorId: input.workspace.user.id,
      actorType: "cli",
      membershipRole: input.workspace.membership.role,
      organizationId: input.workspace.organization.id,
      scopes: input.workspace.scopes,
    },
    reason: "cli_password_remove",
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
  }, { passwordRepository });
  const disabled = await (deps.disablePolicy ?? disableAuthorizedPagesPasswordPolicy)({
    context: policyContext,
    host: site.defaultHostname,
    requestId: input.requestId,
    scope: "route",
    source: "pages_password_cli",
  }, passwordRepository);
  return passwordProjection({
    action: parsed.action,
    configured: false,
    context: policyContext,
    policy: disabled.policy,
    projectRef: input.projectRef,
    siteRef: parsed.siteRef,
    visibility,
  });
}

function parsePasswordCliInput(input: unknown): PagesPasswordCliInput {
  const parsed = passwordCliInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ConsoleApiError(400, {
    error: "validation_failed",
    fieldErrors: Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join(".") || "request", issue.message]),
    ),
  });
}

function passwordProjection(input: {
  action: PagesPasswordCliInput["action"];
  configured: boolean;
  context: AuthorizedPagesPasswordPolicyContext;
  policy: unknown;
  projectRef: string;
  siteRef: string;
  visibility?: Awaited<ReturnType<typeof updateAuthorizedPagesRouteVisibility>>;
}) {
  const route = input.visibility?.route ?? {
    bindingId: input.context.route.id,
    effectiveVisibility: input.context.effectiveVisibility,
    id: input.context.route.routeId,
    path: input.context.route.path,
    visibility: input.context.route.visibility,
  };
  const release = input.visibility?.release ?? {
    id: input.context.release.id,
    number: input.context.release.releaseNumber,
  };
  const path = route.path;
  return {
    action: input.action,
    configured: input.configured,
    path,
    policy: input.policy,
    projectRef: input.projectRef,
    release,
    route,
    scope: "route" as const,
    site: {
      defaultHostname: input.context.site.defaultHostname,
      id: input.context.site.id,
      projectId: input.context.site.projectId,
    },
    siteRef: input.siteRef,
    url: new URL(path, `https://${input.context.site.defaultHostname}`).toString(),
  };
}
