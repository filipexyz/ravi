/**
 * POST /api/internal/connectors/connect/continue
 *
 * "Continue to Google" on `/connect/<token>`. Only the person who started
 * the connection can continue; the Worker then creates the OAuth state and
 * PKCE and answers the provider's sign-in URL. The answer marks this browser
 * as the one that may finish the grant.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { bindConnectBrowser, ConnectStepError, continueConnectFlow } from "@/server/connectors/connect-grants";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRequest,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ token: z.string().trim().min(1).max(512) });

export async function POST(request: NextRequest) {
  const gate = await openConnectorRequest(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const result = await continueConnectFlow(gate.auth, body.token);
    if (!result?.authorizationUrl) return connectorJsonError(502, "connector_unavailable", gate.requestId);
    return bindConnectBrowser(connectorJson({ authorizationUrl: result.authorizationUrl }, gate.requestId), result.pendingId);
  } catch (error) {
    if (error instanceof ConnectStepError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
