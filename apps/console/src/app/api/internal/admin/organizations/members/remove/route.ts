import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authorizeAdminRequest, getAdminToken } from "@/server/admin/auth";
import { removeAdminOrganizationMembership } from "@/server/admin/organizations";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getAdminToken();

  if (!token) {
    console.error("Admin organization member remove endpoint missing RAVI_ADMIN_TOKEN", { requestId });
    return json({ status: "error", code: "admin_token_not_configured", requestId }, 503, requestId);
  }

  if (!authorizeAdminRequest(request, token)) {
    if (
      isRateLimited({
        key: rateLimitKey(request, "admin-organization-members-remove-unauthorized"),
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
    const result = await removeAdminOrganizationMembership({ body, requestId });
    if (result.status === "not_found") {
      return json({ status: "error", code: result.code, requestId }, 404, requestId);
    }
    return json({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    if (error instanceof Error && error.name === "AdminOrganizationError") {
      return json({ status: "error", code: error.message, requestId }, 400, requestId);
    }
    console.error("Admin organization member remove failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "unknown",
    });
    return json({ status: "error", code: "organization_member_remove_failed", requestId }, 500, requestId);
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
