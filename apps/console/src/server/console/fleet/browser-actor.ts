import type { NextRequest } from "next/server";
import { getConsoleApiAuthState } from "@/lib/auth/session";
import { getConsoleWorkspace } from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import { FleetError, type FleetActor } from "./contract";

export async function fleetBrowserActor(request: NextRequest): Promise<FleetActor> {
  const auth = await getConsoleApiAuthState();
  if (!auth?.oidc?.sessionId) throw new FleetError("auth_required", 401);
  if (auth.mode !== "oidc") throw new FleetError("forbidden", 403);
  const workspace = await getConsoleWorkspace(auth, { organizationRef: requestOrganizationRef(request) });
  return { mode: workspace.mode, organizationId: workspace.organization.id, userId: workspace.user.id,
    role: workspace.membership.role, sessionId: auth.oidc.sessionId };
}
