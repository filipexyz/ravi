import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  getPagesResolveControlToken,
  authorizePagesResolveRequest,
} from "@/server/console/pages/resolve";
import { updatePagesOperatorRouteVisibility } from "@/server/console/pages/operator";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages operator visibility endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json(
      { status: "error", error: "control_token_not_configured" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }

  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-operator-visibility-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json(
        { status: "error", error: "rate_limited" },
        { status: 429, headers: noStoreHeaders(requestId) },
      );
    }
    return NextResponse.json(
      { status: "error", error: "unauthorized" },
      { status: 401, headers: noStoreHeaders(requestId) },
    );
  }

  let body: {
    host?: unknown;
    pagesSession?: unknown;
    path?: unknown;
    visibility?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const pagesSession = typeof body.pagesSession === "string" ? body.pagesSession.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const visibility = typeof body.visibility === "string" ? body.visibility : "";
  if (!host || !pagesSession || !path.startsWith("/") || !isPageVisibility(visibility)) {
    return NextResponse.json(
      { status: "error", error: "invalid_request" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  try {
    const result = await updatePagesOperatorRouteVisibility({
      host,
      pagesSession,
      path,
      requestId,
      visibility,
    });
    return NextResponse.json({ status: "ok", ...result }, { headers: noStoreHeaders(requestId) });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(
        { status: "error", ...error.payload },
        { status: error.status, headers: noStoreHeaders(requestId) },
      );
    }
    console.error("Ravi Pages operator visibility update failed", { error, requestId });
    return NextResponse.json(
      { status: "error", error: "visibility_update_failed" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }
}

function isPageVisibility(value: string): value is "public" | "private" | "protected_link" | "password" {
  return value === "public" || value === "private" || value === "protected_link" || value === "password";
}

function noStoreHeaders(requestId: string) {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
  };
}
