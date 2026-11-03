/**
 * POST /api/internal/connectors/org/connections
 *
 * "Organization accounts" on /org/connectors: the organization's own
 * accounts (a support inbox, a shared calendar), each with the member who
 * manages it and its status. Never tokens or content. Any active member may
 * ask, with their role: the Worker answers owners and admins every account
 * and anyone else only the accounts they manage ("Accounts you manage"). A
 * read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listOrgConnections } from "@/server/connectors/console-client";
import { connectorErrorResponse, connectorJson, openConnectorMemberRoute } from "@/server/connectors/internal-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gate = await openConnectorMemberRoute(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const connections = await listOrgConnections(gate.member);
    return connectorJson({ connections }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
