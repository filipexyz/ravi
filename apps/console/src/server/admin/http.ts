import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authorizeAdminRequest, getAdminToken } from "@/server/admin/auth";
import { ConsoleApiError } from "@/server/console/api-error";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export type AdminGateOk = {
  requestId: string;
};

export function adminRequestId(request: Request) {
  return request.headers.get("x-request-id") ?? randomUUID();
}

export function gateAdminRequest(
  request: Request,
  options: { rateLimitName: string; missingTokenLog: string },
): { ok: true; requestId: string } | { ok: false; response: NextResponse } {
  const requestId = adminRequestId(request);
  const token = getAdminToken();
  if (!token) {
    console.error(options.missingTokenLog, { requestId });
    return {
      ok: false,
      response: adminJson({ status: "error", code: "admin_token_not_configured", requestId }, 503, requestId),
    };
  }

  if (!authorizeAdminRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, options.rateLimitName), limit: 10, windowMs: 60_000 })) {
      return { ok: false, response: adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId) };
    }
    return { ok: false, response: adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId) };
  }

  return { ok: true, requestId };
}

export function adminJson(payload: unknown, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

export function adminErrorResponse(error: unknown, requestId: string, fallbackCode: string) {
  if (error instanceof ConsoleApiError) {
    return adminJson(
      {
        status: "error",
        code: error.payload.error,
        fieldErrors: error.payload.fieldErrors,
        requestId,
      },
      error.status,
      requestId,
    );
  }

  console.error(fallbackCode, {
    requestId,
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : "unknown",
  });
  return adminJson({ status: "error", code: fallbackCode, requestId }, 500, requestId);
}
