import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { handleMeetingsCliRequest } from "@/server/console/meetings/cli";

type RouteContext = {
  params: Promise<{ projectRef: string; segments?: string[] }>;
};

export const runtime = "nodejs";
// Media downloads stream the whole file through this route.
export const maxDuration = 800;

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const requestId = requestIdFrom(request);
  const { projectRef, segments = [] } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body =
      method === "GET" || request.headers.get("content-length") === "0"
        ? {}
        : await readJsonBody(request, requestId, { maxBytes: 8_192 });
    const result = await handleMeetingsCliRequest({
      auth,
      requestId,
      method,
      projectRef,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
    });
    if (result.stream) {
      return new Response(result.stream.body, {
        status: result.status,
        headers: { ...result.stream.headers, "cache-control": "no-store" },
      });
    }
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
