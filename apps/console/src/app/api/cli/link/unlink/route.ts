import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { unlinkRaviLink, type RaviLinkCaller } from "@/server/console/ravi-link";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    return cliSuccess(
      await unlinkRaviLink({
        body: await readJsonBody(request, requestId, { maxBytes: 16 * 1024 }),
        caller: callerFromCliAuth(auth),
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function callerFromCliAuth(
  auth: Awaited<ReturnType<typeof authenticateCliRequest>>,
): RaviLinkCaller {
  return {
    membershipStatus: auth.membership.status,
    sessionInstallationId: auth.localInstallation.id,
    sessionOrganizationId: auth.organization.id,
    userId: auth.user.id,
  };
}
