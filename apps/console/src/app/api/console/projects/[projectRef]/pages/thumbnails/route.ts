import { randomUUID } from "node:crypto";
import { after, type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { requestPageThumbnails } from "@/server/console/pages/thumbnails";
import { getSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

type RouteContext = { params: Promise<{ projectRef: string }> };

export const runtime = "nodejs";
// Captures run after the response; a few at once, each a few seconds.
export const maxDuration = 120;

/**
 * Starts thumbnail captures for pages that have none of the content they serve
 * now. The Pages screen calls it for the pages it shows, for people who can
 * publish to the project; the result says which pages are ready, pending or failed.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = randomUUID();
  const { projectRef } = await context.params;
  try {
    const auth = await getConsoleApiAuthState();
    if (!auth) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const workspace = await getSelectedConsoleWorkspace(auth);
    await assertConsoleFeatureAccess(workspace, "console.pages");
    let input: unknown;
    try {
      const raw = await request.text();
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return NextResponse.json({ error: "validation_failed" }, { status: 400, headers: { "x-request-id": requestId } });
    }
    const result = await requestPageThumbnails({
      input,
      projectRef,
      requestId,
      schedule: (task) => after(task),
      workspace,
    });
    return NextResponse.json(result, {
      status: result.items.some((item) => item.state === "pending") ? 202 : 200,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status, headers: { "x-request-id": requestId } });
    }
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409, headers: { "x-request-id": requestId } });
    }
    console.error("Ravi Pages thumbnail request failed", { requestId, error: String(error) });
    return NextResponse.json({ error: "thumbnail_request_failed" }, { status: 500, headers: { "x-request-id": requestId } });
  }
}
