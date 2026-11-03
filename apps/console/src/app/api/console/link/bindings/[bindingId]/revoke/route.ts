import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { requestIdFrom } from "@/server/cli/http";
import { revokeRaviLinkBindingForUser } from "@/server/console/ravi-link-requests";
import {
  isTrustedConsolePost,
  raviLinkApproverFromAuth,
  redirectTo,
} from "@/server/console/ravi-link-web";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ bindingId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  if (!isTrustedConsolePost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return redirectTo(request, `/login?returnTo=${encodeURIComponent("/link")}`);
  }

  try {
    const { bindingId } = await context.params;
    await revokeRaviLinkBindingForUser({
      approver: await raviLinkApproverFromAuth(auth),
      bindingId,
      requestId,
    });
    return redirectTo(request, "/link?revoked=1");
  } catch (error) {
    if (error instanceof CliApiError) {
      return redirectTo(request, `/link?error=${encodeURIComponent(error.code)}`);
    }
    throw error;
  }
}
