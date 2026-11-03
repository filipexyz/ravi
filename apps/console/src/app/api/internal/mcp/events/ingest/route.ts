import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyMcpHmacRequest } from "@/server/mcp/internal-hmac";
import { ingestBridgeEvents } from "@/server/mcp/write";

export const runtime = "nodejs";

const eventSchema = z.object({
  bridgeId: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  eventType: z.enum([
    "connect",
    "disconnect",
    "initialize",
    "tools_list",
    "tools_call",
    "resources_read",
    "prompts_get",
    "error",
    "daemon_offline",
    "rate_limited",
  ]),
  toolName: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  tokensInput: z.number().int().nonnegative().nullable().optional(),
  tokensOutput: z.number().int().nonnegative().nullable().optional(),
  costEstimateUsd: z.string().max(40).nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  statusClass: z.enum(["ok", "client_error", "server_error", "upstream_unavailable"]),
  requestId: z.string().min(1).max(200),
  oauthClientId: z.string().uuid().nullable().optional(),
  clientUserAgent: z.string().max(500).nullable().optional(),
  occurredAt: z.string().datetime().optional(),
});

const bodySchema = z.object({
  events: z.array(eventSchema).max(100),
});

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const bodyText = await request.text();

  try {
    await verifyMcpHmacRequest({ request, bodyText });
  } catch {
    return jsonError(401, "mcp_unauthorized", requestId);
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(bodyText ? JSON.parse(bodyText) : {});
  } catch {
    return jsonError(400, "payload_invalid", requestId);
  }

  const result = await ingestBridgeEvents({
    events: parsed.events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt ? new Date(event.occurredAt) : undefined,
    })),
  });
  return NextResponse.json(
    { status: "ok", ...result },
    { status: 202, headers: { "x-request-id": requestId } },
  );
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
