/**
 * POST /api/internal/connectors/:id/tools   { capability, policy }
 *
 * The person's own rule for one tool of their connection: Always allow,
 * Needs approval or Blocked. The Worker refuses a rule looser than the
 * organization's ceiling (`connector_policy_above_ceiling`).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { setToolPolicy } from "@/server/connectors/console-client";
import {
  connectorCapabilitySchema,
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRoute,
  readConnectorBody,
  toolPolicySchema,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ capability: connectorCapabilitySchema, policy: toolPolicySchema });

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
    await setToolPolicy(gate.actor, id, body);
    return connectorJson({ ok: true }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
