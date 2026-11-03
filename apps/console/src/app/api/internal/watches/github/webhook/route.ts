import { type NextRequest } from "next/server";

import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import {
  getGithubWebhookSecret,
  parseGithubWebhookBody,
  processGithubWebhook,
  verifyGithubWebhookSignature,
} from "@/server/console/github-webhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const secret = getGithubWebhookSecret();
    if (!secret) {
      throw cliApiError(503, "WEBHOOK_UNHEALTHY", "GitHub webhook secret is not configured.");
    }

    const signature = request.headers.get("x-hub-signature-256");
    const deliveryId = request.headers.get("x-github-delivery")?.trim();
    const eventName = request.headers.get("x-github-event")?.trim();
    if (!deliveryId || !eventName) {
      throw cliApiError(400, "PAYLOAD_INVALID", "GitHub webhook headers are missing.");
    }

    const body = await request.text();
    if (!verifyGithubWebhookSignature({ body, secret, signature })) {
      throw cliApiError(401, "AUTH_REQUIRED", "GitHub webhook signature is invalid.");
    }

    const payload = parseGithubWebhookBody(body);
    return cliSuccess(
      await processGithubWebhook({
        deliveryId,
        eventName,
        payload,
        requestId,
      }),
      { status: 202 },
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
