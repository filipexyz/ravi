import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  resolveRaviLink,
  unlinkRaviLink,
  upsertRaviLink,
  type RaviLinkCaller,
} from "@/server/console/ravi-link";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const searchParams = new URL(request.url).searchParams;
    return cliSuccess(
      await resolveRaviLink({
        caller: callerFromCliAuth(auth),
        query: Object.fromEntries(searchParams.entries()),
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    // Closed: answers 410 LINK_APPROVAL_REQUIRED. Use /api/cli/link/requests.
    return cliSuccess(
      await upsertRaviLink({
        caller: callerFromCliAuth(auth),
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const contentLength = request.headers.get("content-length");
    const body =
      contentLength && contentLength !== "0"
        ? {
            ...query,
            ...(await readJsonBody(request, requestId, { maxBytes: 16 * 1024 })),
          }
        : query;
    return cliSuccess(
      await unlinkRaviLink({
        body,
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
