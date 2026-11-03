import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  createCliMcpBridge,
  listCliMcpBridges,
  revokeCliMcpBridge,
} from "@/server/cli/mcp";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    if (matches(segments, "bridges")) {
      const projectRef = new URL(request.url).searchParams.get("project");
      if (!projectRef) throw cliApiError(400, "PAYLOAD_INVALID");
      return cliSuccess(await listCliMcpBridges({ auth, projectRef }));
    }
    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown MCP CLI route.");
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    if (matches(segments, "bridges")) {
      const body = await readJsonBody(request, requestId);
      const projectRef = projectRefFromBody(body);
      return cliSuccess(
        await createCliMcpBridge({ auth, projectRef, body }),
        { status: 201 },
      );
    }
    if (segments.length === 3 && segments[0] === "bridges" && segments[2] === "revoke") {
      return cliSuccess(await revokeCliMcpBridge({ auth, bridgeId: segments[1]! }));
    }
    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown MCP CLI route.");
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function matches(segments: string[], ...expected: string[]) {
  return segments.length === expected.length && expected.every((part, index) => segments[index] === part);
}

function projectRefFromBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }
  const projectRef = (body as Record<string, unknown>).projectRef ?? (body as Record<string, unknown>).projectId;
  if (typeof projectRef !== "string" || !projectRef.trim()) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }
  return projectRef;
}
