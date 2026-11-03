/**
 * POST /api/internal/connectors/consent/list
 *
 * "Agents that can use your account" on /connectors: the agents the person
 * allowed to use their accounts when they ask, in the selected organization.
 * A read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listConsentGrants } from "@/server/connectors/console-client";
import { connectorErrorResponse, connectorJson, openConnectorRoute } from "@/server/connectors/internal-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gate = await openConnectorRoute(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const grants = await listConsentGrants(gate.actor);
    return connectorJson({ grants }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
