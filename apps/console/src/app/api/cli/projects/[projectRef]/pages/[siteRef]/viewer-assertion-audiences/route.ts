import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  audienceFromCliRemoveRequest,
  cliHasViewerAssertionAudienceReadScope,
  cliHasViewerAssertionAudienceWriteScope,
  listViewerAssertionAudiencesFromCli,
  removeViewerAssertionAudienceFromCli,
  setViewerAssertionAudienceFromCli,
  viewerAssertionAudienceCliError,
  type ViewerAssertionAudienceCliDeps,
  type ViewerAssertionCliWorkspace,
} from "@/server/console/pages/viewer-assertions/cli";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string; siteRef: string }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  return handleViewerAssertionAudiencesCli(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return handleViewerAssertionAudiencesCli(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return handleViewerAssertionAudiencesCli(request, context);
}

export async function handleViewerAssertionAudiencesCli(
  request: NextRequest,
  context: RouteContext,
  deps: ViewerAssertionAudienceCliDeps & {
    authenticate?: typeof authenticateCliRequest;
  } = {},
) {
  const requestId = requestIdFrom(request);
  const { projectRef, siteRef } = await context.params;

  try {
    const auth = await (deps.authenticate ?? authenticateCliRequest)(request, requestId, { actor: "executor" });
    const method = request.method.toUpperCase();
    if (method === "GET" && !cliHasViewerAssertionAudienceReadScope(auth.scopes)) {
      return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    }
    if (method !== "GET" && !cliHasViewerAssertionAudienceWriteScope(auth.scopes)) {
      return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    }

    const workspace = workspaceFromCliAuth(auth);
    if (method === "GET") {
      return cliSuccess(
        await listViewerAssertionAudiencesFromCli({ projectRef, siteRef, workspace }, deps),
        { headers: { "cache-control": "no-store", "x-request-id": requestId } },
      );
    }
    if (method === "PUT") {
      return cliSuccess(
        await setViewerAssertionAudienceFromCli({
          body: await readJsonBody(request, requestId, { maxBytes: 4_096 }),
          projectRef,
          requestId,
          siteRef,
          workspace,
        }, deps),
        { headers: { "cache-control": "no-store", "x-request-id": requestId } },
      );
    }
    if (method === "DELETE") {
      return cliSuccess(
        await removeViewerAssertionAudienceFromCli({
          audience: audienceFromCliRemoveRequest(request, await readOptionalJsonBody(request, requestId)),
          projectRef,
          requestId,
          siteRef,
          workspace,
        }, deps),
        { headers: { "cache-control": "no-store", "x-request-id": requestId } },
      );
    }

    return noStore(cliFailure(cliApiError(400, "PAYLOAD_INVALID"), requestId));
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return noStore(cliFailure(viewerAssertionAudienceCliError(error), requestId));
    }
    return noStore(cliFailure(error, requestId));
  }
}

function noStore<T extends Response>(response: T) {
  response.headers.set("cache-control", "no-store");
  return response;
}

async function readOptionalJsonBody(request: Request, requestId: string) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;
  return readJsonBody(request, requestId, { maxBytes: 4_096 });
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>): ViewerAssertionCliWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos",
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}
