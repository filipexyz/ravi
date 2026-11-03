import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { handleAccessCliRequest } from "@/server/console/access/cli";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";

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
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const body = method === "GET" ? {} : await readJsonBody(request, requestId, { maxBytes: 16_384 });
    const result = await handleAccessCliRequest({
      auth,
      body,
      method,
      origin: raviLinkConsoleOrigin(request.url),
      requestId,
      segments,
    });
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
