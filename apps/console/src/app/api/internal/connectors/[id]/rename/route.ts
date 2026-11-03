/**
 * POST /api/internal/connectors/:id/rename   { displayName }
 *
 * The label the person gives one of their connections.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { renameConnector } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";
import { CONNECTION_NAME_MAX_LENGTH } from "@/shared/integrations/connection-limits";

export const runtime = "nodejs";

const bodySchema = z.object({ displayName: z.string().trim().min(1).max(CONNECTION_NAME_MAX_LENGTH) });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorRoute(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!id || !body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await renameConnector(gate.actor, id, body.displayName);
    return connectorJson({ ok: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
