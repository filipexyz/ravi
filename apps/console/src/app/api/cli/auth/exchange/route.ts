import { type NextRequest } from "next/server";

import { exchangeCliAuth } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    if (isRateLimited({ key: rateLimitKey(request, "cli-auth-exchange"), limit: 20, windowMs: 60_000 })) {
      return cliFailure(cliApiError(429, "RATE_LIMITED"), requestId);
    }

    const body = await readJsonBody(request, requestId);
    const payload = await exchangeCliAuth({
      body,
      requestId,
      userAgent: request.headers.get("user-agent"),
    });
    return cliSuccess(payload, { status: 201 });
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
