import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { recordMailMessageReceivedInboxItem } from "@/server/console/agent-inbox";
import {
  authorizeMailInternalRequest,
  getMailInternalControlToken,
  ingestEncryptedInboundMail,
  type MailInternalEncryptedInboundIngestRequest,
} from "@/server/console/mail/internal-api";
import { isRateLimited, rateLimitKey } from "@/server/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const token = getMailInternalControlToken();
  if (!token) {
    console.error("Ravi Mail inbound ingest endpoint is missing RAVI_MAIL_CONTROL_TOKEN", { requestId });
    return NextResponse.json({ status: "error", code: "control_token_not_configured" }, { status: 503 });
  }

  if (!authorizeMailInternalRequest(request, token)) {
    if (isRateLimited({ key: rateLimitKey(request, "mail-message-ingest-unauthorized"), limit: 30, windowMs: 60_000 })) {
      return NextResponse.json({ status: "error", code: "rate_limited" }, { status: 429 });
    }

    return NextResponse.json({ status: "error", code: "unauthorized" }, { status: 401 });
  }

  let input: MailInternalEncryptedInboundIngestRequest;
  try {
    input = (await request.json()) as MailInternalEncryptedInboundIngestRequest;
  } catch {
    return NextResponse.json({ status: "error", code: "invalid_json" }, { status: 400 });
  }

  try {
    const payload = await ingestEncryptedInboundMail({
      input: {
        ...input,
        requestId: input.requestId ?? requestId,
      },
      hooks: {
        inbox: async (event) => {
          try {
            await recordMailMessageReceivedInboxItem(event);
          } catch (error) {
            console.error("Ravi Mail inbox item publish failed after message ingest", {
              error,
              mailboxId: event.mailboxId,
              messageId: event.messageId,
              organizationId: event.organizationId,
              requestId,
            });
          }
        },
      },
    });
    return NextResponse.json(payload, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(
        { status: "error", code: error.payload.error, fieldErrors: error.payload.fieldErrors },
        { status: error.status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
      );
    }

    console.error("Ravi Mail encrypted inbound ingest failed", { error, requestId });
    return NextResponse.json(
      { status: "error", code: "mail_message_ingest_failed" },
      { status: 503, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}
