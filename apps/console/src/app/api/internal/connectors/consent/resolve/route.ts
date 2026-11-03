/**
 * POST /api/internal/connectors/consent/resolve   { token }
 *
 * What a consent link asks, as `/connectors/consent/<token>` shows it: which
 * agent, on which computer, run by whom, and which of the person's accounts
 * it could use. Inert: the Worker only reads the request. The organization is
 * the request's own, and only the person it was made for sees it; an
 * impersonation session is refused.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getConsentPageState } from "@/server/connectors/consent";
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
    const view = await getConsentPageState(gate.auth, body.token);
    if (view.state === "unavailable") return connectorJsonError(502, view.code, gate.requestId);
    if (view.state === "denied") return connectorJsonError(403, view.reason, gate.requestId);
    return connectorJson({ ...view }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
