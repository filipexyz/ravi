import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { createPageCapture } from "@/server/console/pages/captures";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = { params: Promise<{ projectRef: string }> };

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.link") || !auth.scopes.includes("artifacts.publish")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }
    const input = await readJsonBody(request, requestId, { maxBytes: 16_384 });
    const capture = await createPageCapture({
      input,
      projectRef,
      requestId,
      workspace: workspaceFromCliAuth(auth),
    });
    return cliSuccess({ capture, projectRef });
  } catch (error) {
    return cliFailure(mapCaptureError(error), requestId);
  }
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos" as const,
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}

function mapCaptureError(error: unknown) {
  if (!(error instanceof ConsoleApiError)) return error;
  if (
    error.payload.error === "validation_failed" ||
    error.payload.error === "invalid_path" ||
    error.payload.error === "capture_mode_not_supported" ||
    error.payload.error === "capture_idempotency_conflict"
  ) {
    return cliApiError(400, "PAYLOAD_INVALID", captureMessage(error));
  }
  if (
    error.payload.error === "project_not_found" ||
    error.payload.error === "page_not_found" ||
    error.payload.error === "project_forbidden"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE", captureMessage(error));
}

function captureMessage(error: ConsoleApiError) {
  if (error.payload.error === "capture_mode_not_supported") {
    return "Only thumbnail capture is available now. Use mode=thumbnail.";
  }
  if (error.payload.error === "page_capture_failed") {
    const code = error.payload.fieldErrors?.code;
    return `Page capture failed${code ? `: ${code}` : ""}.`;
  }
  return "The Pages capture request is invalid.";
}
