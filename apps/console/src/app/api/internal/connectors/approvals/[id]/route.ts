/**
 * POST /api/internal/connectors/approvals/:id
 *
 * One approval with its preview (who it goes to, the subject, the start of
 * the body), for whoever decides it (see `resolveApprovalAccess`). The
 * organization is the approval's own.
 * An impersonation session is refused: the preview is the person's email.
 */

import { NextResponse, type NextRequest } from "next/server";

import { ApprovalStepError, getApprovalForOwner } from "@/server/connectors/approvals";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorRequest,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const gate = await openConnectorRequest(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const approval = await getApprovalForOwner(gate.auth, id);
    return connectorJson({ approval }, gate.requestId);
  } catch (error) {
    if (error instanceof ApprovalStepError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
