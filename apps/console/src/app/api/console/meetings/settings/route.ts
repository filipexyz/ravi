import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { getMeetingsSharingSettings, updateMeetingsSharingSettings } from "@/server/console/meetings/sharing";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError, getConsoleWorkspace } from "@/server/console/workspace";

// The organization's meetings sharing rule: whether agents logged into other
// organizations may read its meetings for people who can see them.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest) {
  return handle(request, "GET");
}

export function POST(request: NextRequest) {
  return handle(request, "POST");
}

async function handle(request: NextRequest, method: "GET" | "POST") {
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  if (method === "POST" && !isTrustedConsolePost(request)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  try {
    const consoleWorkspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    const workspace = {
      user: { id: consoleWorkspace.user.id },
      organization: { id: consoleWorkspace.organization.id },
      membership: { role: consoleWorkspace.membership.role },
    };
    if (method === "GET") return noStore(NextResponse.json(await getMeetingsSharingSettings(workspace)));
    const body = await request.json().catch(() => null);
    return noStore(NextResponse.json(await updateMeetingsSharingSettings({ body, requestId, workspace })));
  } catch (error) {
    if (error instanceof ConsoleApiError) return noStore(NextResponse.json(error.payload, { status: error.status }));
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return noStore(NextResponse.json({ error: error.code }, { status: 409 }));
    }
    console.error("Console meetings settings request failed", { error, requestId });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
