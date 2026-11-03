import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  createRaviLinkRequest,
  raviLinkConsoleOrigin,
  raviLinkRequestCallerFromCliAuth,
} from "@/server/console/ravi-link-requests";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const result = await createRaviLinkRequest({
      body: await readJsonBody(request, requestId, { maxBytes: 16 * 1024 }),
      caller: raviLinkRequestCallerFromCliAuth(auth),
      origin: raviLinkConsoleOrigin(request.url),
      requestId,
    });
    return cliSuccess(result.payload, {
      status: result.httpStatus,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
