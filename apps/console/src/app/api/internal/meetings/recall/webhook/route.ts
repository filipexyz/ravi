import { type NextRequest } from "next/server";

import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import {
  getRecallWebhookSecret,
  parseRecallWebhookEvent,
  recallWebhookDeliveryId,
  verifyRecallWebhookSignature,
} from "@/server/console/meetings/recall";
import { processRecallWebhook, queueMeetingKnowledgeAfterWebhook } from "@/server/console/meetings/webhook";

export const runtime = "nodejs";
// The Knowledge transcript capture drains after the response, within this budget.
export const maxDuration = 300;

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const secret = getRecallWebhookSecret();
    if (!secret) throw cliApiError(503, "WEBHOOK_UNHEALTHY", "Recall webhook secret is not configured.");

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) throw cliApiError(413, "PAYLOAD_INVALID", "Webhook body is too large.");
    if (!verifyRecallWebhookSignature({ body, headers: request.headers, secret })) {
      throw cliApiError(401, "AUTH_REQUIRED", "Recall webhook signature is invalid.");
    }
    const deliveryId = recallWebhookDeliveryId(request.headers);
    const event = parseRecallWebhookEvent(body);
    if (!deliveryId || !event) throw cliApiError(400, "PAYLOAD_INVALID", "Recall webhook body is not a bot event.");

    const result = await processRecallWebhook({ deliveryId, event, requestId });
    // Never throws: the vendor gets its 202 whatever happens to the capture.
    await queueMeetingKnowledgeAfterWebhook(result, { requestId });
    // The vendor sees what it saw before: no organization or project ids.
    return cliSuccess(
      {
        deliveryId: result.deliveryId,
        duplicate: result.duplicate,
        matched: result.matched,
        meetingId: result.meetingId,
        status: result.status,
        notified: result.notified,
      },
      { status: 202 },
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
