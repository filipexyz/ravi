import { type NextRequest } from "next/server";

import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { authenticateInstallationRequest } from "@/server/cli/installation-auth";
import {
  reportInstallationState,
  reportedInstallationStateSchema,
} from "@/server/cli/installations";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/cli/installations/<id>/state
 *
 * The installation reports its derived summary: state, version, applied hash,
 * drift entries, doctor check ids and gates. Message content, provider tokens
 * and logs are rejected by the strict schema.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateInstallationRequest(request, requestId);
    if (!auth.scopes.includes("console.installations.write")) {
      throw cliApiError(403, "INSTALLATION_MISMATCH");
    }

    const { id } = await context.params;
    const parsed = reportedInstallationStateSchema.safeParse(
      await readJsonBody(request, requestId, { maxBytes: 256 * 1024 }),
    );
    if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID");

    return cliSuccess(
      await reportInstallationState({
        installation: auth.installation,
        installationId: id,
        reported: parsed.data,
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
