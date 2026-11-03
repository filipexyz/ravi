/**
 * Console-internal WhatsApp channel management API.
 *
 * Browser -> Vercel stays on normal Console auth. Vercel -> channel-control
 * Worker is HMAC-signed, and Omni credentials stay inside Cloudflare.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getConsoleAuthState } from "@/lib/auth/session";
import {
  commandWhatsappInstance,
  ConsoleChannelClientError,
  createWhatsappInstance,
  listWhatsappInstances,
  pairWhatsappInstance,
  requestWhatsappQr,
  showWhatsappInstance,
  type ChannelActorContext,
} from "@/server/channels/console-client";
import { captureChannelApiError } from "@/server/channels/observability";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import type { ConsoleWorkspace } from "@/server/console/workspace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

const CHANNEL_ADMIN_ROLES = new Set(["owner", "admin"]);
const INSTANCE_ACTIONS = new Set([
  "connect",
  "disconnect",
  "restart",
  "logout",
  "rotate-key",
  "disable",
  "delete",
]);

const createBodySchema = z.object({
  clientRequestId: z.string().trim().min(1).max(200).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
});

const actionBodySchema = z.object({
  clientRequestId: z.string().trim().min(1).max(200).optional(),
});

const pairBodySchema = z.object({
  clientRequestId: z.string().trim().min(1).max(200).optional(),
  phoneNumber: z.string().trim().min(5).max(40).optional(),
});

class PayloadInvalidError extends Error {
  constructor() {
    super("Invalid JSON payload.");
    this.name = "PayloadInvalidError";
  }
}

class IdempotencyRequiredError extends Error {
  constructor() {
    super("Idempotency key is required.");
    this.name = "IdempotencyRequiredError";
  }
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];
  const workspace = await getAuthorizedWorkspace(requestId);
  if (workspace instanceof NextResponse) return workspace;
  const actor = actorFromWorkspace(workspace);

  try {
    if (segments.length === 0) {
      const instances = await listWhatsappInstances(actor);
      return jsonOk({ instances }, requestId);
    }

    if (segments.length === 1) {
      const instance = await showWhatsappInstance(actor, segments[0]!);
      return jsonOk({ instance }, requestId);
    }

    if (segments.length === 2 && segments[1] === "qr") {
      const qr = await requestWhatsappQr(actor, segments[0]!);
      return jsonOk(qr, requestId, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return jsonError(404, "not_found", requestId);
  } catch (error) {
    return channelFailure(error, routeErrorContext("GET", segments, requestId));
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];
  const workspace = await getAuthorizedWorkspace(requestId);
  if (workspace instanceof NextResponse) return workspace;
  const actor = actorFromWorkspace(workspace);

  try {
    if (segments.length === 0) {
      const body = createBodySchema.parse(await readJsonBody(request));
      const instance = await createWhatsappInstance(actor, {
        displayName: body.displayName,
        clientRequestId: requiredClientRequestId(request, body.clientRequestId),
      });
      return jsonOk({ instance }, requestId, { status: 201 });
    }

    if (segments.length === 2 && segments[1] === "qr") {
      const qr = await requestWhatsappQr(actor, segments[0]!);
      return jsonOk(qr, requestId, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (segments.length === 2 && segments[1] === "pair") {
      const body = pairBodySchema.parse(await readJsonBody(request));
      const result = await pairWhatsappInstance(actor, segments[0]!, {
        clientRequestId: requiredClientRequestId(request, body.clientRequestId),
        phoneNumber: body.phoneNumber,
      });
      return jsonOk(result, requestId);
    }

    if (segments.length === 2 && INSTANCE_ACTIONS.has(segments[1]!)) {
      const body = actionBodySchema.parse(await readJsonBody(request));
      const result = await commandWhatsappInstance(
        actor,
        segments[0]!,
        segments[1]! as Parameters<typeof commandWhatsappInstance>[2],
        { clientRequestId: requiredClientRequestId(request, body.clientRequestId) },
      );
      return jsonOk(result, requestId);
    }

    return jsonError(404, "not_found", requestId);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof PayloadInvalidError) {
      return jsonError(400, "payload_invalid", requestId);
    }
    if (error instanceof IdempotencyRequiredError) {
      return jsonError(400, "channel_idempotency_required", requestId);
    }
    return channelFailure(error, routeErrorContext("POST", segments, requestId));
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];
  const workspace = await getAuthorizedWorkspace(requestId);
  if (workspace instanceof NextResponse) return workspace;
  const actor = actorFromWorkspace(workspace);

  try {
    if (segments.length !== 1) return jsonError(404, "not_found", requestId);
    const result = await commandWhatsappInstance(actor, segments[0]!, "delete", {
      clientRequestId: requiredClientRequestId(request),
    });
    return jsonOk(result, requestId);
  } catch (error) {
    if (error instanceof IdempotencyRequiredError) {
      return jsonError(400, "channel_idempotency_required", requestId);
    }
    return channelFailure(error, routeErrorContext("DELETE", segments, requestId));
  }
}

async function getAuthorizedWorkspace(requestId: string): Promise<ConsoleWorkspace | NextResponse> {
  const authState = await getConsoleAuthState();
  if (!authState) return jsonError(401, "unauthorized", requestId);
  const workspace = await getInternalSelectedConsoleWorkspace(authState, requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await assertInternalConsoleFeature(workspace, "console.channels", requestId);
  if (featureError) return featureError;
  if (!CHANNEL_ADMIN_ROLES.has(workspace.membership.role)) {
    return jsonError(403, "channel_permission_required", requestId);
  }
  return workspace;
}

function actorFromWorkspace(workspace: ConsoleWorkspace): ChannelActorContext {
  return {
    userId: workspace.user.id,
    organizationId: workspace.organization.id,
  };
}

function requestIdFrom(request: Request): string {
  return request.headers.get("x-request-id") ?? randomUUID();
}

function idempotencyKeyFrom(request: Request): string | undefined {
  return request.headers.get("idempotency-key")?.trim() || undefined;
}

function requiredClientRequestId(request: Request, clientRequestId?: string): string {
  const key = clientRequestId?.trim() || idempotencyKeyFrom(request);
  if (!key) throw new IdempotencyRequiredError();
  return key;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PayloadInvalidError();
  }
}

async function channelFailure(error: unknown, context: ReturnType<typeof routeErrorContext>): Promise<NextResponse> {
  if (error instanceof ConsoleChannelClientError) {
    const status = error.status >= 500 ? 502 : error.status;
    await captureChannelApiError(error, {
      ...context,
      status,
      code: error.code,
      details: error.details,
    });
    return jsonError(status, error.code, context.requestId);
  }
  await captureChannelApiError(error, { ...context, status: 500, code: "internal_error" });
  return jsonError(500, "internal_error", context.requestId);
}

function routeErrorContext(method: string, segments: string[], requestId: string) {
  return {
    requestId,
    method,
    path: `/api/internal/channels/whatsapp/instances/${segments.join("/")}`,
    operation: channelOperation(method, segments),
    instanceId: segments[0],
  };
}

function channelOperation(method: string, segments: string[]): string {
  if (method === "GET" && segments.length === 0) return "channels.whatsapp.instances.list";
  if (method === "POST" && segments.length === 0) return "channels.whatsapp.instances.create";
  if (method === "GET" && segments.length === 1) return "channels.whatsapp.instances.show";
  if (method === "GET" && segments[1] === "qr") return "channels.whatsapp.instances.qr";
  if (method === "POST" && segments[1]) return `channels.whatsapp.instances.${segments[1]}`;
  if (method === "DELETE") return "channels.whatsapp.instances.delete";
  return "channels.whatsapp.instances.unknown";
}

function jsonOk(
  payload: Record<string, unknown>,
  requestId: string,
  options: { headers?: Record<string, string>; status?: number } = {},
): NextResponse {
  return NextResponse.json(
    { ...payload, status: "ok" },
    {
      status: options.status,
      headers: {
        "x-request-id": requestId,
        ...options.headers,
      },
    },
  );
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
