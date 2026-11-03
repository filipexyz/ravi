import { NextRequest, NextResponse } from "next/server";
import { getOidcOrigin, oidcModeEnabled } from "@/lib/auth/oidc-config";
import { getRuntimeOidcConfig } from "@/lib/auth/oidc-runtime";
import { OIDC_SESSION_COOKIE, oidcCookieOptions } from "@/lib/auth/oidc-transaction";
import { BootstrapService, SETUP_COOKIE, SETUP_CALLBACK } from "@/server/console/fleet/bootstrap";
import { dbClient } from "@/server/db";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let response: NextResponse;
  try {
    if (!oidcModeEnabled()) throw new Error();
    const config = await getRuntimeOidcConfig();
    const session = await new BootstrapService(dbClient, config).complete(new URL(`${SETUP_CALLBACK}${request.nextUrl.search}`, config.origin), request.cookies.get(SETUP_COOKIE)?.value ?? "");
    response = NextResponse.redirect(new URL("/org/onboarding", config.origin));
    response.cookies.set(OIDC_SESSION_COOKIE, session.token, { ...oidcCookieOptions, expires: session.expiresAt });
  } catch { response = NextResponse.redirect(new URL("/setup?error=unavailable", getOidcOrigin())); }
  response.cookies.set(SETUP_COOKIE, "", { ...oidcCookieOptions, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
