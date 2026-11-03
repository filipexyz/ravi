import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  clearPagesSessionCookies,
  consumePagesClaimCode,
  getPagesControlToken,
  isPagesControlRequestAuthorized,
  pagesSessionCookie,
} from "@/server/console/pages/auth";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

type ClaimRequestBody = {
  code?: string;
  host?: string;
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesControlToken();
  if (!token) {
    console.error("Ravi Pages claim endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json({ status: "error", code: "control_token_not_configured" }, { status: 503 });
  }

  if (!isPagesControlRequestAuthorized(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-claim-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json({ status: "error", code: "rate_limited" }, { status: 429 });
    }

    return NextResponse.json({ status: "error", code: "unauthorized" }, { status: 401 });
  }

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ status: "error", code: "invalid_json" }, { status: 400 });
  }

  if (!body.code || !body.host) {
    return NextResponse.json({ status: "error", code: "invalid_claim" }, { status: 400 });
  }

  if (
    isRateLimited({
      key: `${rateLimitKey(request, "pages-claim-exchange")}:${body.host}`,
      limit: 120,
      windowMs: 60_000,
    })
  ) {
    return NextResponse.json(
      { status: "error", code: "rate_limited" },
      { status: 429, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  try {
    const session = await consumePagesClaimCode({
      code: body.code,
      host: body.host,
      requestId,
    });

    if (!session) {
      return NextResponse.json(
        {
          status: "invalid",
          code: "claim_invalid",
          clearCookies: clearPagesSessionCookies(),
        },
        { status: 404, headers: { "cache-control": "no-store", "x-request-id": requestId } },
      );
    }

    return NextResponse.json(
      {
        status: "ok",
        returnTo: session.returnTo,
        session: {
          expiresAt: session.expiresAt.toISOString(),
          cookie: pagesSessionCookie(session.sessionToken, session.expiresAt),
        },
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    console.error("Ravi Pages claim exchange failed", { error, requestId });
    return NextResponse.json(
      {
        status: "error",
        code: "claim_failed",
      },
      { status: 503, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}
