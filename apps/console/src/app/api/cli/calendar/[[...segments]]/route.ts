import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { handleCalendarCliRequest } from "@/server/console/calendar/routes";

// The local Ravi's view of the person's synced calendar (spec `console/calendar`).

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        : await readJsonBody(request, requestId, { maxBytes: 64_000 });
    const result = await handleCalendarCliRequest({
      auth,
      requestId,
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
