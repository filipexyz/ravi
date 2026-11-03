import { NextResponse, type NextRequest } from "next/server";
import { authReturnToFromUrl } from "./return-to";
import { getOidcOrigin } from "./oidc-config";
import { getRuntimeOidcConfig } from "./oidc-runtime";
import { oidcInteractiveNavigationAllowed } from "./oidc-request-policy";
import { beginOidcLogin, completeOidcLogin, oidcLogoutUrl } from "./oidc-client";
import { createOidcBrowserSession, OidcAccessDeniedError, revokeOidcBrowserSession } from "./oidc-store";
import { OIDC_SESSION_COOKIE, OIDC_TRANSACTION_COOKIE, OIDC_TRANSACTION_SECONDS,
  oidcCookieOptions, openOidcTransaction, sealOidcTransaction } from "./oidc-transaction";

function clearTransaction(response: NextResponse) {
  response.cookies.set(OIDC_TRANSACTION_COOKIE, "", { ...oidcCookieOptions, maxAge: 0 });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

export async function oidcSignIn(request: NextRequest) {
  if (!oidcInteractiveNavigationAllowed(request.headers)) {
    return new NextResponse(null, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const config = await getRuntimeOidcConfig();
    const { transaction, url } = await beginOidcLogin(authReturnToFromUrl(request.nextUrl.searchParams), config);
    const response = NextResponse.redirect(url);
    response.cookies.set(OIDC_TRANSACTION_COOKIE, await sealOidcTransaction(transaction, config), {
      ...oidcCookieOptions, maxAge: OIDC_TRANSACTION_SECONDS,
    });
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    return clearTransaction(NextResponse.redirect(`${getOidcOrigin()}/login?auth=error`));
  }
}

export async function oidcCallback(request: NextRequest) {
  try {
    const config = await getRuntimeOidcConfig();
    const cookie = request.cookies.get(OIDC_TRANSACTION_COOKIE)?.value;
    if (!cookie) throw new Error("Missing OIDC transaction.");
    const transaction = await openOidcTransaction(cookie, config);
    // Configured origin is authoritative behind the private reverse proxy. Never
    // derive an OIDC redirect URI from an untrusted Host/forwarded header.
    const callback = new URL(`/callback${request.nextUrl.search}`, config.origin);
    const identity = await completeOidcLogin(callback, transaction, config);
    const session = await createOidcBrowserSession(identity, config);
    await revokeOidcBrowserSession(request.cookies.get(OIDC_SESSION_COOKIE)?.value);
    const response = clearTransaction(NextResponse.redirect(new URL(transaction.returnTo, config.origin)));
    response.cookies.set(OIDC_SESSION_COOKIE, session.token, { ...oidcCookieOptions, expires: session.expiresAt });
    return response;
  } catch (error) {
    const notice = error instanceof OidcAccessDeniedError ? "access-denied" : "error";
    return clearTransaction(NextResponse.redirect(`${getOidcOrigin()}/login?auth=${notice}`));
  }
}

export async function oidcSignOut(request: NextRequest) {
  if (!oidcInteractiveNavigationAllowed(request.headers)) {
    return new NextResponse(null, { status: 400, headers: { "cache-control": "no-store" } });
  }
  // Failure to revoke persistent state must not masquerade as a successful logout.
  await revokeOidcBrowserSession(request.cookies.get(OIDC_SESSION_COOKIE)?.value);
  let target: URL | string = `${getOidcOrigin()}/login?auth=signed-out`;
  try { target = await oidcLogoutUrl(await getRuntimeOidcConfig()); } catch { /* Local session is already revoked. */ }
  const response = clearTransaction(NextResponse.redirect(target));
  response.cookies.set(OIDC_SESSION_COOKIE, "", { ...oidcCookieOptions, maxAge: 0 });
  response.cookies.set("ravi_console_org", "", { ...oidcCookieOptions, maxAge: 0 });
  return response;
}
