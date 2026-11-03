import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { handleLibraryCliRequest, LIBRARY_MAX_BODY_BYTES, libraryOrigin } from "@/server/console/library/cli";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const requestId = requestIdFrom(request);
  const { segments = [] } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body =
      method === "GET" || request.headers.get("content-length") === "0"
        ? {}
        : await readJsonBody(request, requestId, { maxBytes: LIBRARY_MAX_BODY_BYTES });
    const result = await handleLibraryCliRequest({
      auth,
      requestId,
      origin: libraryOrigin(request.url),
      method,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
    });
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
