import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import { execPagesConnector, pagesConnectorExecErrorBody } from "@/server/console/pages/connectors/host";
import {
  authorizePagesResolveRequest,
  getPagesResolveControlToken,
} from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

type ExecBody = {
  host?: unknown;
  id?: unknown;
  input?: unknown;
  origin?: unknown;
  pagesSession?: unknown;
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages connector exec endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
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

  let body: ExecBody;
  try {
    body = (await request.json()) as ExecBody;
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
    const result = await execPagesConnector({
      host,
      id: body.id,
      input: body.input,
      origin: typeof body.origin === "string" ? body.origin : null,
      pagesSession: typeof body.pagesSession === "string" ? body.pagesSession : null,
      requestId,
    });
    return NextResponse.json(result, { headers: noStoreHeaders(requestId) });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      // `{ error }`; `ravi.bases.*` errors may add `fieldErrors` or `current`.
      return NextResponse.json(pagesConnectorExecErrorBody(error), {
        status: error.status,
        headers: noStoreHeaders(requestId),
      });
    }
    console.error("Ravi Pages connector exec request failed", { error, requestId });
    return NextResponse.json(
      { error: "connector_unavailable" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }
}

function noStoreHeaders(requestId: string) {
  return {
    "cache-control": "private, no-store",
    "x-request-id": requestId,
  };
}
