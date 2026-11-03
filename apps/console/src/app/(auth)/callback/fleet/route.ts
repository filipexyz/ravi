import { NextRequest, NextResponse } from "next/server";
import { getConsoleApiAuthState } from "@/lib/auth/session";
import { getOidcOrigin } from "@/lib/auth/oidc-config";
import { hashBrowserSessionToken, OIDC_SESSION_COOKIE, oidcCookieOptions } from "@/lib/auth/oidc-transaction";
import { getConsoleWorkspace } from "@/server/console/workspace";
import { fleetSsoService } from "@/server/console/fleet/runtime";
import { SSO_TEST_CALLBACK, SSO_TEST_COOKIE } from "@/server/console/fleet/sso-service";
import { assertConsoleFeatureAvailable } from "@/server/console/feature-access";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let notice = "failed";
  try {
    const auth = await getConsoleApiAuthState();
    if (!auth || auth.mode !== "oidc") throw new Error("auth_required");
    const workspace = await getConsoleWorkspace(auth);
    await assertConsoleFeatureAvailable(workspace, "console.settings");
    await fleetSsoService().completeTest({ mode: auth.mode, role: workspace.membership.role,
      userId: workspace.user.id, organizationId: workspace.organization.id },
      hashBrowserSessionToken(request.cookies.get(OIDC_SESSION_COOKIE)?.value ?? "") ?? "",
      new URL(`${SSO_TEST_CALLBACK}${request.nextUrl.search}`, getOidcOrigin()), request.cookies.get(SSO_TEST_COOKIE)?.value ?? "");
    notice = "validated";
  } catch { /* Do not log authorization codes, tokens, IdP responses or cookies. */ }
  const response = NextResponse.redirect(new URL(`/org/sso?test=${notice}`, getOidcOrigin()));
  response.cookies.set(SSO_TEST_COOKIE, "", { ...oidcCookieOptions, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
