import { getConsoleApiAuthState } from "@/lib/auth/session";
import { consoleBrowserOrigin } from "@/lib/auth/console-origin";
import { requestOrganizationRef } from "@/server/console/request-workspace";
import { getConsoleWorkspace } from "@/server/console/workspace";
import { handlePolicyRequest } from "@/server/console/authorization/http";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ segments?: string[] }> };

async function handle(request: NextRequest, context: Context) {
  const { segments = [] } = await context.params;
  return handlePolicyRequest(request, segments, {
    canonicalOrigin: consoleBrowserOrigin,
    authenticate: async () => {
      const auth = await getConsoleApiAuthState();
      if (!auth || auth.mode === "anonymous") return null;
      const workspace = await getConsoleWorkspace(auth, { organizationRef: requestOrganizationRef(request) });
      // Current DB policy, not role from browser or the static settings-feature gate,
      // decides who may edit policy. Organization membership is only identity here.
      return { userId: workspace.user.id, organizationId: workspace.organization.id };
    },
  });
}
export const GET = handle;
export const POST = handle;
