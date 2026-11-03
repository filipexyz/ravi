import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  authorizeRuntimeControlRequest,
  claimRuntimeLease,
  getRuntimeControlToken,
  heartbeatRuntimeHost,
  ingestManagedRuntimeEvents,
  ManagedRuntimeError,
  registerRuntimeHost,
  registerRuntimeImage,
  requestRuntimeLease,
  revokeRuntimeLease,
  validateRuntimeLease,
} from "@/server/console/managed-runtime";
import {
  claimManagedInstanceOperation,
  reportManagedInstanceOperation,
} from "@/server/console/managed-instances";
import {
  claimManagedRaviCommand,
  reportManagedRaviCommand,
} from "@/server/console/managed-runtime-commands";
import { issueManagedRuntimeBootstrap } from "@/server/console/managed-bootstrap";
import { issueManagedControllerRotation } from "@/server/console/managed-controller-rotation";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const segments = (await context.params).segments ?? [];
  const path = segments.join("/");

  try {
    const body = await readJson(request);

    if (path === "leases/claim") {
      return ok(await claimRuntimeLease({ body, requestId }), requestId);
    }

    if (path === "leases/validate") {
      return ok(await validateRuntimeLease({ body, requestId }), requestId);
    }

    if (path === "events") {
      return ok(await ingestManagedRuntimeEvents({ body, requestId }), requestId, 202);
    }

    const authError = authorizeControlRequest(request, requestId);
    if (authError) return authError;

    if (path === "hosts/register") {
      return ok(await registerRuntimeHost({ body, requestId }), requestId, 201);
    }

    if (path === "hosts/heartbeat") {
      return ok(await heartbeatRuntimeHost({ body, requestId }), requestId);
    }

    if (path === "images/register") {
      return ok(await registerRuntimeImage({ body, requestId }), requestId, 201);
    }

    if (path === "leases/request") {
      return ok(await requestRuntimeLease({ body, requestId }), requestId, 201);
    }

    if (path === "leases/revoke") {
      return ok(await revokeRuntimeLease({ body, requestId }), requestId);
    }

    if (path === "operations/claim") {
      return ok(await claimManagedInstanceOperation({ body }), requestId);
    }

    if (path === "operations/report") {
      return ok(await reportManagedInstanceOperation({ body }), requestId);
    }

    if (path === "commands/claim") {
      return ok(await claimManagedRaviCommand({ body }), requestId);
    }

    if (path === "commands/report") {
      return ok(await reportManagedRaviCommand({ body }), requestId);
    }

    if (path === "bootstrap/issue") {
      return ok(await issueManagedRuntimeBootstrap({ body }), requestId, 201);
    }

    if (path === "controllers/rotation-grants/issue") {
      return ok(await issueManagedControllerRotation({ body }), requestId, 201);
    }

    return error(404, "runtime_route_not_found", requestId);
  } catch (err) {
    if (err instanceof ManagedRuntimeError) {
      return error(err.status, err.code, requestId);
    }
    if (err instanceof SyntaxError) {
      return error(400, "invalid_json", requestId);
    }
    console.error("Managed runtime internal route failed", {
      requestId,
      path,
      name: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : "unknown",
    });
    return error(500, "runtime_internal_error", requestId);
  }
}

function authorizeControlRequest(request: Request, requestId: string) {
  const token = getRuntimeControlToken();
  if (!token) {
    console.error("Managed runtime endpoint missing RAVI_RUNTIME_CONTROL_TOKEN", { requestId });
    return error(503, "runtime_control_token_not_configured", requestId);
  }

  if (!authorizeRuntimeControlRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "runtime-control-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return error(429, "rate_limited", requestId);
    }
    return error(401, "unauthorized", requestId);
  }

  return null;
}

async function readJson(request: Request) {
  const text = await request.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
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
