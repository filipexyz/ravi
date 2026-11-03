import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { configuredWorkOSRedirectUri, isWorkOSConfigured } from "@/lib/auth/session";
import { authReturnToFromUrl } from "@/lib/auth/return-to";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { consoleRedirectUrl } from "@/lib/auth/console-origin";

export async function GET(request: NextRequest) {
  if (oidcModeEnabled()) return NextResponse.redirect(consoleRedirectUrl("/login", request.url));
  if (!isWorkOSConfigured()) {
    return NextResponse.redirect(new URL("/login?auth=missing-config", request.url));
  }

  const signUpUrl = await getSignUpUrl({
    redirectUri: configuredWorkOSRedirectUri() ?? new URL("/callback", request.url).toString(),
    returnTo: authReturnToFromUrl(request.nextUrl.searchParams),
  });
  redirect(signUpUrl);
}
