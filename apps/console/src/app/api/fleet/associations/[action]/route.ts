import type { NextRequest } from "next/server";
import { getOidcOrigin } from "@/lib/auth/oidc-config";
import { nodeManagementService } from "@/server/console/fleet/node-runtime";
import { boundedJson, fleetFailure, fleetJson } from "@/server/console/fleet/node-http";
import { FleetError } from "@/server/console/fleet/contract";
export const runtime = "nodejs";
/** This creates a pending request only; it cannot approve or administer anything. */
export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  try {
    if (request.headers.has("origin") && request.headers.get("origin") !== getOidcOrigin()) throw new FleetError("forbidden", 403);
    const action = (await context.params).action;
    if (!["start", "poll"].includes(action)) throw new FleetError("not_found", 404);
    const body = await boundedJson(request), service = nodeManagementService();
    return fleetJson(action === "start" ? await service.startAssociation(body) : await service.pollAssociation(body));
  } catch (error) { return fleetFailure(error); }
}
