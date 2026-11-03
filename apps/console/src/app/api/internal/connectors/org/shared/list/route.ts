/**
 * POST /api/internal/connectors/org/shared/list   { connectionId? }
 *
 * Where the organization's accounts are shared: computer, agent and
 * conversations per grant. Any active member may ask; the Worker answers
 * owners and admins every grant and a manager those of the accounts they
 * manage. A read.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { listSharedGrants } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorMemberRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ connectionId: z.string().uuid().optional() });

export async function POST(request: NextRequest) {
  const gate = await openConnectorMemberRoute(request, "read");
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const grants = await listSharedGrants(gate.member, body);
    return connectorJson({ grants }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
