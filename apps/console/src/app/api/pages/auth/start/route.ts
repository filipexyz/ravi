import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  createPagesClaimCode,
  createPagesGuestClaimCode,
  resolvePagesReturnTargetForAuthStart,
} from "@/server/console/pages/auth";
import {
  pagesAuthStartErrorFromUnknown,
  pagesAuthStartErrorResponse,
} from "@/server/console/pages/auth-start";
import { pagesGuestCanViewPath } from "@/server/console/pages/resolve";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleUserFromAuth,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

type PagesAuthStartDeps = {
  createClaimCode?: typeof createPagesClaimCode;
  createGuestClaimCode?: (input: {
    requestId: string;
    returnTo: string;
    userId: string;
  }) => ReturnType<typeof createPagesGuestClaimCode>;
  getAuthState?: typeof getConsoleAuthState;
  getUser?: typeof getConsoleUserFromAuth;
  getWorkspace?: typeof getConsoleWorkspace;
  rateLimited?: typeof isRateLimited;
  resolveTarget?: typeof resolvePagesReturnTargetForAuthStart;
};

export async function GET(request: NextRequest) {
  return handlePagesAuthStartGet(request);
}

export async function handlePagesAuthStartGet(request: NextRequest, deps: PagesAuthStartDeps = {}) {
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const createClaimCode = deps.createClaimCode ?? createPagesClaimCode;
  const createGuestClaimCode =
    deps.createGuestClaimCode ??
    ((input: { requestId: string; returnTo: string; userId: string }) =>
      createPagesGuestClaimCode({ ...input, canViewPath: (pathInput) => pagesGuestCanViewPath(pathInput) }));
  const getAuthState = deps.getAuthState ?? getConsoleAuthState;
  const getUser = deps.getUser ?? getConsoleUserFromAuth;
  const getWorkspace = deps.getWorkspace ?? getConsoleWorkspace;
  const rateLimited = deps.rateLimited ?? isRateLimited;
  const resolveTarget = deps.resolveTarget ?? resolvePagesReturnTargetForAuthStart;

  if (!returnTo) {
    return pagesAuthStartErrorResponse({
      error: "invalid_return_to",
      request,
      requestId,
      returnTo,
      status: 400,
    });
  }

  if (rateLimited({ key: rateLimitKey(request, "pages-auth-start"), limit: 60, windowMs: 60_000 })) {
    return pagesAuthStartErrorResponse({
      error: "rate_limited",
      request,
      requestId,
      returnTo,
      status: 429,
    });
  }

  let target: Awaited<ReturnType<typeof resolvePagesReturnTargetForAuthStart>> = null;

  try {
    target = await resolveTarget({ returnTo });
    if (!target) {
      return pagesAuthStartErrorResponse({
        error: "invalid_return_to",
        request,
        requestId,
        returnTo,
        status: 400,
      });
    }

    const auth = await getAuthState();
    let claim: Awaited<ReturnType<typeof createPagesClaimCode>>;
    try {
      const workspace = await getWorkspace(auth, {
        organizationRef: target.organizationId,
      });
      claim = await createClaimCode({
        requestId,
        returnTo,
        workspace,
      });
    } catch (memberError) {
      // Not a member who can read the project: the person may still have
      // been given this page. Without that, the member error stands.
      if (auth.mode === "anonymous" || !isMemberAccessDenied(memberError)) throw memberError;
      const user = await getUser(auth);
      try {
        claim = await createGuestClaimCode({ requestId, returnTo, userId: user.id });
      } catch (guestError) {
        if (guestError instanceof ConsoleApiError && guestError.payload.error === "pages_access_denied") throw memberError;
        throw guestError;
      }
    }
    const response = NextResponse.redirect(claim.claimUrl);
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    const mapped = pagesAuthStartErrorFromUnknown(error, { hasResolvedTarget: Boolean(target) });
    if (mapped) {
      return pagesAuthStartErrorResponse({
        error: mapped.payload.error,
        reason: mapped.payload.reason,
        request,
        requestId,
        returnTo,
        status: mapped.status,
      });
    }
    console.error("Ravi Pages auth start failed", { error, requestId });
    return pagesAuthStartErrorResponse({
      error: "pages_auth_failed",
      request,
      requestId,
      returnTo,
      status: 500,
    });
  }
}

function isMemberAccessDenied(error: unknown) {
  if (error instanceof ConsoleWorkspaceSelectionRequiredError) return true;
  return error instanceof ConsoleApiError && (error.payload.error === "pages_access_denied" || error.payload.error === "not_found");
}
