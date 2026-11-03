import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { configuredWorkOSRedirectUri, isWorkOSConfigured } from "@/lib/auth/session";
import { authReturnToFromUrl } from "@/lib/auth/return-to";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { isRuntimeOidcConfigured } from "@/lib/auth/oidc-runtime";
import { consoleRedirectUrl } from "@/lib/auth/console-origin";

export async function GET(request: NextRequest) {
  if (oidcModeEnabled() && await isRuntimeOidcConfigured()) {
    const { oidcSignIn } = await import("@/lib/auth/oidc-routes");
    return oidcSignIn(request);
  }
  if (!isWorkOSConfigured()) {
    return NextResponse.redirect(consoleRedirectUrl("/login?auth=missing-config", request.url));
  }

  const signInUrl = await getSignInUrl({
    redirectUri: configuredWorkOSRedirectUri() ?? new URL("/callback", request.url).toString(),
    returnTo: authReturnToFromUrl(request.nextUrl.searchParams),
  });
  redirect(signInUrl);
}
