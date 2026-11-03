import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { LIBRARY_MAX_BODY_BYTES, libraryOrigin, routeLibraryRequest } from "@/server/console/library/cli";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";

// The Console UI's envelope for the Library: the same routes as
// `/api/cli/library`, signed in with the session cookie.

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const { segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  let body: unknown = {};
  if (method === "POST") {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > LIBRARY_MAX_BODY_BYTES) {
      return noStore(NextResponse.json({ error: "PAYLOAD_TOO_LARGE", message: "The request is too large." }, { status: 413 }));
    }
    const text = await request.text();
    if (text.length > LIBRARY_MAX_BODY_BYTES) {
      return noStore(NextResponse.json({ error: "PAYLOAD_TOO_LARGE", message: "The request is too large." }, { status: 413 }));
    }
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return noStore(NextResponse.json({ error: "PAYLOAD_INVALID", message: "The request body is not JSON." }, { status: 400 }));
    }
  }

  try {
    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    await assertConsoleFeatureAccess(workspace, "console.library");
    const result = await routeLibraryRequest({
      workspace: {
        user: { id: workspace.user.id },
        organization: { id: workspace.organization.id, slug: workspace.organization.slug },
        membership: { role: workspace.membership.role },
      },
      actor: { surface: "console", requestId, localInstallationId: null, origin: libraryOrigin(request.url) },
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
    console.error("Console library request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
