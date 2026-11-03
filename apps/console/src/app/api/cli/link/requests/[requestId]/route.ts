import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import {
  cancelRaviLinkRequestForCli,
  getRaviLinkRequestForCli,
  raviLinkRequestCallerFromCliAuth,
} from "@/server/console/ravi-link-requests";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ requestId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const { requestId: linkRequestId } = await context.params;
    return cliSuccess(
      await getRaviLinkRequestForCli({
        caller: raviLinkRequestCallerFromCliAuth(auth),
        linkRequestId,
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const { requestId: linkRequestId } = await context.params;
    return cliSuccess(
      await cancelRaviLinkRequestForCli({
        caller: raviLinkRequestCallerFromCliAuth(auth),
        linkRequestId,
        requestId,
      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
