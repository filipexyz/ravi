import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  authorizeMailInternalRequest,
  getMailInternalControlToken,
  resolveMailInternalRoute,
  type MailInternalRouteResolveRequest,
} from "@/server/console/mail/internal-api";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getMailInternalControlToken();
  if (!token) {
    console.error("Ravi Mail route resolve endpoint is missing RAVI_MAIL_CONTROL_TOKEN", { requestId });
    return NextResponse.json({ status: "error", code: "control_token_not_configured" }, { status: 503 });
  }

  if (!authorizeMailInternalRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "mail-route-resolve-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json({ status: "error", code: "rate_limited" }, { status: 429 });
    }

    return NextResponse.json({ status: "error", code: "unauthorized" }, { status: 401 });
  }

  let input: MailInternalRouteResolveRequest;
  try {
    input = (await request.json()) as MailInternalRouteResolveRequest;
  } catch {
    return NextResponse.json({ status: "error", code: "invalid_json" }, { status: 400 });
  }

  try {
    const payload = await resolveMailInternalRoute({
      input: {
        ...input,
        requestId: input.requestId ?? requestId,
      },
    });
    return NextResponse.json(payload, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    console.error("Ravi Mail route resolve failed", { error, requestId });
    return NextResponse.json(
      { status: "error", code: "mail_route_resolve_failed" },
      { status: 503, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}
