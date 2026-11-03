import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { routeMeetingSharingRequest, routeMeetingsRequest } from "@/server/console/meetings/cli";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";

// The Console UI's envelope for cloud meeting bots: the same routes as
// `/api/cli/projects/<p>/meetings`, signed in with the session cookie, plus
// `meetings/<id>/access[/share|/unshare]` to give people one meeting.

type RouteContext = {
  params: Promise<{ projectRef: string; segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Media plays through this route.
export const maxDuration = 800;

const MAX_BODY_BYTES = 8_192;

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  // A cookie-signed write (send a bot, leave, delete a transcript, settings) must come from the Console itself.
  if (method === "POST" && !isTrustedConsolePost(request)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const { projectRef, segments = [] } = await context.params;
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
    await assertConsoleFeatureAccess(workspace, "console.meetings");
    const meetingsWorkspace = {
      user: { id: workspace.user.id },
      organization: { id: workspace.organization.id },
      membership: { role: workspace.membership.role },
    };
    const sharing = await routeMeetingSharingRequest({
      workspace: meetingsWorkspace,
      requestId,
      method,
      projectRef,
      segments,
      body,
      origin: request.nextUrl.origin,
    });
    if (sharing) return noStore(NextResponse.json(sharing.payload, { status: sharing.status }));
    const result = await routeMeetingsRequest({
      workspace: meetingsWorkspace,
      envelope: "console",
      localInstallationId: null,
      mediaBasePath: `/api/console/projects/${encodeURIComponent(projectRef)}/meetings`,
      requestId,
      method,
      projectRef,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
      range: request.headers.get("range"),
    });
    if (result.stream) {
      return noStore(new Response(result.stream.body, { status: result.status, headers: result.stream.headers }));
    }
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
    console.error("Console meetings request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
