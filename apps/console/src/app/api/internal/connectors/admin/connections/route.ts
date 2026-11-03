/**
 * POST /api/internal/connectors/admin/connections   { provider? }
 *
 * The members' connections on /org/connectors: member, account email,
 * status and last use. Never tokens or content. Owners and admins only; a
 * read.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { listAdminConnections } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorAdminRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ provider: z.string().trim().min(1).max(60).optional() });

export async function POST(request: NextRequest) {
  const gate = await openConnectorAdminRoute(request, "read");
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const connections = await listAdminConnections(gate.admin, body);
    return connectorJson({ connections }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
