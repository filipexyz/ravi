import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import { authorizePageChatSession } from "@/server/console/pages/chat/session";
import { pageChatEngineEnabled } from "@/server/console/pages/chat/engine";
import {
  authorizePagesResolveRequest,
  getPagesResolveControlToken,
} from "@/server/console/pages/resolve";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

type SessionBody = {
  host?: unknown;
  path?: unknown;
  pagesSession?: unknown;
  voice?: unknown;
};

/** The Pages Worker asks whether this viewer may open a Page Chat conversation on this route. */
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  if (!pageChatEngineEnabled()) return json({ error: "page_chat_engine_disabled" }, 503, requestId);
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Page Chat session endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return json({ error: "page_chat_unavailable" }, 503, requestId);
  }
  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-chat-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return json({ error: "page_chat_rate_limited" }, 429, requestId);
    }
    return json({ error: "page_chat_unauthorized" }, 401, requestId);
  }

  let body: SessionBody;
  try {
    body = (await request.json()) as SessionBody;
  } catch {
    return json({ error: "payload_invalid" }, 400, requestId);
  }
  if (typeof body.host !== "string" || typeof body.path !== "string") {
    return json({ error: "payload_invalid" }, 400, requestId);
  }

  try {
    const result = await authorizePageChatSession({
      host: body.host,
      path: body.path,
      pagesSession: typeof body.pagesSession === "string" ? body.pagesSession : null,
      voice: typeof body.voice === "string" ? body.voice : null,
      requestId,
    });
    return json(result, 200, requestId);
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return json({ error: error.payload.error }, error.status, requestId);
    }
    console.error("Page Chat session authorization failed", { error, requestId });
    return json({ error: "page_chat_unavailable" }, 503, requestId);
  }
}

function json(payload: unknown, status: number, requestId: string) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": requestId },
  });
}
