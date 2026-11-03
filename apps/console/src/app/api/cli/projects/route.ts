import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { createProject } from "@/server/console/projects";
import { listProjects } from "@/server/console/read-model";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    return cliSuccess(await listProjects(workspaceFromCliAuth(auth)));
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.link")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    return cliSuccess(
      await createProject({
        body: await readJsonBody(request, requestId),
        requestId,
        workspace: workspaceFromCliAuth(auth),
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(projectCliError(error), requestId);
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
    user: auth.user,
    organization: auth.organization,
    membership: { ...auth.membership, role },
  };
}

function projectCliError(error: ConsoleApiError) {
  if (
    error.payload.error === "invalid_request" ||
    error.payload.error === "validation_failed" ||
    error.payload.error === "slug_unavailable"
  ) {
    return cliApiError(400, "PAYLOAD_INVALID");
  }
  if (error.status === 403) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE");
}
