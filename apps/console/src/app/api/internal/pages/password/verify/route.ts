import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  getPagesResolveControlToken,
  authorizePagesResolveRequest,
} from "@/server/console/pages/resolve";
import {
  pagesPasswordSessionCookie,
  verifyPagesPasswordAndCreateSession,
} from "@/server/console/pages/password-access";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_048;

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    return response({ status: "error", error: "control_token_not_configured" }, 503, requestId);
  }
  if (!authorizePagesResolveRequest(request, token)) {
    const limited = isRateLimited({
      key: rateLimitKey(request, "pages-password-verify-unauthorized"),
      limit: 30,
      windowMs: 60_000,
    });
    return response({ status: "error", error: limited ? "rate_limited" : "unauthorized" }, limited ? 429 : 401, requestId);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return response({ status: "error", error: "invalid_request" }, 400, requestId);
  }

  let body: { host?: unknown; password?: unknown; path?: unknown };
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return response({ status: "error", error: "invalid_request" }, 400, requestId);
    }
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return response({ status: "error", error: "invalid_json" }, 400, requestId);
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!host || !password || !path.startsWith("/")) {
    return response({ status: "error", error: "invalid_request" }, 400, requestId);
  }

  if (isRateLimited({
    key: `${rateLimitKey(request, "pages-password-verify")}:${host}:${path.slice(0, 256)}`,
    limit: 8,
    windowMs: 5 * 60_000,
  })) {
    return response({ status: "error", error: "rate_limited" }, 429, requestId);
  }

  try {
    const session = await verifyPagesPasswordAndCreateSession({
      host,
      password,
      path,
      requestId,
    });
    if (!session) {
      return response({ status: "error", error: "invalid_credentials" }, 401, requestId);
    }
    return response({
      status: "ok",
      cookie: pagesPasswordSessionCookie(session.sessionToken, session.expiresAt),
      expiresAt: session.expiresAt.toISOString(),
    }, 200, requestId);
  } catch (error) {
    console.error("Ravi Pages password verification failed", {
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError" },
      host,
      path,
      requestId,
    });
    return response({ status: "error", error: "password_verification_failed" }, 503, requestId);
  }
}

function response(payload: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
}
