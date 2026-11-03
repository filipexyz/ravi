import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { isConsoleMutationOrigin } from "@/lib/auth/console-origin";
import { setConsoleOrganizationCookie } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError, getConsoleWorkspace } from "@/server/console/workspace";

export const runtime = "nodejs";

/**
 * Remembers the organization a `/<org>` page opened, for screens and old links
 * that name no organization. It only stores an organization the reader is an
 * active member of, and changes nothing else.
 */
export async function POST(request: NextRequest) {
  if (!isConsoleMutationOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const auth = await getConsoleApiAuthState();
  if (!auth) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { organizationId?: unknown } | null;
  const organizationRef = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";
  if (!organizationRef) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef });
    const response = new NextResponse(null, { status: 204 });
    setConsoleOrganizationCookie(response, workspace.organization.id);
    return response;
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw error;
  }
}
