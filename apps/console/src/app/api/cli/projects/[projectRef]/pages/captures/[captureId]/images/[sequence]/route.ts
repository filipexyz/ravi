import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageCaptureImage } from "@/server/console/pages/captures";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = { params: Promise<{ projectRef: string; captureId: string; sequence: string }> };

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef, captureId, sequence: rawSequence } = await context.params;
  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read") || !auth.scopes.includes("artifacts.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }
    const role = parseConsoleRole(auth.membership.role);
    const sequence = Number(rawSequence);
    if (!role || !Number.isInteger(sequence) || sequence < 0) {
      return cliFailure(cliApiError(400, "PAYLOAD_INVALID"), requestId);
    }
    const result = await getPageCaptureImage({
      captureId,
      projectRef,
      sequence,
      workspace: { authorization: projectAuthorizationFromCli(auth),
        mode: "workos",
        user: { id: auth.user.id },
        organization: { id: auth.organization.id },
        membership: { role },
      },
    });
    const headers = new Headers({
      "cache-control": "private, max-age=300",
      "content-type": result.asset.mimeType ?? result.image.mimeType,
      "content-disposition": `inline; filename="${safeFilename(result.asset.path)}"`,
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    });
    if (result.asset.sizeBytes) headers.set("content-length", String(result.asset.sizeBytes));
    return new Response(result.response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(
        cliApiError(error.status === 404 ? 404 : 503, error.status === 404 ? "PROJECT_ACCESS_DENIED" : "SERVER_UNAVAILABLE"),
        requestId,
      );
    }
    return cliFailure(error, requestId);
  }
}

function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "capture.jpg";
}
