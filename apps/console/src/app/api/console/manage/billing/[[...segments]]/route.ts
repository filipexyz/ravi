import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { routeManageBillingRequest } from "@/server/console/billing/manage";
import { noStore, readBillingJson } from "@/server/console/billing/route-body";
import { requirePlatformOperatorApi } from "@/server/console/manage-page";

// Platform operator billing (console/billing/contracts): clients, contracts,
// installations and invoices across organizations.

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

type Method = "GET" | "POST" | "DELETE";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

export function DELETE(request: NextRequest, context: RouteContext) {
  return handle(request, context, "DELETE");
}

async function handle(request: NextRequest, context: RouteContext, method: Method) {
  const { segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  try {
    // Only an operator gets its body read.
    const operator = await requirePlatformOperatorApi(auth);
    const body = method === "POST" ? await readBillingJson(request) : {};
    if (body instanceof NextResponse) return noStore(body);
    const payload = await routeManageBillingRequest({
      method,
      segments,
      searchParams: request.nextUrl.searchParams,
      body,
      operatorId: operator.id,
      requestId,
    });
    return noStore(NextResponse.json(payload));
  } catch (error) {
    if (error instanceof ConsoleApiError) return noStore(NextResponse.json(error.payload, { status: error.status }));
    console.error("Manage billing request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}
