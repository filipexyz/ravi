import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { requestIdFrom } from "@/server/cli/http";
import { createAccessRequest } from "@/server/console/access/requests";
import { ConsoleApiError } from "@/server/console/api-error";
import { formString, isTrustedConsolePost, raviLinkApproverFromAuth, redirectTo } from "@/server/console/ravi-link-web";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { ConsoleEmailVerificationRequiredError } from "@/server/console/workspace";

export const runtime = "nodejs";

/** The "Ask for access" form: same-origin POST, signed in. */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (!isTrustedConsolePost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const returnTo = formString(form, "returnTo") ?? "";
  const message = formString(form, "message");
  const back = `/access/request?returnTo=${encodeURIComponent(returnTo)}`;

  const auth = await getConsoleApiAuthState();
  if (!auth) return redirectTo(request, `/login?returnTo=${encodeURIComponent(back)}`);

  try {
    const viewer = await raviLinkApproverFromAuth(auth);
    const result = await createAccessRequest({
      caller: { userId: viewer.userId },
      message,
      origin: raviLinkConsoleOrigin(request.url),
      requestId,
      url: returnTo,
    });
    if (result.status === "already_allowed") return redirectTo(request, result.url);
    return redirectTo(request, `/access/requests/${result.request.id}?sent=1`);
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return redirectTo(request, `${back}&error=${encodeURIComponent(error.payload.error)}`);
    }
    if (error instanceof ConsoleEmailVerificationRequiredError) return redirectTo(request, "/");
    throw error;
  }
}
