/**
 * POST /api/internal/connectors/installations/:id/revoke
 *
 * "Revoke" on a computer: signs out every `ravi` session on it and ends the
 * agent grants made there. Its owner or an organization owner or admin.
 */

import { NextResponse, type NextRequest } from "next/server";

import { InstallationRequestError, revokeLocalInstallation } from "@/server/connectors/installations";
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
  const gate = await openConnectorRoute(request);
  if (gate instanceof NextResponse) return gate;

  try {
    const result = await revokeLocalInstallation({ installationId: id, requestId: gate.requestId, workspace: gate.workspace });
    return connectorJson({ ...result }, gate.requestId);
  } catch (error) {
    if (error instanceof InstallationRequestError) return connectorJsonError(error.status, error.code, gate.requestId);
    return connectorErrorResponse(error, gate.requestId);
  }
}
