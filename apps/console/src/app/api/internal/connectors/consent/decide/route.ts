/**
 * POST /api/internal/connectors/consent/decide   { token, decision: "approve" | "deny", connectionId? }
 *
 * The person's answer on `/connectors/consent/<token>`. Approving lets that
 * agent, on that computer, use the chosen account whenever this person asks
 * it something; denying tells the agent no. Only the person the request was
 * made for, in their own session.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ConsentStepError, decideConsentFlow } from "@/server/connectors/consent";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRequest,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().trim().min(1).max(512),
  decision: z.enum(["approve", "deny"]),
  connectionId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  const gate = await openConnectorRequest(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const result = await decideConsentFlow(gate.auth, body);
    return connectorJson({ consentStatus: result.status, grantId: result.grantId }, gate.requestId);
  } catch (error) {
    if (error instanceof ConsentStepError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
