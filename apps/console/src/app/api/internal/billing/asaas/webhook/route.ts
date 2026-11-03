import { randomUUID } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { handleAsaasWebhook } from "@/server/console/billing/asaas-webhook";
import { readBoundedText } from "@/server/console/billing/route-body";

// Payment notifications from the payment provider (console/billing/contracts).
// Public path: the shared token in `asaas-access-token` authenticates it.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const raw = await readBoundedText(request, MAX_BODY_BYTES).catch(() => "");
  if (raw === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let body: unknown = null;
  try {
    body = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  try {
    const result = await handleAsaasWebhook({
      token: request.headers.get("asaas-access-token"),
      body,
      requestId,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // A non-2xx answer makes the provider retry; the event row was not committed as processed.
    console.error("Payment webhook failed", { error, requestId });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
