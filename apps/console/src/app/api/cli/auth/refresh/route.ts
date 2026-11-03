import { type NextRequest } from "next/server";

import { refreshCliAuth } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    if (isRateLimited({ key: rateLimitKey(request, "cli-auth-refresh"), limit: 60, windowMs: 60_000 })) {
      return cliFailure(cliApiError(429, "RATE_LIMITED"), requestId);
    }

    const body = await readJsonBody(request, requestId);
    const payload = await refreshCliAuth({ body, requestId });
    return cliSuccess(payload);
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
