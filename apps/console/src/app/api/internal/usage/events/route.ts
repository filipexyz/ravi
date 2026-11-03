import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  ingestUsageEvents,
  UsageIngestValidationError,
  type UsageIngestPayload,
} from "@/server/console/billing/usage-ingest";
import {
  getPagesControlToken,
  isPagesControlRequestAuthorized,
} from "@/server/console/pages/auth";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesControlToken();
  if (!token) {
    console.error("Usage ingest endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json({ status: "error", code: "control_token_not_configured" }, { status: 503 });
  }

  if (!isPagesControlRequestAuthorized(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "usage-events-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json({ status: "error", code: "rate_limited" }, { status: 429 });
    }

    return NextResponse.json({ status: "error", code: "unauthorized" }, { status: 401 });
  }

  let payload: UsageIngestPayload;
  try {
    payload = (await request.json()) as UsageIngestPayload;
  } catch {
    return NextResponse.json({ status: "error", code: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await ingestUsageEvents({ payload, requestId });
    return NextResponse.json({ status: "ok", accepted: result.accepted }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof UsageIngestValidationError) {
      return NextResponse.json(
        { status: "error", code: "invalid_usage_events" },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    console.error("Usage ingest failed", { error, requestId });
    return NextResponse.json(
      { status: "error", code: "usage_ingest_failed" },
      { status: 503, headers: { "x-request-id": requestId } },
    );
  }
}
