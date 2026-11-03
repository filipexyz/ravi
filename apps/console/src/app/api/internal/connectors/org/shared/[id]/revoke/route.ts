/**
 * POST /api/internal/connectors/org/shared/:id/revoke
 *
 * Stops one agent from using an organization account. In the person's own
 * session; the Worker decides whether they may (the account's manager, an
 * owner or an admin).
 */

import { NextResponse, type NextRequest } from "next/server";

import { revokeSharedGrant } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  isConnectorId,
  openConnectorMemberRoute,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorMemberRoute(request);
  if (gate instanceof NextResponse) return gate;
  if (!isConnectorId(id)) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await revokeSharedGrant(gate.member, id);
    return connectorJson({ revoked: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
