import { type NextRequest } from "next/server";

import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { authenticateInstallationRequest } from "@/server/cli/installation-auth";
import { getInstallationDesired } from "@/server/cli/installations";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/cli/installations/<id>/desired
 *
 * The desired manifest and its version/hash, for the installation's own
 * credential only. Never returns another installation's state.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateInstallationRequest(request, requestId);
    const { id } = await context.params;
    if (!auth.scopes.includes("console.installations.read")) {
      throw cliApiError(403, "INSTALLATION_MISMATCH");
    }
    return cliSuccess(await getInstallationDesired({ installation: auth.installation, installationId: id, requestId }));
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
