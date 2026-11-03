import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { createPagesClaimCode, resolvePagesReturnTargetForAuthStart } from "@/server/console/pages/auth";
import { ConsoleWorkspaceSelectionRequiredError, getConsoleWorkspace } from "@/server/console/workspace";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

const OPERATOR_CHECKED_QUERY_PARAM = "_ravi_operator_checked";

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  if (!returnTo) {
    return NextResponse.json({ error: "invalid_return_to" }, { status: 400 });
  }

  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  const target = await resolvePagesReturnTargetForAuthStart({ returnTo });
  if (!target) {
    return NextResponse.json(
      { error: "invalid_return_to" },
      { status: 400, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const fallback = operatorCheckedRedirect(returnTo, requestId);
  if (isRateLimited({ key: rateLimitKey(request, "pages-auth-optional"), limit: 120, windowMs: 60_000 })) {
    return fallback;
  }

  const auth = await getConsoleApiAuthState();
  if (!auth) return fallback;

  try {
    const workspace = await getConsoleWorkspace(auth, {
      organizationRef: target.organizationId,
    });
    const claim = await createPagesClaimCode({
      requestId,
      returnTo,
      workspace,
    });
    const response = NextResponse.redirect(claim.claimUrl);
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    if (error instanceof ConsoleApiError || error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return fallback;
    }
    console.error("Ravi Pages optional operator auth failed", { error, requestId });
    return fallback;
  }
}

function operatorCheckedRedirect(returnTo: string, requestId: string) {
  const url = new URL(returnTo);
  url.searchParams.set(OPERATOR_CHECKED_QUERY_PARAM, "1");
  const response = NextResponse.redirect(url.toString());
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-request-id", requestId);
  return response;
}
