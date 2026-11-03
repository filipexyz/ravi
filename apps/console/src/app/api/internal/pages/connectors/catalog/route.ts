import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import { getPagesConnectorCatalog } from "@/server/console/pages/connectors/host";
import {
  authorizePagesResolveRequest,
  getPagesResolveControlToken,
} from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

type CatalogBody = {
  auth?: unknown;
  class?: unknown;
  executable?: unknown;
  host?: unknown;
  ids?: unknown;
  pagesSession?: unknown;
  q?: unknown;
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages connector catalog endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json(
      { error: "connector_unavailable" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }

  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-connectors-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json(
        { error: "connector_rate_limited" },
        { status: 429, headers: noStoreHeaders(requestId) },
      );
    }
    return NextResponse.json(
      { error: "connector_unauthorized" },
      { status: 401, headers: noStoreHeaders(requestId) },
    );
  }

  let body: CatalogBody;
  try {
    body = (await request.json()) as CatalogBody;
  } catch {
    return NextResponse.json(
      { error: "payload_invalid" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (!host) {
    return NextResponse.json(
      { error: "payload_invalid" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  try {
    const result = await getPagesConnectorCatalog({
      host,
      pagesSession: typeof body.pagesSession === "string" ? body.pagesSession : null,
      query: {
        auth: typeof body.auth === "string" ? body.auth : null,
        class: typeof body.class === "string" ? body.class : null,
        executable: typeof body.executable === "string" ? body.executable : null,
        ids: typeof body.ids === "string" ? body.ids : null,
        q: typeof body.q === "string" ? body.q : null,
      },
      requestId,
    });
    return NextResponse.json(result, { headers: noStoreHeaders(requestId) });
  } catch (error) {
    return connectorErrorResponse(error, requestId);
  }
}

function connectorErrorResponse(error: unknown, requestId: string) {
  if (error instanceof ConsoleApiError) {
    return NextResponse.json(
      { error: error.payload.error },
      { status: error.status, headers: noStoreHeaders(requestId) },
    );
  }
  console.error("Ravi Pages connector catalog request failed", { error, requestId });
  return NextResponse.json(
    { error: "connector_unavailable" },
    { status: 503, headers: noStoreHeaders(requestId) },
  );
}

function noStoreHeaders(requestId: string) {
  return {
    "cache-control": "private, no-store",
    "x-request-id": requestId,
  };
}
