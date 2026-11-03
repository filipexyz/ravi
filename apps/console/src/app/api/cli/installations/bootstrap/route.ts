import { type NextRequest } from "next/server";

import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  bootstrapInstallation,
  parseBootstrapMetadata,
} from "@/server/cli/installations";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/cli/installations/bootstrap
 *
 * Exchanges a single-use bootstrap token for an installation credential.
 * The body is `{ token, installation?: { name, hostname, platform,
 * raviVersion, machineFingerprint } }`. The token is never accepted again.
 */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    if (isRateLimited({ key: rateLimitKey(request, "cli-installation-bootstrap"), limit: 30, windowMs: 60_000 })) {
      throw cliApiError(429, "RATE_LIMITED");
    }

    const body = await readJsonBody(request, requestId, { maxBytes: 16 * 1024 });
    if (!body || typeof body !== "object") throw cliApiError(400, "PAYLOAD_INVALID");
    const record = body as Record<string, unknown>;
    const token = typeof record.token === "string" ? record.token.trim() : "";
    if (!token) throw cliApiError(400, "PAYLOAD_INVALID", "A bootstrap token is required.");

    const metadata = parseBootstrapMetadata(record.installation);
    const payload = await bootstrapInstallation({
      token,
      metadata,
      requestId,
      userAgent: request.headers.get("user-agent"),
    });
    return cliSuccess(payload);
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
