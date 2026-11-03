import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { pageChatCloseReportSchema, recordPageChatClose } from "@/server/console/pages/chat/usage";
import { pageChatEngineEnabled } from "@/server/console/pages/chat/engine";
import {
  authorizePagesResolveRequest,
  getPagesResolveControlToken,
} from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

/** The Pages Worker reports a finished Page Chat conversation's usage. Idempotent per conversation. */
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  if (!pageChatEngineEnabled()) return json({ error: "page_chat_engine_disabled" }, 503, requestId);
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Page Chat close endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return json({ error: "page_chat_unavailable" }, 503, requestId);
  }
  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-chat-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return json({ error: "page_chat_rate_limited" }, 429, requestId);
    }
    return json({ error: "page_chat_unauthorized" }, 401, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "payload_invalid" }, 400, requestId);
  }
  const parsed = pageChatCloseReportSchema.safeParse(body);
  if (!parsed.success) return json({ error: "payload_invalid" }, 400, requestId);

  try {
    const recorded = await recordPageChatClose({ report: parsed.data, requestId });
    if (!recorded) return json({ error: "page_chat_session_unknown" }, 404, requestId);
    return json({ ok: true }, 200, requestId);
  } catch (error) {
    console.error("Page Chat close report failed", { error, requestId });
    return json({ error: "page_chat_unavailable" }, 503, requestId);
  }
}

function json(payload: unknown, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": requestId },
  });
}
