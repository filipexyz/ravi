import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authorizeAdminRequest, getAdminToken } from "@/server/admin/auth";
import { rotateAdminManagedRuntimeController } from "@/server/admin/managed-runtime";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getAdminToken();
  if (!token) {
    console.error("Admin managed runtime endpoint missing RAVI_ADMIN_TOKEN", { requestId });
    return json({ status: "error", code: "admin_token_not_configured", requestId }, 503, requestId);
  }
  if (!authorizeAdminRequest(request, token)) {
    if (
      isRateLimited({
        key: rateLimitKey(request, "admin-managed-runtime-unauthorized"),
        limit: 10,
        windowMs: 60_000,
      })
    ) {
      return json({ status: "error", code: "rate_limited", requestId }, 429, requestId);
    }
    return json({ status: "error", code: "unauthorized", requestId }, 401, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ status: "error", code: "invalid_json", requestId }, 400, requestId);
  }

  try {
    const result = await rotateAdminManagedRuntimeController({ body, requestId });
    if (result.status === "not_found") {
      return json({ status: "error", code: result.code, requestId }, 404, requestId);
    }
    if (result.status === "blocked") {
      return json({ status: "error", code: result.code, requestId }, 409, requestId);
    }
    return json({ status: "ok", requestId, result }, 202, requestId);
  } catch (error) {
    if (error instanceof Error && error.name === "AdminManagedRuntimeError") {
      const status = error.message === "managed_runtime_idempotency_conflict" ? 409 : 400;
      return json({ status: "error", code: error.message, requestId }, status, requestId);
    }
    console.error("Admin managed runtime controller rotation failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    return json({ status: "error", code: "managed_runtime_controller_rotation_failed", requestId }, 500, requestId);
  }
}

function json(payload: unknown, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}
