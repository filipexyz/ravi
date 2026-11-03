import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { CLOUD_AGENTS_CONSOLE_MAX_BODY_BYTES, routeCloudAgentsConsoleRequest } from "@/server/console/cloud-agents/console";
import { cloudContextForWorkspace } from "@/server/console/cloud-agents/service";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";

// The Console UI's envelope for cloud agents: the same routes as
// `/api/cli/cloud-agents`, signed in with the session cookie, plus the reads
// only the screens need (see `cloud-agents/console.ts`). Output downloads
// stream through here; a provider URL never reaches the browser.

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  // A cookie-signed write (key, deploy, run, approve, stop, schedules) must come from the Console itself.
  if (method === "POST" && !isTrustedConsolePost(request)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const { segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  let body: unknown = {};
  if (method === "POST") {
    const raw = await request.text().catch(() => null);
    if (raw === null) return noStore(NextResponse.json({ error: "invalid_json" }, { status: 400 }));
    if (new TextEncoder().encode(raw).byteLength > CLOUD_AGENTS_CONSOLE_MAX_BODY_BYTES) {
      return noStore(NextResponse.json({ error: "payload_too_large", message: "The request is too large." }, { status: 413 }));
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
    await assertConsoleFeatureAccess(workspace, "console.cloud_agents");
    const result = await routeCloudAgentsConsoleRequest(
      cloudContextForWorkspace(workspace, requestId),
      method,
      segments,
      body,
      request.nextUrl.searchParams,
    );
    if (result.kind === "bytes") {
      const headers = new Headers({
        "content-type": result.contentType,
        "content-disposition": `attachment; filename="${result.name.replace(/["\\\r\n]/g, "_")}"`,
        "x-content-type-options": "nosniff",
      });
      if (result.size !== null) headers.set("content-length", String(result.size));
      return noStore(new NextResponse(result.body, { status: result.status, headers }));
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
    console.error("Console cloud agents request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
