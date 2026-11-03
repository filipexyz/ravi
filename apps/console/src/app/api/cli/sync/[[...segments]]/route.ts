import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  ackCloudSyncEvents,
  downloadCloudSyncEvents,
  uploadCloudSyncEvents,
  type DataPlaneWorkspace,
} from "@/server/console/data-plane";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    requireScope(auth, "console.sync.read");

    if (!matches(segments, "events")) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown sync CLI route.");
    }

    const searchParams = new URL(request.url).searchParams;
    const domain = searchParams.get("domain");
    if (!domain) throw cliApiError(400, "PAYLOAD_INVALID", "Sync download requires a domain.");

    return cliSuccess(
      await downloadCloudSyncEvents({
        cursor: parseCursor(searchParams.get("cursor")),
	        domain,
	        limit: parseLimit(searchParams.get("limit")),
	        projectRef: searchParams.get("projectId") ?? searchParams.get("projectRef"),
	        scope: searchParams.get("scope"),
	        workspace: workspaceFromCliAuth(auth),
	      }),
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    const workspace = workspaceFromCliAuth(auth);

    if (matches(segments, "events")) {
      requireScope(auth, "console.sync.write");
      return cliSuccess(
        await uploadCloudSyncEvents({
          body: await readJsonBody(request, requestId),
          requestId,
          workspace,
        }),
        { status: 202 },
      );
    }

    if (matches(segments, "ack")) {
      requireScope(auth, "console.sync.read");
      return cliSuccess(
        await ackCloudSyncEvents({
          body: await readJsonBody(request, requestId),
          workspace,
        }),
      );
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown sync CLI route.");
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function workspaceFromCliAuth(auth: CliAuthContext): DataPlaneWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
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

function parseCursor(value: string | null) {
  if (!value) return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Invalid sync cursor.");
  }
  return cursor;
}

function parseLimit(value: string | null) {
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Invalid sync limit.");
  }
  return limit;
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}
