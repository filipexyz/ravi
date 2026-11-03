import { signOut } from "@workos-inc/authkit-nextjs";
import { WorkOS } from "@workos-inc/node";
import { NextResponse, type NextRequest } from "next/server";
import { getConsoleApiAuthState, isAnonymousModeEnabled, isWorkOSConfigured } from "@/lib/auth/session";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { isRuntimeOidcConfigured } from "@/lib/auth/oidc-runtime";
import { consoleRedirectUrl } from "@/lib/auth/console-origin";

export async function GET(request: NextRequest) {
  if (oidcModeEnabled() && await isRuntimeOidcConfigured()) {
    const { oidcSignOut } = await import("@/lib/auth/oidc-routes");
    return oidcSignOut(request);
  }
  const returnTo = consoleRedirectUrl("/login", request.url).toString();

  if (isAnonymousModeEnabled() || !isWorkOSConfigured()) {
    return NextResponse.redirect(returnTo);
  }

  const auth = await getConsoleApiAuthState();
  const sessionId = auth?.mode === "workos" ? auth.initialAuth?.sessionId : null;

  if (!sessionId) {
    await signOut({ returnTo });
    return;
  }

  const response = NextResponse.redirect(workOSLogoutUrl({ returnTo, sessionId }));
  clearWorkOSCookies(response, request);
  return response;
}

function workOSLogoutUrl({ returnTo, sessionId }: { returnTo: string; sessionId: string }) {
  const workos = new WorkOS({
    apiKey: process.env.WORKOS_API_KEY,
    clientId: process.env.WORKOS_CLIENT_ID,
  });
  return workos.userManagement.getLogoutUrl({ returnTo, sessionId });
}

function clearWorkOSCookies(response: NextResponse, request: NextRequest) {
  expireCookie(response, process.env.WORKOS_COOKIE_NAME || "wos-session", true);
  expireCookie(response, "workos-access-token", false);
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("wos-auth-verifier")) {
      expireCookie(response, cookie.name, true);
    }
  }
}

function expireCookie(response: NextResponse, name: string, httpOnly: boolean) {
  response.cookies.set(name, "", {
    domain: process.env.WORKOS_COOKIE_DOMAIN || undefined,
    expires: new Date(0),
    httpOnly,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
