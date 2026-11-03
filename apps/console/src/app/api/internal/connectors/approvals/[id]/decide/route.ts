/**
 * POST /api/internal/connectors/approvals/:id/decide   { decision: "approve" | "deny" }
 *
 * The owner's answer to a write an agent asked to run. Approving lets that
 * exact request run once in the next 10 minutes; denying tells the agent no.
 * Only whoever decides it (the owner; on an organization account nobody
 * manages, an owner or admin), in their own session.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ApprovalStepError, decideApprovalFlow } from "@/server/connectors/approvals";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRequest,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({ decision: z.enum(["approve", "deny"]) });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorRequest(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const result = await decideApprovalFlow(gate.auth, id, body.decision);
    return connectorJson({ approvalStatus: result.status }, gate.requestId);
  } catch (error) {
    if (error instanceof ApprovalStepError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
