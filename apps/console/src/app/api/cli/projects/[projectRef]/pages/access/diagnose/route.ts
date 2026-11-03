import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { diagnosePagesAccess } from "@/server/console/pages/access-diagnose";
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
    if (!auth.scopes.includes("console.projects.read") || !auth.scopes.includes("console.control.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const searchParams = request.nextUrl.searchParams;
    const targetUrl = searchParams.get("url");
    const userRef = searchParams.get("user") ?? searchParams.get("email");
    if (!targetUrl?.trim() || !userRef?.trim()) {
      return cliFailure(
        cliApiError(400, "PAYLOAD_INVALID", "Provide url and user query parameters."),
        requestId,
      );
    }

    return cliSuccess(
      await diagnosePagesAccess({
        input: {
          path: searchParams.get("path"),
          projectRef,
          targetUrl,
          userRef,
          workspace: workspaceFromCliAuth(auth),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
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
    organization: { id: auth.organization.id },
    user: { id: auth.user.id },
    membership: { role },
  };
}
