/**
 * POST /api/internal/connectors/consent/:id/revoke
 *
 * Takes back one agent's permission to use the person's account when they
 * ask. The agent asks again next time. Only the person who gave it, in
 * their own session; the Worker checks the grant is theirs.
 */

import { NextResponse, type NextRequest } from "next/server";

import { revokeConsentGrant } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  isConnectorId,
  openConnectorRoute,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorRoute(request);
  if (gate instanceof NextResponse) return gate;
  if (!isConnectorId(id)) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await revokeConsentGrant(gate.actor, id);
    return connectorJson({ revoked: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
