import { NextResponse, type NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { getConsoleUserFromAuth } from "@/server/console/workspace";

import {
  normalizeLinkRequestToken,
  raviLinkConsoleOrigin,
  type RaviLinkApprover,
} from "./ravi-link-requests";

/** The person approving in the browser, from their Console session. */
export async function raviLinkApproverFromAuth(auth: ConsoleAuthState): Promise<RaviLinkApprover> {
  const user = await getConsoleUserFromAuth(auth);
  const workosUser = auth.initialAuth?.user ?? null;
  return {
    requireBrowserSession: auth.mode === "oidc",
    browserSessionId: auth.oidc?.sessionId,
    actorType: auth.mode === "anonymous" ? "anonymous" : "user",
    email: auth.oidc?.email ?? workosUser?.email ?? null,
    emailVerified: auth.oidc?.emailVerified === true || workosUser?.emailVerified === true,
    impersonated: Boolean(auth.initialAuth?.impersonator),
    userId: user.id,
  };
}

/**
 * Strict CSRF guard for the link forms: the browser must say the post came
 * from the Console itself. A missing Origin is rejected.
 */
/**
 * CSRF check for the browser POSTs. Browsers set Sec-Fetch-Site themselves,
 * so when it is present it decides. It must, because a page with a strict
 * referrer policy makes the browser send `Origin: null` even on a same-origin
 * form post. Older browsers without it fall back to the Origin header.
 */
export function isTrustedConsolePost(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  let parsed: string;
  try {
    parsed = new URL(origin).origin;
  } catch {
    return false;
  }
  return parsed === new URL(request.url).origin || parsed === raviLinkConsoleOrigin(request.url);
}

export function linkPagePath(token: string | null | undefined) {
  const normalized = normalizeLinkRequestToken(token);
  return normalized ? `/link/${normalized}` : "/link";
}

export function redirectTo(request: NextRequest, path: string) {
  const response = NextResponse.redirect(new URL(path, request.url), { status: 303 });
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cache-control", "no-store");
  return response;
}

export function formString(form: FormData | null, key: string) {
  const value = form?.get(key);
  return typeof value === "string" ? value.trim() || null : null;
}
