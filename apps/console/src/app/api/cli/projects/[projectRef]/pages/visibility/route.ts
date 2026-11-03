import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { pageRouteVisibilityCliError } from "@/server/console/pages/cli-errors";
import {
  cliHasPagesRouteVisibilityWriteScopes,
  updatePagesRouteVisibilityFromCli,
} from "@/server/console/pages/visibility-cli";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string }>;
};

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!cliHasPagesRouteVisibilityWriteScopes(auth.scopes)) {
      return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    }

    return cliSuccess(
      await updatePagesRouteVisibilityFromCli({
        body: await readJsonBody(request, requestId, { maxBytes: 2_048 }),
        projectRef,
        requestId,
        workspace: workspaceFromCliAuth(auth),
      }),
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return noStore(cliFailure(pageRouteVisibilityCliError(error), requestId));
    }
    return noStore(cliFailure(error, requestId));
  }
}

function noStore<T extends Response>(response: T) {
  response.headers.set("cache-control", "no-store");
  return response;
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
    scopes: auth.scopes,
  };
}
