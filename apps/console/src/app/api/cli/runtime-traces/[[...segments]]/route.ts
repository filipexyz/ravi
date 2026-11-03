import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ingestRuntimeTraceBatch, type DataPlaneWorkspace } from "@/server/console/data-plane";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

const MAX_RUNTIME_TRACE_BODY_BYTES = 5 * 1024 * 1024;
const RUNTIME_TRACE_WRITE_ROLES = new Set(["owner", "admin", "developer"]);

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    requireScope(auth, "console.runtime-traces.write");

    if (!matches(segments, "events")) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown runtime traces CLI route.");
    }

    return cliSuccess(
      await ingestRuntimeTraceBatch({
        body: await readJsonBody(request, requestId, { maxBytes: MAX_RUNTIME_TRACE_BODY_BYTES }),
        requestId,
        workspace: workspaceFromCliAuth(auth),
      }),
      { status: 202 },
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function workspaceFromCliAuth(auth: CliAuthContext): DataPlaneWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role || !RUNTIME_TRACE_WRITE_ROLES.has(role)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
    localInstallation: {
      id: auth.localInstallation.id,
      name: auth.localInstallation.name,
      capabilitiesJson: auth.scopes,
    },
  };
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}
