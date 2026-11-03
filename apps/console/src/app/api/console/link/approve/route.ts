import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { requestIdFrom } from "@/server/cli/http";
import { approveRaviLinkRequest } from "@/server/console/ravi-link-requests";
import {
  formString,
  isTrustedConsolePost,
  linkPagePath,
  raviLinkApproverFromAuth,
  redirectTo,
} from "@/server/console/ravi-link-web";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  if (!isTrustedConsolePost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const token = formString(form, "token");
  const back = linkPagePath(token);

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return redirectTo(request, `/login?returnTo=${encodeURIComponent(back)}`);
  }

  try {
    await approveRaviLinkRequest({
      approver: await raviLinkApproverFromAuth(auth),
      requestId,
      token,
    });
    return redirectTo(request, back);
  } catch (error) {
    if (error instanceof CliApiError) {
      return redirectTo(request, `${back}?error=${encodeURIComponent(error.code)}`);
    }
    throw error;
  }
}
