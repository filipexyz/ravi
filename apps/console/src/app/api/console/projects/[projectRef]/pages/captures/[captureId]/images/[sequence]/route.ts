import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageCaptureImage } from "@/server/console/pages/captures";
import { getSelectedConsoleWorkspace, requestOrganizationRef } from "@/server/console/request-workspace";

type RouteContext = { params: Promise<{ projectRef: string; captureId: string; sequence: string }> };

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = randomUUID();
  const { projectRef, captureId, sequence: rawSequence } = await context.params;
  try {
    const auth = await getConsoleAuthState();
    if (!auth) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    // Images load without headers, so the page sends its organization as `?org=`.
    const workspace = await getSelectedConsoleWorkspace(auth, { organizationRef: requestOrganizationRef(request) });
    const sequence = Number(rawSequence);
    if (!Number.isInteger(sequence) || sequence < 0) {
      return NextResponse.json({ error: "invalid_sequence" }, { status: 400 });
    }
    const result = await getPageCaptureImage({ captureId, projectRef, sequence, workspace });
    const headers = new Headers({
      // A capture id never changes its image. An hour keeps the list fast in one sitting while access is still re-checked often.
      "cache-control": "private, max-age=3600",
      "content-type": result.asset.mimeType ?? result.image.mimeType,
      "content-disposition": `inline; filename="${safeFilename(result.asset.path)}"`,
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    });
    if (result.asset.sizeBytes) headers.set("content-length", String(result.asset.sizeBytes));
    return new Response(result.response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status, headers: { "x-request-id": requestId } });
    }
    return NextResponse.json({ error: "capture_image_unavailable" }, { status: 503, headers: { "x-request-id": requestId } });
  }
}

function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "capture.jpg";
}
