import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { isWorkOSConfigured } from "@/lib/auth/session";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { isRuntimeOidcConfigured } from "@/lib/auth/oidc-runtime";
import { consoleRedirectUrl } from "@/lib/auth/console-origin";

const handleWorkOSAuth = handleAuth({
  returnPathname: "/projects",
  onError: async ({ request }) => NextResponse.redirect(new URL("/login?auth=error", request.url)),
});

export async function GET(request: NextRequest) {
  if (oidcModeEnabled() && await isRuntimeOidcConfigured()) {
    const { oidcCallback } = await import("@/lib/auth/oidc-routes");
    return oidcCallback(request);
  }
  if (!isWorkOSConfigured()) {
    return NextResponse.redirect(consoleRedirectUrl("/login?auth=missing-config", request.url));
  }

  return handleWorkOSAuth(request);
}
