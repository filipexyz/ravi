import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authorizeAdminRequest, getAdminToken } from "@/server/admin/auth";
import { enqueueAdminManagedRuntimeOperation } from "@/server/admin/managed-runtime";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

const CONFLICT_CODES = new Set([
  "managed_runtime_already_running",
  "managed_runtime_already_stopped",
  "managed_runtime_idempotency_conflict",
  "managed_runtime_instance_deleted",
  "managed_runtime_project_binding_missing",
  "managed_runtime_retry_source_invalid",
  "managed_runtime_retry_source_missing",
  "managed_runtime_retry_state_invalid",
]);

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
        key: rateLimitKey(request, "admin-managed-runtime-operations-unauthorized"),
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
    const result = await enqueueAdminManagedRuntimeOperation({ body, requestId });
    if (result.status === "not_found") {
      return json({ status: "error", code: result.code, requestId }, 404, requestId);
    }
    if (result.status === "blocked") {
      return json({ status: "error", code: result.code, requestId }, 409, requestId);
    }
    return json({ status: "ok", requestId, result }, 202, requestId);
  } catch (error) {
    if (error instanceof Error && error.name === "AdminManagedRuntimeError") {
      const status = error.message === "managed_runtime_instance_not_found"
        ? 404
        : CONFLICT_CODES.has(error.message)
          ? 409
          : 400;
      return json({ status: "error", code: error.message, requestId }, status, requestId);
    }
    console.error("Admin managed runtime operation enqueue failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    return json({ status: "error", code: "managed_runtime_operation_enqueue_failed", requestId }, 500, requestId);
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
