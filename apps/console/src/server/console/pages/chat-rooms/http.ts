// Shared handler for the Pages Worker -> Console chat room routes
// (`/api/internal/pages/chat/rooms/**`): control token, JSON body, error codes.

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { pageChatEngineEnabled } from "../chat/engine";
import { authorizePagesResolveRequest, getPagesResolveControlToken } from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export type ChatRoomHandler = (body: unknown, requestId: string) => Promise<unknown>;

export async function handleChatRoomRequest(request: Request, handler: ChatRoomHandler) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  if (!pageChatEngineEnabled()) return json({ error: "page_chat_engine_disabled" }, 503, requestId);
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Page chat rooms are missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return json({ error: "chat_unavailable" }, 503, requestId);
  }
  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-chat-rooms-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return json({ error: "chat_rate_limited" }, 429, requestId);
    }
    return json({ error: "chat_session_required" }, 401, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "payload_invalid" }, 400, requestId);
  }
  try {
    return json(await handler(body, requestId), 200, requestId);
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      const payload: Record<string, unknown> = { error: error.payload.error };
      if (error.payload.fieldErrors) payload.fieldErrors = error.payload.fieldErrors;
      return json(payload, error.status, requestId);
    }
    console.error("Page chat room request failed", { requestId, error: error instanceof Error ? error.message : "error" });
    return json({ error: "chat_unavailable" }, 503, requestId);
  }
}

function json(payload: unknown, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": requestId },
  });
}
