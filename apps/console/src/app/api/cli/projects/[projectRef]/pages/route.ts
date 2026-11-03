import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { createPageSite, listPageSitesForProject, updatePageSite } from "@/server/console/pages";
import { pageSiteCliError } from "@/server/console/pages/cli-errors";
import { repairActiveSiteEdgeManifest } from "@/server/console/pages/publish";
import { withPageCustomDomains } from "@/server/console/read-model";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const workspace = workspaceFromCliAuth(auth);
    const sites = await listPageSitesForProject({ projectRef, workspace });
    return cliSuccess(await withPageCustomDomains(workspace.organization.id, sites));
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pageSiteCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.link")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    return cliSuccess(
      await createPageSite({
        input: await readJsonBody(request, requestId),
        projectRef,
        requestId,
        workspace: workspaceFromCliAuth(auth),
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pageSiteCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.link")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const workspace = workspaceFromCliAuth(auth);
    const site = await updatePageSite({
      input: await readJsonBody(request, requestId),
      projectRef,
      requestId,
      workspace,
    });
    const edgeManifestRepair = await repairActiveSiteEdgeManifest({
      organizationId: workspace.organization.id,
      reason: "site_visibility_changed",
      requestId,
      siteRef: site.id,
    });

    return cliSuccess({ site, edgeManifestRepair });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pageSiteCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos" as const,
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}
