/**
 * POST /api/internal/connectors/connect/resolve
 *
 * What a connect link is for, as `/connect/<token>` shows it. Inert: the
 * Worker only reads the pending grant. The workspace is the grant's
 * organization, checked against the signed-in person.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getConnectPageState } from "@/server/connectors/connect-grants";
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
  const gate = await openConnectorRequest(request, "read");
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const view = await getConnectPageState(gate.auth, body.token);
    if (view.state === "unavailable") return connectorJsonError(502, view.code, gate.requestId);
    return connectorJson({ ...view }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
