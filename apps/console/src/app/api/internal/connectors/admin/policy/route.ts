/**
 * POST /api/internal/connectors/admin/policy   { provider }
 *
 * The organization's rules for one connector on /org/connectors: whether it
 * is enabled, whether writing tools are allowed, and the per-tool ceilings.
 * Owners and admins only; the member's role goes to the Worker, which decides
 * too. A read.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getOrgPolicy } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorAdminRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ provider: z.string().trim().min(1).max(60) });

export async function POST(request: NextRequest) {
  const gate = await openConnectorAdminRoute(request, "read");
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const policy = await getOrgPolicy(gate.admin, body.provider);
    return connectorJson({ policy }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
