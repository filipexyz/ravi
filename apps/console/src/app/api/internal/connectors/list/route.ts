/**
 * POST /api/internal/connectors/list   { provider?, includeHistory? }
 *
 * The signed-in person's own connections in the selected organization,
 * forwarded from the connectors Worker over HMAC. A read: an impersonation
 * session may look.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { connectableProviders } from "@/shared/integrations/connectable-providers";

import { listConnectors } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({
  provider: z.string().trim().min(1).max(60).optional(),
  includeHistory: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const gate = await openConnectorRoute(request, "read");
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const connections = await listConnectors(gate.actor, body);
    return connectorJson({ connections, providers: connectableProviders().map((provider) => ({id: provider.connectionProviderId, name: provider.displayName})) }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
