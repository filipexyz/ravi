import { type NextRequest } from "next/server";

import { getCliAuthPublicConfig } from "@/server/cli/config";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (isRateLimited({ key: rateLimitKey(request, "cli-auth-config"), limit: 120, windowMs: 60_000 })) {
    return cliFailure(cliApiError(429, "RATE_LIMITED"), requestId);
  }

  return cliSuccess(
    getCliAuthPublicConfig(request.url, {
      flow:
        request.headers.get("x-ravi-cli-auth-flow") === "console_device"
          ? "console_device"
          : "legacy_provider",
    }),
  );
}
