import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { pagePasswordCliError } from "@/server/console/pages/cli-errors";
import { managePagesPasswordFromCli } from "@/server/console/pages/password-cli";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string }>;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body = await readJsonBody(request, requestId, { maxBytes: 2_048 });
    const action = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).action
      : null;
    const requiredScopes = action === "status"
      ? ["console.projects.read"]
      : ["console.projects.link", "artifacts.publish"];
    if (requiredScopes.some((scope) => !auth.scopes.includes(scope))) {
      return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    }

    return cliSuccess(
      await managePagesPasswordFromCli({
        body,
        projectRef,
        requestId,
        workspace: workspaceFromCliAuth(auth),
      }),
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return noStore(cliFailure(pagePasswordCliError(error), requestId));
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
