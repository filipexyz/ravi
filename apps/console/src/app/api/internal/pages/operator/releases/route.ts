import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  getPagesResolveControlToken,
  authorizePagesResolveRequest,
} from "@/server/console/pages/resolve";
import { pagesOperatorReleases, type PagesOperatorReleasesAction } from "@/server/console/pages/operator";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

type ReleasesBody = {
  action?: unknown;
  baseReleaseId?: unknown;
  file?: unknown;
  host?: unknown;
  matchType?: unknown;
  pagesSession?: unknown;
  path?: unknown;
  releaseId?: unknown;
  routePath?: unknown;
};

const ACTIONS: ReadonlySet<string> = new Set<PagesOperatorReleasesAction>(["list", "compare", "file_diff", "restore"]);

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages operator releases endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json(
      { status: "error", error: "control_token_not_configured" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }

  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-operator-releases-unauthorized"), limit: 30, windowMs: 60_000 })) {
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

  let body: ReleasesBody;
  try {
    body = (await request.json()) as ReleasesBody;
  } catch {
    return NextResponse.json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  const action = typeof body.action === "string" ? body.action : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const pagesSession = typeof body.pagesSession === "string" ? body.pagesSession.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!ACTIONS.has(action) || !host || !pagesSession || !path.startsWith("/")) {
    return NextResponse.json(
      { status: "error", error: "invalid_request" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  try {
    const result = await pagesOperatorReleases({
      action: action as PagesOperatorReleasesAction,
      baseReleaseId: typeof body.baseReleaseId === "string" ? body.baseReleaseId : body.baseReleaseId === null ? null : undefined,
      file: typeof body.file === "string" ? body.file : undefined,
      host,
      matchType: typeof body.matchType === "string" ? body.matchType : null,
      pagesSession,
      path,
      releaseId: typeof body.releaseId === "string" ? body.releaseId : undefined,
      requestId,
      routePath: typeof body.routePath === "string" ? body.routePath : undefined,
    });
    return NextResponse.json({ status: "ok", ...result }, { headers: noStoreHeaders(requestId) });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(
        { status: "error", ...error.payload },
        { status: error.status, headers: noStoreHeaders(requestId) },
      );
    }
    console.error("Ravi Pages operator releases request failed", { action, error, requestId });
    return NextResponse.json(
      { status: "error", error: "releases_request_failed" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }
}

function noStoreHeaders(requestId: string) {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
  };
}
