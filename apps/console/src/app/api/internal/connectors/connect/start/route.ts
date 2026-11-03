/**
 * POST /api/internal/connectors/connect/start
 *
 * "Connect", "Reconnect" and "Allow writing" on /connectors. The Worker
 * starts and continues in one step for the signed-in person, so the answer
 * carries the provider's sign-in URL and the browser goes straight there.
 * The answer marks this browser as the one that may finish the grant.
 * `projectRef` is no longer read: connections belong to a person.
 *
 * `scopeKind: "organization"` is "Connect organization account" on
 * /org/connectors: a new one is for owners and admins only, refused here
 * before the Worker hears of it. Reconnecting one is also for its manager,
 * whatever their role: the Worker decides whether they manage it. The
 * member's role goes along either way so the Worker checks too.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { bindConnectBrowser } from "@/server/connectors/connect-grants";
import { startConnect } from "@/server/connectors/console-client";
import {
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  isConnectorAdminRole,
  openConnectorRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";
import { CONNECTION_NAME_MAX_LENGTH } from "@/shared/integrations/connection-limits";

export const runtime = "nodejs";

const bodySchema = z.object({
  provider: z.string().trim().min(1).max(60),
  accessMode: z.enum(["full", "read_only"]).optional(),
  reconnectConnectionId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(CONNECTION_NAME_MAX_LENGTH).optional(),
  scopeKind: z.enum(["user", "organization"]).optional(),
});

export async function POST(request: NextRequest) {
  const gate = await openConnectorRoute(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  const { scopeKind, ...input } = body;
  const organization = scopeKind === "organization";
  const { membership } = gate.workspace;
  if (
    organization &&
    (membership.status !== "active" || (!input.reconnectConnectionId && !isConnectorAdminRole(membership.role)))
  ) {
    return connectorJsonError(403, "connector_forbidden", gate.requestId);
  }

  try {
    const result = await startConnect(gate.actor, {
      ...input,
      continueNow: true,
      origin: "ui",
      ...(organization ? { role: membership.role, scopeKind: "organization" as const } : {}),
    });
    // Only the provider's sign-in will do: a Console page URL here would send the browser in a loop.
    if (!result?.authorizationUrl || !result.pendingGrantId) {
      return connectorJsonError(502, "connector_service_unavailable", gate.requestId);
    }
    return bindConnectBrowser(
      connectorJson(
        { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt, pendingGrantId: result.pendingGrantId },
        gate.requestId,
        201,
      ),
      result.pendingGrantId,
    );
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
