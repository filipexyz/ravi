/**
 * POST /api/internal/connectors/org/shared
 *   { connectionId, installationId, agentId, conversations: ("dm" | "group")[] }
 *
 * Lets one agent on one computer use an organization account, only in the
 * conversations named. Its reads stay limited and its writes still wait for
 * the account's manager. In the person's own session; the Worker decides
 * whether they may (the account's manager, an owner or an admin) and that
 * shared accounts are allowed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { grantSharedUse } from "@/server/connectors/console-client";
import {
  agentIdSchema,
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorMemberRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z.object({
  connectionId: z.string().uuid(),
  installationId: z.string().uuid(),
  agentId: agentIdSchema,
  conversations: z
    .array(z.enum(["dm", "group"]))
    .min(1)
    .max(2)
    .transform((items) => [...new Set(items)]),
});

export async function POST(request: NextRequest) {
  const gate = await openConnectorMemberRoute(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    const { grantId } = await grantSharedUse(gate.member, body);
    return connectorJson({ grantId }, gate.requestId, 201);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
