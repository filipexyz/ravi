import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { basesCliActorOptions, basesCliError, handleBasesCliRequest } from "@/server/console/bases";
import { BASES_LIMITS } from "@/shared/bases/limits";

type RouteContext = {
  params: Promise<{ projectRef: string; segments?: string[] }>;
};

export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

export function PATCH(request: NextRequest, context: RouteContext) {
  return handle(request, context, "PATCH");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST" | "PATCH") {
  const requestId = requestIdFrom(request);
  const { projectRef, segments = [] } = await context.params;

  try {
    // Queries are POSTs that only read; a delegated person who is not linked is
    // refused on reads too, never served as the operator.
    const auth = await authenticateCliRequest(request, requestId, basesCliActorOptions(method, segments));
    const body =
      method === "GET" || request.headers.get("content-length") === "0"
        ? {}
        : await readJsonBody(request, requestId, { maxBytes: BASES_LIMITS.requestBodyBytes });
    const result = await handleBasesCliRequest({
      auth,
      requestId,
      method,
      projectRef,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
      idempotencyKey: request.headers.get("idempotency-key"),
    });
    return cliSuccess(result.payload, { status: result.status });
  } catch (error) {
    if (error instanceof ConsoleApiError) return cliFailure(basesCliError(error), requestId);
    return cliFailure(error, requestId);
  }
}
