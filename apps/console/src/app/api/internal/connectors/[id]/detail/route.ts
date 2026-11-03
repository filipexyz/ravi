/**
 * POST /api/internal/connectors/:id/detail
 *
 * One of the person's connections for its drawer: tools and their policies,
 * who uses it, and recent activity (actions only, never content). A read:
 * an impersonation session may look.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getConnectionDetail } from "@/server/connectors/console-client";
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
  const gate = await openConnectorRoute(request, "read");
  if (gate instanceof NextResponse) return gate;
  if (!id) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const connection = await getConnectionDetail(gate.actor, id);
    return connectorJson({ connection }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
