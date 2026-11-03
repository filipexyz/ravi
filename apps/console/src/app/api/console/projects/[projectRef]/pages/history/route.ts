import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { listPageHistory } from "@/server/console/pages/history";
import { getSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

type RouteContext = { params: Promise<{ projectRef: string }> };

export const runtime = "nodejs";

/**
 * A host's release history with what each release changed:
 * `?siteId=<host>` for the host, plus `&routeId=<page>` for one page.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = randomUUID();
  const { projectRef } = await context.params;
  try {
    const auth = await getConsoleApiAuthState();
    if (!auth) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const workspace = await getSelectedConsoleWorkspace(auth);
    await assertConsoleFeatureAccess(workspace, "console.pages");
    const params = request.nextUrl.searchParams;
    const result = await listPageHistory({
      projectRef,
      query: {
        siteId: params.get("siteId") ?? undefined,
        routeId: params.get("routeId") ?? undefined,
      },
      workspace,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status, headers: { "x-request-id": requestId } });
    }
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409, headers: { "x-request-id": requestId } });
    }
    console.error("Ravi Pages history read failed", { requestId, error: String(error) });
    return NextResponse.json({ error: "history_read_failed" }, { status: 500, headers: { "x-request-id": requestId } });
  }
}
