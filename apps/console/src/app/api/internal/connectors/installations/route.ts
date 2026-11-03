/**
 * POST /api/internal/connectors/installations
 *
 * "Your computers" on /connectors: the signed-in person's active `ravi`
 * installations in the selected organization. A read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listOwnInstallations } from "@/server/connectors/installations";
import { connectorErrorResponse, connectorJson, openConnectorRoute } from "@/server/connectors/internal-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gate = await openConnectorRoute(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const installations = await listOwnInstallations(gate.workspace);
    return connectorJson({ installations }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
