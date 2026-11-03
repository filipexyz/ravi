import { type NextRequest } from "next/server";

import { createCliDeviceAuthorization } from "@/server/cli/device-auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    if (isRateLimited({ key: rateLimitKey(request, "cli-auth-device"), limit: 30, windowMs: 60_000 })) {
      return cliFailure(cliApiError(429, "RATE_LIMITED"), requestId);
    }

    const form = await request.formData().catch(() => null);
    const clientId = stringValue(form?.get("client_id"));
    const payload = await createCliDeviceAuthorization({
      requestUrl: request.url,
      clientId,
      userAgent: request.headers.get("user-agent"),
    });

    return cliSuccess(payload, { status: 201 });
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function stringValue(value: FormDataEntryValue | null | undefined) {
  return typeof value === "string" ? value.trim() || null : null;
}
