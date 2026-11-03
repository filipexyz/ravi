import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { routeOrgBillingRequest } from "@/server/console/billing/org-billing";
import { noStore, readBillingJson } from "@/server/console/billing/route-body";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";

// The selected organization's billing (console/billing/contracts): this
// month, billing details, issued invoices with how to pay them.

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, "GET");
}

export function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context, "POST");
}

async function handle(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const { segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  try {
    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: requestOrganizationRef(request),
    });
    await assertConsoleFeatureAccess(workspace, "console.billing");
    const body = method === "POST" ? await readBillingJson(request) : {};
    if (body instanceof NextResponse) return noStore(body);
    const payload = await routeOrgBillingRequest({ method, segments, body, workspace, requestId });
    return noStore(NextResponse.json(payload));
  } catch (error) {
    if (error instanceof ConsoleApiError) return noStore(NextResponse.json(error.payload, { status: error.status }));
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return noStore(NextResponse.json({ error: error.code }, { status: 409 }));
    }
    console.error("Organization billing request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}
