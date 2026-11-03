/**
 * POST /api/internal/connectors/org/connections/:id/owner   { managedByUserId }
 *
 * "Change owner" of an organization account: the member who manages it and
 * decides its approvals. The Worker checks they are an active member. Owners
 * and admins only, in their own session.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { setOrgConnectionOwner } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  isConnectorId,
  openConnectorAdminRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ managedByUserId: z.string().uuid() });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorAdminRoute(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!isConnectorId(id) || !body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    await setOrgConnectionOwner(gate.admin, id, body.managedByUserId);
    return connectorJson({ ok: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
