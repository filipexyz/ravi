import type { NextRequest } from "next/server";
import { consoleOperations, type ConsoleOperationName } from "@ravi/operation-contracts/console";
import { getOidcOrigin } from "@/lib/auth/oidc-config";
import { fleetBrowserActor } from "@/server/console/fleet/browser-actor";
import { nodeManagementService } from "@/server/console/fleet/node-runtime";
import { boundedJson, fleetFailure, fleetJson } from "@/server/console/fleet/node-http";
import { FleetError } from "@/server/console/fleet/contract";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ segments: string[] }> }) {
  try {
    if (request.headers.get("origin") !== getOidcOrigin()) throw new FleetError("forbidden", 403);
    const actor = await fleetBrowserActor(request);
    const name = (await context.params).segments.join(".") as ConsoleOperationName;
    const descriptor = consoleOperations[name];
    if (!descriptor) throw new FleetError("not_found", 404);
    const body = await boundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "input")) throw new FleetError("invalid_request", 400);
    const input = descriptor.args[0]!.schema.safeParse((body as { input?: unknown }).input);
    if (!input.success) throw new FleetError("invalid_request", 400);
    const service = nodeManagementService();
    let value: unknown;
    switch (name) {
      case "channels.list": value = await service.channels(actor); break;
      case "installations.list": value = await service.list(actor); break;
      case "installations.revoke": value = await service.revoke(actor, input.data); break;
      case "associations.show": value = await service.association(actor, input.data); break;
      case "associations.approve": value = await service.approve(actor, input.data); break;
      case "operations.enqueue": value = await service.enqueue(actor, input.data); break;
      case "operations.latest": value = await service.latestOperation(actor, (input.data as { installationId: string }).installationId); break;
      case "operations.show": value = await service.showOperation(actor, (input.data as { operationId: string }).operationId); break;
      case "onboarding.state": value = await service.state(actor); break;
      case "onboarding.finish": value = await service.finish(actor, input.data); break;
    }
    return fleetJson(descriptor.returns.parse(value));
  } catch (error) { return fleetFailure(error); }
}
