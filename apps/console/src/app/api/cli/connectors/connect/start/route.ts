/**
 * POST /api/cli/connectors/connect/start
 *
 * The CLI starts a connection for its signed-in operator. Answers the
 * Console page `/connect/<token>` that the same person opens to continue to
 * the provider, plus the pending grant the CLI polls on the Worker.
 */

import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { startCliConnect } from "@/server/connectors/cli-connect";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const result = await startCliConnect({
      auth,
      body: await readJsonBody(request, requestId, { maxBytes: 8 * 1024 }),
    });
    return cliSuccess(result, { status: 201, headers: { "cache-control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
