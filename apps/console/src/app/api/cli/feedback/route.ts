import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { submitConsoleFeedback } from "@/server/console/feedback";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const payload = await submitConsoleFeedback({
      body: await readJsonBody(request, requestId, { maxBytes: 16 * 1024 }),
      defaultSource: "cli",
      requestId,
      workspace: workspaceFromCliAuth(auth),
    });
    return cliSuccess(payload, { status: 201 });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(feedbackCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "ORG_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos" as const,
    user: auth.user,
    organization: auth.organization,
    membership: { ...auth.membership, role },
  };
}

function feedbackCliError(error: ConsoleApiError) {
  if (
    error.payload.error === "validation_failed" ||
    error.payload.error === "payload_too_large" ||
    error.payload.error === "invalid_request"
  ) {
    return cliApiError(400, "PAYLOAD_INVALID");
  }
  if (error.payload.error === "project_forbidden" || error.payload.error === "forbidden") {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE");
}
