import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageCapture } from "@/server/console/pages/captures";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = { params: Promise<{ projectRef: string; captureId: string }> };

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef, captureId } = await context.params;
  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read") || !auth.scopes.includes("artifacts.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }
    const role = parseConsoleRole(auth.membership.role);
    if (!role) return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    const capture = await getPageCapture({
      captureId,
      projectRef,
      workspace: { authorization: projectAuthorizationFromCli(auth),
        mode: "workos",
        user: { id: auth.user.id },
        organization: { id: auth.organization.id },
        membership: { role },
      },
    });
    return cliSuccess({ capture, projectRef });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(cliApiError(error.status === 404 ? 404 : 403, "PROJECT_ACCESS_DENIED"), requestId);
    }
    return cliFailure(error, requestId);
  }
}
