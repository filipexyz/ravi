/**
 * POST /api/internal/connectors/:id/default
 *
 * "Make default": commands that need this provider without naming a
 * connection use this one.
 */

import { NextResponse, type NextRequest } from "next/server";

import { makeDefaultConnector } from "@/server/connectors/console-client";
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
    await makeDefaultConnector(gate.actor, id);
    return connectorJson({ ok: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
