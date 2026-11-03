import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { routeCalendarRequest } from "@/server/console/calendar/routes";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import { ConsoleWorkspaceSelectionRequiredError, getConsoleWorkspace } from "@/server/console/workspace";

// The Console UI's envelope for calendar settings, upcoming meetings and the
// organization's auto-record rule: the same routes as `/api/cli/calendar`,
// signed in with the session cookie, plus `policy`.

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64_000;

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  if (method === "POST" && !isTrustedConsolePost(request)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const { segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: unknown = {};
  if (method !== "GET") {
    const raw = await request.text().catch(() => null);
    if (raw === null) return noStore(NextResponse.json({ error: "invalid_json" }, { status: 400 }));
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return noStore(NextResponse.json({ error: "payload_too_large" }, { status: 413 }));
    }
    try {
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return noStore(NextResponse.json({ error: "invalid_json" }, { status: 400 }));
    }
  }

  try {
    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    const result = await routeCalendarRequest({
      workspace: {
        user: { id: workspace.user.id },
        organization: { id: workspace.organization.id },
        membership: { role: workspace.membership.role },
      },
      envelope: "console",
      requestId,
      method,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
    });
    return noStore(NextResponse.json(result.payload, { status: result.status }));
  } catch (error) {
    if (error instanceof CliApiError) {
      return noStore(
        NextResponse.json(
          { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
          { status: error.status },
        ),
      );
    }
    if (error instanceof ConsoleApiError) return noStore(NextResponse.json(error.payload, { status: error.status }));
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return noStore(NextResponse.json({ error: error.code }, { status: 409 }));
    }
    console.error("Console calendar request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
