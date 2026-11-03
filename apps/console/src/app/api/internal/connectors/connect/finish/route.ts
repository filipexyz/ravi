/**
 * POST /api/internal/connectors/connect/finish
 *
 * Called once by `/connect/finish` after the provider sent the browser back.
 * The Worker checks the person and the one-time result token, stores the
 * connection, and answers the same result again on a repeat. The initiator
 * finishes only from the browser that started or continued the grant.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ConnectStepError, finishConnectFlow, isConnectBrowserBound } from "@/server/connectors/connect-grants";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRequest,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({
  pendingId: z.string().trim().min(1).max(64),
  resultToken: z.string().trim().min(1).max(512),
});

export async function POST(request: NextRequest) {
  const gate = await openConnectorRequest(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const result = await finishConnectFlow(gate.auth, {
      ...body,
      browserBound: isConnectBrowserBound(request, body.pendingId),
    });
    return connectorJson({ ...result }, gate.requestId);
  } catch (error) {
    if (error instanceof ConnectStepError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
