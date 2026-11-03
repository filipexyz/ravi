import { createHash } from "node:crypto";

import type {
  MailOutboundSendContext,
  MailOutboundSendResult,
  MailProviderAdapter,
  MailProviderCapabilities,
} from "./provider-adapters";

export type CloudflareMailWorkerAdapterConfig = {
  controlToken: string;
  fetchImpl?: typeof fetch;
  workerUrl: string;
};

type WorkerOutboundSendResponse =
  | {
      status: "ok";
      acceptedAt?: string;
      deliveryEventRefHash?: string | null;
      providerMessageRefHash?: string | null;
    }
  | {
      status: "error";
      code?: string;
      providerErrorCode?: string;
      providerErrorMessage?: string;
    };

export function createCloudflareMailWorkerAdapterFromEnv(): MailProviderAdapter | null {
  const workerUrl = process.env.RAVI_MAIL_WORKER_URL?.trim();
  const controlToken = process.env.RAVI_MAIL_CONTROL_TOKEN?.trim();
  if (!workerUrl || !controlToken) return null;
  return createCloudflareMailWorkerAdapter({ workerUrl, controlToken });
}

export function createCloudflareMailWorkerAdapter(config: CloudflareMailWorkerAdapterConfig): MailProviderAdapter {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const workerBaseUrl = new URL(config.workerUrl);

  return {
    name: "cloudflare_email",
    capabilities: cloudflareMailCapabilities(),
    async sendOutbound(request, context?: MailOutboundSendContext): Promise<MailOutboundSendResult> {
      if (!context?.transientMessage) throw new Error("mail_provider_payload_missing");

      const response = await fetchImpl(new URL("/internal/outbound/send", workerBaseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
          "x-ravi-mail-message-id": request.messageId,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          messageId: request.messageId,
          idempotencyKey: request.idempotencyKey,
          from: request.from.address,
          to: request.to,
          ...(request.cc?.length ? { cc: request.cc } : {}),
          ...(request.bcc?.length ? { bcc: request.bcc } : {}),
          subject: context.transientMessage.subject,
          text: context.transientMessage.text,
        }),
      });

      const payload = (await response.json()) as WorkerOutboundSendResponse;
      if (!response.ok || payload.status !== "ok") {
        throw mailWorkerSendError("mail_worker_send_failed", response.status, payload);
      }

      return {
        providerAdapter: "cloudflare_email",
        providerMessageRefHash:
          payload.providerMessageRefHash ?? sha256Label(`cloudflare_email:${request.messageId}:accepted`),
        acceptedAt: payload.acceptedAt ?? new Date().toISOString(),
        deliveryEventRefHash: payload.deliveryEventRefHash ?? null,
      };
    },
  };
}

function mailWorkerSendError(reason: string, status: number, payload: WorkerOutboundSendResponse): Error {
  if (payload.status === "ok") return new Error(`${reason}:http_${status}`);
  const suffix = [payload.code, payload.providerErrorCode].filter(Boolean).join(":");
  const message = suffix ? `${reason}:http_${status}:${suffix}` : `${reason}:http_${status}`;
  return new Error(message);
}

function cloudflareMailCapabilities(): MailProviderCapabilities {
  return {
    inbound: true,
    outbound: true,
    attachments: true,
    maxMessageBytes: 10 * 1024 * 1024,
    maxRecipientsPerMessage: 50,
    customDomains: true,
    catchAll: true,
    subaddressing: true,
    suppressionEvents: false,
    deliveryEvents: false,
    rateLimitModel: "domain",
    costDimensions: [
      "mail.messages.inbound",
      "mail.messages.outbound",
      "mail.recipients.outbound",
      "mail.bytes.inbound",
      "mail.bytes.outbound",
      "mail.attachments.bytes_stored",
      "mail.parser.jobs",
      "mail.delivery.events",
      "mail.suppression.events",
    ],
    supportStatus: "beta",
  };
}

function sha256Label(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
