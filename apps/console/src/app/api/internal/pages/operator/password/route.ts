import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  configurePagesPasswordPolicy,
  disablePagesPasswordPolicy,
  getPagesPasswordPolicyStatus,
} from "@/server/console/pages/password-access";
import {
  getPagesResolveControlToken,
  authorizePagesResolveRequest,
} from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 2_048;

type PasswordBody = {
  action?: unknown;
  host?: unknown;
  pagesSession?: unknown;
  password?: unknown;
  path?: unknown;
  scope?: unknown;
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) return json({ status: "error", error: "control_token_not_configured" }, 503, requestId);
  if (!authorizePagesResolveRequest(request, token)) {
    const limited = isRateLimited({
      key: rateLimitKey(request, "pages-operator-password-unauthorized"),
      limit: 30,
      windowMs: 60_000,
    });
    return json({ status: "error", error: limited ? "rate_limited" : "unauthorized" }, limited ? 429 : 401, requestId);
  }

  let body: PasswordBody;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ status: "error", error: "invalid_request" }, 400, requestId);
    }
    body = JSON.parse(rawBody) as PasswordBody;
  } catch {
    return json({ status: "error", error: "invalid_json" }, 400, requestId);
  }

  const action = typeof body.action === "string" ? body.action : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const pagesSession = typeof body.pagesSession === "string" ? body.pagesSession.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const scope = body.scope === "site" ? "site" as const : "route" as const;
  if (!host || !pagesSession || !path.startsWith("/")) {
    return json({ status: "error", error: "invalid_request" }, 400, requestId);
  }

  try {
    if (action === "status") {
      const result = await getPagesPasswordPolicyStatus({ host, pagesSession, path, requestId, scope });
      return json({ status: "ok", ...result }, 200, requestId);
    }
    if (action === "set") {
      const policy = await configurePagesPasswordPolicy({ host, pagesSession, password, path, requestId, scope });
      return json({ status: "ok", policy }, 200, requestId);
    }
    if (action === "disable") {
      const result = await disablePagesPasswordPolicy({ host, pagesSession, path, requestId, scope });
      return json({ status: "ok", ...result }, 200, requestId);
    }
    return json({ status: "error", error: "invalid_action" }, 400, requestId);
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return json({ status: "error", ...error.payload }, error.status, requestId);
    }
    console.error("Ravi Pages operator password request failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError" },
      requestId,
    });
    return json({ status: "error", error: "password_request_failed" }, 503, requestId);
  }
}

function json(payload: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}
