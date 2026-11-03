import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { configuredWorkOSRedirectUri, isAnonymousModeEnabled, isWorkOSConfigured } from "@/lib/auth/config";
import { isPublicAuthPath } from "@/lib/auth/public-paths";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { getRuntimeOidcConfig, isRuntimeOidcConfigured } from "@/lib/auth/oidc-runtime";
import { OIDC_SESSION_COOKIE } from "@/lib/auth/oidc-transaction";
import { oidcBrowserRequestAllowed } from "@/lib/auth/oidc-request-policy";
import { consoleRedirectUrl } from "@/lib/auth/console-origin";

export default async function proxy(request: NextRequest, _event: NextFetchEvent) {
  if (oidcModeEnabled()) {
    const { pathname } = request.nextUrl;
    if (isPublicAuthPath(pathname)) return NextResponse.next();
    if (!await isRuntimeOidcConfigured()) {
      return NextResponse.redirect(consoleRedirectUrl("/login?auth=missing-config", request.url));
    }
    const config = await getRuntimeOidcConfig(false);
    // Includes browser-authenticated internal approval APIs, not only /api/console.
    // Public machine routes above validate their own scoped credentials.
    if (!oidcBrowserRequestAllowed(request.method, request.headers.get("origin"), config.origin)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const { readOidcBrowserSession } = await import("@/lib/auth/oidc-store");
    const session = await readOidcBrowserSession(request.cookies.get(OIDC_SESSION_COOKIE)?.value, config);
    if (session) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    const login = new URL("/login", config.origin);
    login.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  if (isAnonymousModeEnabled()) {
    return NextResponse.next();
  }

  if (!isWorkOSConfigured()) {
    if (isPublicAuthPath(request.nextUrl.pathname)) {
      return NextResponse.next();
    }

    return NextResponse.redirect(new URL("/login?auth=missing-config", request.url));
  }

  const { pathname } = request.nextUrl;
  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: workOSRedirectUriForRequest(request),
    screenHint: pathname === "/sign-up" ? "sign-up" : undefined,
  });

  if (!isPublicAuthPath(pathname) && !session.user && authorizationUrl) {
    return handleAuthkitHeaders(request, headers, { redirect: authorizationUrl });
  }

  return handleAuthkitHeaders(request, headers);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function workOSRedirectUriForRequest(request: NextRequest) {
  return configuredWorkOSRedirectUri() ?? new URL("/callback", request.url).toString();
}
