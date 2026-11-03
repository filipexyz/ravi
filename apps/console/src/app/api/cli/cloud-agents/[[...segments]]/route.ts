import { type NextRequest, NextResponse } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { CLOUD_AGENTS_MAX_BODY_BYTES, handleCloudAgentsCliRequest } from "@/server/console/cloud-agents/cli";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";
export const maxDuration = 300;

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
        : await readJsonBody(request, requestId, { maxBytes: CLOUD_AGENTS_MAX_BODY_BYTES });
    const result = await handleCloudAgentsCliRequest({
      auth,
      requestId,
      method,
      segments,
      body,
      searchParams: request.nextUrl.searchParams,
    });
    if (result.kind === "bytes") {
      const headers = new Headers({
        "cache-control": "no-store",
        "content-type": result.contentType,
        "content-disposition": `attachment; filename="${result.name.replace(/["\\\r\n]/g, "_")}"`,
        "x-content-type-options": "nosniff",
      });
      if (result.size !== null) headers.set("content-length", String(result.size));
      return new NextResponse(result.body, { status: result.status, headers });
    }
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
