/**
 * POST /api/internal/connectors/org/installations
 *
 * The computers signed in to `ravi` in the organization, with the member on
 * each, for choosing where an organization account may be used. Console-owned
 * metadata, for owners and admins, and for a member who manages an
 * organization account: the Worker says whether they manage one (its list
 * for them is not empty); anyone else is refused. A read.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listOrgConnections } from "@/server/connectors/console-client";
import { listOrganizationInstallations } from "@/server/connectors/installations";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  isConnectorAdminRole,
  openConnectorMemberRoute,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const gate = await openConnectorMemberRoute(request, "read");
  if (gate instanceof NextResponse) return gate;

  try {
    const admin = isConnectorAdminRole(gate.member.role);
    const managesAnAccount = !admin && (await listOrgConnections(gate.member)).length > 0;
    if (!admin && !managesAnAccount) return connectorJsonError(403, "connector_forbidden", gate.requestId);
    const installations = await listOrganizationInstallations(gate.workspace, { managesAnAccount });
    return connectorJson({ installations }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
