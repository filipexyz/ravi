import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { requestIdFrom } from "@/server/cli/http";
import { decideAccessRequest, isAccessRequestId } from "@/server/console/access/requests";
import { ConsoleApiError } from "@/server/console/api-error";
import { formString, isTrustedConsolePost, raviLinkApproverFromAuth, redirectTo } from "@/server/console/ravi-link-web";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";

export const runtime = "nodejs";

/** Approve or decline from the forwardable link: same-origin POST by someone who can share the site. */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (!isTrustedConsolePost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const id = formString(form, "id");
  if (!isAccessRequestId(id)) return redirectTo(request, "/access/requests/invalid");
  const decision = formString(form, "decision") === "approve" ? "approve" : "deny";
  const scope = formString(form, "scope") === "site" ? "site" : "route";
  const back = `/access/requests/${id}`;

  const auth = await getConsoleApiAuthState();
  if (!auth) return redirectTo(request, `/login?returnTo=${encodeURIComponent(back)}`);

  try {
    const viewer = await raviLinkApproverFromAuth(auth);
    if (viewer.impersonated) return redirectTo(request, `${back}?error=impersonated`);
    await decideAccessRequest({
      decision,
      id,
      origin: raviLinkConsoleOrigin(request.url),
      requestId,
      scope,
      viewerUserId: viewer.userId,
    });
    return redirectTo(request, back);
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return redirectTo(request, `${back}?error=${encodeURIComponent(error.payload.error)}`);
    }
    throw error;
  }
}
