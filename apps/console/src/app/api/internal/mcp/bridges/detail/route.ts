import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getConsoleAuthState } from "@/lib/auth/session";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { getConsoleMcpBridge } from "@/server/mcp/console-client";

export const runtime = "nodejs";

const bodySchema = z.object({
  projectRef: z.string().min(1).max(200),
  bridgeId: z.string().uuid(),
});

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const authState = await getConsoleAuthState();
  if (!authState) return jsonError(401, "unauthorized", requestId);

  const parsed = await parseBody(request);
  if (!parsed) return jsonError(400, "payload_invalid", requestId);

  const workspace = await getInternalSelectedConsoleWorkspace(authState, requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await assertInternalConsoleFeature(workspace, "console.connectors", requestId);
  if (featureError) return featureError;

  const project = await findAccessibleProjectRecord(workspace, parsed.projectRef, "read");
  if (!project) return jsonError(404, "project_not_found", requestId);

  const bridge = await getConsoleMcpBridge(
    { userId: workspace.user.id, organizationId: workspace.organization.id },
    { projectId: project.id, bridgeId: parsed.bridgeId },
  );
  if (!bridge) return jsonError(404, "bridge_not_found", requestId);

  return NextResponse.json(
    { status: "ok", bridge },
    { status: 200, headers: { "x-request-id": requestId } },
  );
}

async function parseBody(request: Request) {
  try {
    return bodySchema.parse(await request.json());
  } catch {
    return null;
  }
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
