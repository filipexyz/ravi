/**
 * GET /api/internal/channels/hosts/health
 *
 * Console-side health preflight for channel-control and the configured Omni
 * host. The browser never talks to Omni directly.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getConsoleAuthState } from "@/lib/auth/session";
import {
  checkChannelsHealth,
  ConsoleChannelClientError,
  type ChannelActorContext,
} from "@/server/channels/console-client";
import { captureChannelApiError } from "@/server/channels/observability";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import type { ConsoleWorkspace } from "@/server/console/workspace";

export const runtime = "nodejs";

const CHANNEL_ADMIN_ROLES = new Set(["owner", "admin"]);

export async function GET(request: Request) {
  return handleHealth(request);
}

export async function POST(request: Request) {
  return handleHealth(request);
}

async function handleHealth(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const authState = await getConsoleAuthState();
  if (!authState) return jsonError(401, "unauthorized", requestId);

  const workspace = await getInternalSelectedConsoleWorkspace(authState, requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await assertInternalConsoleFeature(workspace, "console.channels", requestId);
  if (featureError) return featureError;

  if (!CHANNEL_ADMIN_ROLES.has(workspace.membership.role)) {
    return jsonError(403, "channel_permission_required", requestId);
  }

  try {
    const result = await checkChannelsHealth(actorFromWorkspace(workspace));
    return NextResponse.json(
      { status: "ok", ...result },
      { headers: { "x-request-id": requestId, "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ConsoleChannelClientError) {
      const status = error.status >= 500 ? 502 : error.status;
      await captureChannelApiError(error, {
        requestId,
        method: request.method,
        path: "/api/internal/channels/hosts/health",
        operation: "channels.hosts.health",
        status,
        code: error.code,
        details: error.details,
      });
      return jsonError(status, error.code, requestId);
    }
    await captureChannelApiError(error, {
      requestId,
      method: request.method,
      path: "/api/internal/channels/hosts/health",
      operation: "channels.hosts.health",
      status: 500,
      code: "internal_error",
    });
    return jsonError(500, "internal_error", requestId);
  }
}

function actorFromWorkspace(workspace: ConsoleWorkspace): ChannelActorContext {
  return {
    userId: workspace.user.id,
    organizationId: workspace.organization.id,
  };
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
