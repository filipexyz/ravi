// The Bases cron (hourly, `vercel.json`): deletes idempotency records past
// `expires_at` from `base_operations`. The row ledger has no retention.
//
// HTTP: Vercel Cron (GET with `Bearer <CRON_SECRET>`; 503 when the secret is
// unset) or an operator (POST with the admin token).

import { timingSafeEqual } from "node:crypto";

import { adminJson, adminRequestId, gateAdminRequest } from "@/server/admin/http";
import { db } from "@/server/db";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

import { deleteExpiredBaseOperations } from "./idempotency";

export type BasesTickResult = { expiredOperations: number };

export async function runBasesTick(input: { now?: Date } = {}): Promise<BasesTickResult> {
  return { expiredOperations: await deleteExpiredBaseOperations(db, input.now ?? new Date()) };
}

export type BasesTickHttpDeps = {
  /** Defaults to `process.env.CRON_SECRET`. */
  cronSecret?: () => string | undefined;
  runTick?: () => Promise<BasesTickResult>;
};

export async function handleBasesTickHttp(request: Request, deps: BasesTickHttpDeps = {}): Promise<Response> {
  let requestId: string;
  if (request.method === "GET") {
    requestId = adminRequestId(request);
    const secret = (deps.cronSecret ?? (() => process.env.CRON_SECRET))()?.trim();
    if (!secret) {
      console.error("bases_tick_cron_secret_missing", { requestId });
      return adminJson({ status: "error", code: "cron_secret_not_configured", requestId }, 503, requestId);
    }
    if (!bearerMatches(request, secret)) {
      if (isRateLimited({ key: rateLimitKey(request, "bases-tick"), limit: 10, windowMs: 60_000 })) {
        return adminJson({ status: "error", code: "rate_limited", requestId }, 429, requestId);
      }
      return adminJson({ status: "error", code: "unauthorized", requestId }, 401, requestId);
    }
  } else {
    const gate = gateAdminRequest(request, { rateLimitName: "bases-tick", missingTokenLog: "bases_tick_admin_token_missing" });
    if (!gate.ok) return gate.response;
    requestId = gate.requestId;
  }

  try {
    const result = await (deps.runTick ?? runBasesTick)();
    return adminJson({ status: "ok", requestId, result }, 200, requestId);
  } catch (error) {
    console.error("bases_tick_failed", { requestId, name: error instanceof Error ? error.name : "unknown" });
    return adminJson({ status: "error", code: "bases_tick_failed", requestId }, 500, requestId);
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  const expected = Buffer.from(secret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
