/**
 * POST /api/internal/connectors/admin/policy/set
 *   { provider, enabled?, writesAllowed?, sharedAllowed?, toolCeiling?: { capability, ceiling | null } }
 *
 * Changes the organization's rules for one connector. A ceiling change names
 * one tool; the Worker stores the whole map as sent, so the route reads the
 * policy as it is now and changes only that tool. A page loaded earlier then
 * can't erase another admin's ceiling. Owners and admins only, in their own
 * session; the Worker checks the role again and answers the new policy.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getOrgPolicy, setOrgPolicy, withToolCeiling, type ToolPolicy } from "@/server/connectors/console-client";
import {
  connectorCapabilitySchema,
  connectorErrorResponse,
  connectorJson,
  connectorJsonError,
  openConnectorAdminRoute,
  readConnectorBody,
} from "@/server/connectors/internal-api";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    provider: z.string().trim().min(1).max(60),
    enabled: z.boolean().optional(),
    writesAllowed: z.boolean().optional(),
    sharedAllowed: z.boolean().optional(),
    toolCeiling: z
      .object({
        capability: connectorCapabilitySchema,
        ceiling: z.enum(["needs_approval", "blocked"]).nullable(),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.enabled !== undefined ||
      body.writesAllowed !== undefined ||
      body.sharedAllowed !== undefined ||
      body.toolCeiling !== undefined,
  );

export async function POST(request: NextRequest) {
  const gate = await openConnectorAdminRoute(request);
  if (gate instanceof NextResponse) return gate;
  const body = await readConnectorBody(request, bodySchema);
  if (!body) return connectorJsonError(400, "payload_invalid", gate.requestId);

  try {
    let toolCeilings: Record<string, ToolPolicy> | undefined;
    if (body.toolCeiling) {
      const current = await getOrgPolicy(gate.admin, body.provider);
      const next = withToolCeiling(current, body.toolCeiling);
      if (!next) return connectorJsonError(400, "payload_invalid", gate.requestId);
      toolCeilings = next;
    }
    const policy = await setOrgPolicy(gate.admin, {
      enabled: body.enabled,
      provider: body.provider,
      sharedAllowed: body.sharedAllowed,
      toolCeilings,
      writesAllowed: body.writesAllowed,
    });
    return connectorJson({ policy }, gate.requestId);
  } catch (error) {
    return connectorErrorResponse(error, gate.requestId);
  }
}
