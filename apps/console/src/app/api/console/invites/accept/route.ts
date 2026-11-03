import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { requestIdFrom } from "@/server/cli/http";
import { acceptOrganizationInvite, normalizeOrganizationInviteToken } from "@/server/console/access/invites";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  formString,
  isTrustedConsolePost,
  raviLinkApproverFromAuth,
  redirectTo,
} from "@/server/console/ravi-link-web";
import { CONSOLE_ORGANIZATION_COOKIE, ConsoleEmailVerificationRequiredError } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  if (!isTrustedConsolePost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const token = normalizeOrganizationInviteToken(formString(form, "token"));
  const back = token ? `/invite/${token}` : "/invite";

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return redirectTo(request, `/login?returnTo=${encodeURIComponent(back)}`);
  }

  try {
    const { organizationId } = await acceptOrganizationInvite({
      requestId,
      token,
      viewer: await raviLinkApproverFromAuth(auth),
    });
    // Open the Console in the organization they just joined.
    const response = redirectTo(request, "/projects");
    response.cookies.set(CONSOLE_ORGANIZATION_COOKIE, organizationId, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return response;
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return redirectTo(request, `${back}?error=${encodeURIComponent(error.payload.error)}`);
    }
    if (error instanceof ConsoleEmailVerificationRequiredError) {
      return redirectTo(request, `${back}?error=INVITE_EMAIL_UNVERIFIED`);
    }
    throw error;
  }
}
