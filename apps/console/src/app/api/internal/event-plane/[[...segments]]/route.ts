import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  activateEventPlanePolicyVersion,
  authorizeEventPlaneControlRequest,
  ensureEventPlaneCrossAccountLink,
  ensureEventPlaneIdentity,
  ensureEventPlaneOrgBinding,
  EventPlaneControlError,
  getEventPlaneAuditSummary,
  getEventPlaneControlActor,
  getEventPlaneControlToken,
  getEventPlaneDesiredState,
  recordEventPlaneCredentialGrant,
  recordEventPlaneReconciliationReport,
  registerEventPlaneCell,
  transitionEventPlaneOrgBinding,
} from "@/server/console/event-plane";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";
import type { EventPlaneControlActor } from "@/server/console/event-plane";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const segments = (await context.params).segments ?? [];
  const path = segments.join("/");
  const auth = authorizeControlRequest(request, requestId);
  if (!auth.ok) return auth.response;

  try {
    if (path === "" || path === "desired-state") {
      const url = new URL(request.url);
      return ok(
        await getEventPlaneDesiredState({
          organizationId: url.searchParams.get("organizationId"),
        }),
        requestId,
      );
    }
    if (path === "audit-summary") {
      return ok(await getEventPlaneAuditSummary(), requestId);
    }
    return error(404, "event_plane_route_not_found", requestId);
  } catch (err) {
    return handleError(err, requestId, path);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const segments = (await context.params).segments ?? [];
  const path = segments.join("/");
  const auth = authorizeControlRequest(request, requestId);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return error(400, "invalid_json", requestId);
  }

  try {
    if (path === "cells/register") {
      return ok(await registerEventPlaneCell({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "bindings/ensure") {
      return ok(await ensureEventPlaneOrgBinding({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "bindings/transition") {
      return ok(await transitionEventPlaneOrgBinding({ actor: auth.actor, body, requestId }), requestId);
    }
    if (path === "identities/ensure") {
      return ok(await ensureEventPlaneIdentity({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "credential-grants/record") {
      return ok(await recordEventPlaneCredentialGrant({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "policies/activate") {
      return ok(await activateEventPlanePolicyVersion({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "cross-account-links/ensure") {
      return ok(await ensureEventPlaneCrossAccountLink({ actor: auth.actor, body, requestId }), requestId, 201);
    }
    if (path === "reconciliations/report") {
      return ok(await recordEventPlaneReconciliationReport({ actor: auth.actor, body, requestId }), requestId);
    }
    return error(404, "event_plane_route_not_found", requestId);
  } catch (err) {
    return handleError(err, requestId, path);
  }
}

function authorizeControlRequest(
  request: Request,
  requestId: string,
): { ok: true; actor: EventPlaneControlActor } | { ok: false; response: NextResponse } {
  const token = getEventPlaneControlToken();
  if (!token) {
    console.error("Event Plane endpoint missing RAVI_EVENT_PLANE_CONTROL_TOKEN", { requestId });
    return { ok: false, response: error(503, "event_plane_control_token_not_configured", requestId) };
  }

  if (!authorizeEventPlaneControlRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "event-plane-control-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return { ok: false, response: error(429, "rate_limited", requestId) };
    }
    return { ok: false, response: error(401, "unauthorized", requestId) };
  }

  try {
    return { ok: true, actor: getEventPlaneControlActor() };
  } catch {
    return { ok: false, response: error(503, "event_plane_control_actor_invalid", requestId) };
  }
}

async function readJson(request: Request) {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function handleError(err: unknown, requestId: string, path: string) {
  if (err instanceof EventPlaneControlError) {
    return error(err.status, err.code, requestId);
  }
  console.error("Event Plane internal route failed", {
    requestId,
    path,
    name: err instanceof Error ? err.name : "unknown",
  });
  return error(500, "event_plane_internal_error", requestId);
}

function ok(payload: unknown, requestId: string, status = 200) {
  return NextResponse.json(
    { status: "ok", requestId, ...objectPayload(payload) },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    },
  );
}

function error(status: number, code: string, requestId: string) {
  return NextResponse.json(
    { status: "error", code, requestId },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    },
  );
}

function objectPayload(payload: unknown) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { result: payload };
}
