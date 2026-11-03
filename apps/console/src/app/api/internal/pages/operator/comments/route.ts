import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import { mirrorPageCommentIntoRoom } from "@/server/console/pages/chat-rooms/service";
import { emitPageCommentCreated } from "@/server/console/pages/comment-events";
import {
  getPagesResolveControlToken,
  authorizePagesResolveRequest,
} from "@/server/console/pages/resolve";
import {
  createPagesOperatorComment,
  deletePagesOperatorComment,
  listPagesOperatorComments,
} from "@/server/console/pages/operator";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

type CommentsBody = {
  action?: unknown;
  body?: unknown;
  commentId?: unknown;
  host?: unknown;
  parentId?: unknown;
  pagesSession?: unknown;
  path?: unknown;
  target?: unknown;
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getPagesResolveControlToken();
  if (!token) {
    console.error("Ravi Pages operator comments endpoint is missing RAVI_PAGES_CONTROL_TOKEN", { requestId });
    return NextResponse.json(
      { status: "error", error: "control_token_not_configured" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }

  if (!authorizePagesResolveRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "pages-operator-comments-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json(
        { status: "error", error: "rate_limited" },
        { status: 429, headers: noStoreHeaders(requestId) },
      );
    }
    return NextResponse.json(
      { status: "error", error: "unauthorized" },
      { status: 401, headers: noStoreHeaders(requestId) },
    );
  }

  let body: CommentsBody;
  try {
    body = (await request.json()) as CommentsBody;
  } catch {
    return NextResponse.json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  const action = typeof body.action === "string" ? body.action : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const pagesSession = typeof body.pagesSession === "string" ? body.pagesSession.trim() : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!host || !pagesSession || !path.startsWith("/")) {
    return NextResponse.json(
      { status: "error", error: "invalid_request" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  }

  try {
    if (action === "list") {
      const result = await listPagesOperatorComments({
        host,
        pagesSession,
        path,
        requestId,
      });
      return NextResponse.json({ status: "ok", ...result }, { headers: noStoreHeaders(requestId) });
    }

    if (action === "create") {
      const commentBody = typeof body.body === "string" ? body.body : "";
      const result = await createPagesOperatorComment({
        body: commentBody,
        host,
        parentId: body.parentId,
        pagesSession,
        path,
        requestId,
        target: body.target,
      });
      await mirrorPageCommentIntoRoom({ host, path, comment: result.comment });
      await emitPageCommentCreated({ commentId: result.comment.id, host, requestId });
      return NextResponse.json({ status: "ok", ...result }, { status: 201, headers: noStoreHeaders(requestId) });
    }

    if (action === "delete") {
      const commentId = typeof body.commentId === "string" ? body.commentId : "";
      const result = await deletePagesOperatorComment({
        commentId,
        host,
        pagesSession,
        path,
        requestId,
      });
      return NextResponse.json({ status: "ok", ...result }, { headers: noStoreHeaders(requestId) });
    }

    return NextResponse.json(
      { status: "error", error: "invalid_action" },
      { status: 400, headers: noStoreHeaders(requestId) },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(
        { status: "error", ...error.payload },
        { status: error.status, headers: noStoreHeaders(requestId) },
      );
    }
    console.error("Ravi Pages operator comments request failed", { error, requestId });
    return NextResponse.json(
      { status: "error", error: "comments_request_failed" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }
}

function noStoreHeaders(requestId: string) {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
  };
}
