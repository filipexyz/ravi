/**
 * POST /api/internal/connectors/revoke/:id
 *
 * Console-side wrapper around `link.ravi.so/ui/connect/revoke/:id`. A
 * provider that doesn't confirm answers `connector_provider_error`; the row
 * then shows "Disconnecting…" until the Worker's retry finishes it.
 */

import { NextResponse, type NextRequest } from "next/server";

import { revokeConnector } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
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
  if (!id) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await revokeConnector(gate.actor, id);
    return connectorJson({ revoked: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
