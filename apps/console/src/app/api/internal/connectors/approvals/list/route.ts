/**
 * POST /api/internal/connectors/approvals/list
 *
 * "Waiting for you" on /connectors: the writes agents asked to run with the
 * person's accounts in the selected organization, still pending. Summaries
 * only, never the preview. A read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listApprovals } from "@/server/connectors/console-client";
import { connectorErrorResponse, connectorJson, openConnectorRoute } from "@/server/connectors/internal-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gate = await openConnectorRoute(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const approvals = await listApprovals(gate.actor);
    return connectorJson({ approvals }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
