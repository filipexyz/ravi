import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getConsoleAuthState } from "@/lib/auth/session";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { createConsoleMcpBridge } from "@/server/mcp/console-client";

export const runtime = "nodejs";

const bodySchema = z.object({
  projectRef: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  allowedCapabilityClasses: z
    .array(z.enum(["read", "write", "destructive"]))
    .max(3)
    .optional(),
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

  const project = await findAccessibleProjectRecord(workspace, parsed.projectRef, "write");
  if (!project) return jsonError(404, "project_not_found", requestId);

  const result = await createConsoleMcpBridge(
    { userId: workspace.user.id, organizationId: workspace.organization.id },
    {
      projectId: project.id,
      name: parsed.name,
      description: parsed.description,
      allowedCapabilityClasses: parsed.allowedCapabilityClasses,
    },
  );

  return NextResponse.json(
    {
      status: "ok",
      bridge: {
        id: result.bridge.id,
        name: result.bridge.name,
        projectId: result.bridge.projectId,
        status: result.bridge.status,
        createdAt: result.bridge.createdAt.toISOString(),
      },
      bridgeToken: result.bridgeToken,
      bridgeUrl: result.bridgeUrl,
    },
    { status: 201, headers: { "x-request-id": requestId } },
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
