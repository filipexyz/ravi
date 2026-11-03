/**
 * POST /api/internal/connectors/admin/connections/:id/revoke
 *
 * An owner or admin disconnects a member's connection. Same outcome as the
 * member's own Disconnect: a provider that doesn't confirm answers
 * `connector_provider_error` and the row shows "Disconnecting…" until the
 * Worker's retry finishes it.
 */

import { NextResponse, type NextRequest } from "next/server";

import { revokeAdminConnection } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorAdminRoute,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorAdminRoute(request);
  if (gate instanceof NextResponse) return gate;
  if (!id) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await revokeAdminConnection(gate.admin, id);
    return connectorJson({ revoked: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
