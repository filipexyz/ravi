import {
  decryptMailWorkerPayload,
  encryptMailWorkerPayload,
  encryptRawMime as encryptRawMimeWithWebCrypto,
  isValidRootKeyBase64,
  type EncryptedMailPayload,
  type MailCipherRef,
  type MailEncryptionAad,
} from "./crypto";
import {
  mailAddressSummaryForOutbound,
  serializeMailAddressSummary,
} from "../../../src/server/console/mail/address-summary";
import {
  processEncryptedRawMimeParseJob,
  type MailParsedPayloadKind,
  type MailParseJobInput,
  type MailPersistParsedMessageInput,
} from "../../../src/server/console/mail/parser";
import {
  scanParsedMailWithModelArmor,
  type MailModelArmorEnv,
} from "./model-armor";

export type { EncryptedMailPayload, MailCipherRef, MailEncryptionAad } from "./crypto";

export interface MailWorkerEnv extends MailModelArmorEnv {
  RAVI_CONSOLE_API_URL: string;
  RAVI_MAIL_CONTROL_TOKEN?: string;
  RAVI_MAIL_INGEST_PATH?: string;
  RAVI_MAIL_ROUTE_RESOLVE_PATH?: string;
  RAVI_MAIL_ROOT_KEY_BASE64?: string;
  RAVI_MAIL_KEY_VERSION?: string;
  RAVI_MAIL_OBJECTS: MailR2Bucket;
  RAVI_MAIL_PARSE_QUEUE: MailQueue<MailParseQueueMessage>;
  RAVI_MAIL_USAGE_AUDIT_QUEUE: MailQueue<MailUsageAuditQueueMessage>;
  RAVI_MAIL_SEND_EMAIL?: MailSendEmailBinding;
}

export interface MailWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MailR2Bucket {
  delete?(keys: string | string[]): Promise<void>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: R2PutOptions): Promise<unknown>;
}

export interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface MailQueue<Message = unknown> {
  send(message: Message): Promise<void>;
}

export interface MailQueueBatch<Message = unknown> {
  messages: Array<{
    body: Message;
    ack(): void;
    retry(): void;
  }>;
}

export interface MailSendEmailBinding {
  send(message: MailSendEmailMessage): Promise<MailSendEmailResult | void>;
}

export type MailSendEmailMessage = {
  bcc?: string | string[];
  cc?: string | string[];
  from: string | { email: string; name: string };
  headers?: Record<string, string>;
  subject: string;
  text: string;
  to: string | string[];
};

export type MailSendEmailResult = {
  messageId?: string;
};

export interface MailWorkerEmailMessage {
  from: string;
  to: string;
  raw: ArrayBuffer | ArrayBufferView | string | ReadableStream;
  rawSize?: number;
  headers?: Headers;
  setReject(reason: string): void;
}

export type MailRawMimeEncryptor = (input: {
  plaintext: ArrayBuffer;
  aad: MailEncryptionAad;
  env: MailWorkerEnv;
}) => Promise<EncryptedMailPayload>;

export type MailParseQueueMessage = {
  schemaVersion: 1;
  source: "mail_worker";
  requestId: string;
  enqueuedAt: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  routeId: string;
  messageId: string;
  providerAdapter: "cloudflare_email";
  direction: "inbound";
  encryptedRawMime: {
    cipherRef: MailCipherRef;
    objectRef: string;
    keyVersion: string;
    sha256: string;
    sizeBytes: number;
  };
  envelope: {
    senderHash: string;
    recipientHash: string;
    rawSizeBytes: number;
  };
};

export type MailUsageAuditQueueMessage = {
  schemaVersion: 1;
  source: "mail_worker";
  requestId: string;
  occurredAt: string;
  eventType: "mail.inbound.accepted";
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  routeId: string;
  messageId: string;
  providerAdapter: "cloudflare_email";
  direction: "inbound";
  metrics: {
    rawSizeBytes: number;
    encryptedSizeBytes: number;
  };
};

export type MailOutboundSendRequest = {
  schemaVersion: 1;
  bcc?: string[];
  cc?: string[];
  from: string;
  idempotencyKey?: string;
  messageId: string;
  subject: string;
  text: string;
  to: string[];
};

export type MailWorkerLogEvent =
  | {
      level: "warn";
      event:
        | "mail_worker_config_invalid"
        | "mail_outbound_auth_failed"
        | "mail_outbound_send_failed"
        | "mail_ingest_failed"
        | "mail_model_armor_auth_failed"
        | "mail_model_armor_misconfigured"
        | "mail_model_armor_quarantined"
        | "mail_parse_failed"
        | "mail_parse_exception";
      requestId: string;
      issues?: MailWorkerConfigIssue[];
      reason?: string;
      organizationId?: string;
      mailboxId?: string;
      routeId?: string;
      messageId?: string;
    }
  | {
      level: "info";
      event:
        | "mail_route_miss"
        | "mail_route_drop"
        | "mail_inbound_duplicate"
        | "mail_inbound_enqueued"
        | "mail_outbound_send_accepted"
        | "mail_parse_done";
      requestId: string;
      organizationId?: string;
      mailboxId?: string;
      routeId?: string;
      messageId?: string;
    };

type MailWorkerDependencies = {
  encryptRawMime?: MailRawMimeEncryptor;
  fetch?: typeof fetch;
  log?: (event: MailWorkerLogEvent) => void;
  now?: () => Date;
  randomUUID?: () => string;
};

type MailRouteResolveResult =
  | {
      ok: true;
      route: MailResolvedRoute;
      messageId?: string | null;
    }
  | {
      ok: false;
      reason: "route_not_found" | "route_rejected" | "console_unavailable";
    };

type MailResolvedRoute = {
  id: string;
  organizationId: string;
  projectId?: string | null;
  mailboxId: string;
  action?: "accept" | "drop" | "reject";
};

const DEFAULT_ROUTE_RESOLVE_PATH = "/api/internal/mail/routes/resolve";
const DEFAULT_INGEST_PATH = "/api/internal/mail/messages/ingest";

export type MailWorkerConfigIssue = {
  field: keyof MailWorkerEnv;
  code: "missing" | "invalid";
};

export type MailWorkerConfigValidation = {
  ok: boolean;
  issues: MailWorkerConfigIssue[];
  checks: {
    consoleApiUrl: boolean;
    controlToken: boolean;
    encryptionKey: boolean;
    r2ObjectsBinding: boolean;
    parseQueueBinding: boolean;
    usageAuditQueueBinding: boolean;
    sendEmailBinding: boolean;
  };
};

export function createMailWorker(dependencies: MailWorkerDependencies = {}) {
  const encryptRawMime = dependencies.encryptRawMime ?? encryptRawMimeWithWebCrypto;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const log = dependencies.log ?? defaultMailWorkerLogger;
  const now = dependencies.now ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const requiresEncryptionKey = !dependencies.encryptRawMime;

  return {
    async fetch(request: Request, env: MailWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/internal/outbound/send") {
        return handleOutboundSendRequest({
          env,
          log,
          now,
          randomUUID,
          request,
        });
      }

      if (url.pathname !== "/health" && url.pathname !== "/healthz") {
        return Response.json(
          {
            ok: false,
            service: "ravi-mail",
            error: "not_found",
          },
          { status: 404 },
        );
      }

      const validation = validateMailWorkerConfig(env, { requireEncryptionKey: true });
      return Response.json({
        ok: validation.ok,
        service: "ravi-mail",
        checks: validation.checks,
        issues: validation.issues,
      }, {
        status: validation.ok ? 200 : 503,
        headers: {
          "cache-control": "no-store",
        },
      });
    },

    async email(message: MailWorkerEmailMessage, env: MailWorkerEnv, ctx?: MailWorkerExecutionContext): Promise<void> {
      const requestId = randomUUID();
      const validation = validateMailWorkerConfig(env, { requireEncryptionKey: requiresEncryptionKey });
      if (!validation.ok) {
        log?.({
          level: "warn",
          event: "mail_worker_config_invalid",
          requestId,
          issues: validation.issues,
        });
        message.setReject("mail_worker_misconfigured");
        return;
      }

      const resolved = await resolveInboundRoute({
        env,
        fetchImpl,
        requestId,
        sender: message.from,
        recipient: message.to,
        rawSizeBytes: message.rawSize ?? 0,
      });

      if (!resolved.ok || resolved.route.action === "reject") {
        log?.({
          level: "info",
          event: "mail_route_miss",
          requestId,
        });
        message.setReject("mail_route_not_found");
        return;
      }
      if (resolved.route.action === "drop") {
        log?.({
          level: "info",
          event: "mail_route_drop",
          requestId,
          organizationId: resolved.route.organizationId,
          mailboxId: resolved.route.mailboxId,
          routeId: resolved.route.id,
        });
        return;
      }

      const messageId = resolved.messageId ?? randomUUID();
      const aad: MailEncryptionAad = {
        organizationId: resolved.route.organizationId,
        projectId: resolved.route.projectId ?? null,
        mailboxId: resolved.route.mailboxId,
        messageId,
        routeId: resolved.route.id,
        payloadKind: "raw_mime",
        keyVersionPurpose: "mail_message",
      };
      const objectRef = encryptedRawMimeObjectRef({
        organizationId: resolved.route.organizationId,
        mailboxId: resolved.route.mailboxId,
        messageId,
      });
      const plaintext = await readRawMime(message.raw);
      const encrypted = await encryptRawMime({
        plaintext,
        aad,
        env,
        ciphertextRef: objectRef,
      });

      await env.RAVI_MAIL_OBJECTS.put(objectRef, encrypted.ciphertext, {
        httpMetadata: {
          contentType: "application/octet-stream",
        },
        customMetadata: {
          organizationId: resolved.route.organizationId,
          mailboxId: resolved.route.mailboxId,
          messageId,
          routeId: resolved.route.id,
          payloadKind: "raw_mime",
          keyVersion: encrypted.keyVersion,
          ciphertextSha256: encrypted.sha256,
          requestId,
        },
      });

      const addressSummary = await encryptInboundAddressSummary({
        env,
        mailboxId: resolved.route.mailboxId,
        message,
        messageId,
        organizationId: resolved.route.organizationId,
        projectId: resolved.route.projectId ?? null,
        requestId,
        routeId: resolved.route.id,
      });

      const ingest = await ingestEncryptedInboundMessage({
        env,
        addressSummaryCipherRef: addressSummary.cipherRef,
        fetchImpl,
        requestId,
        route: resolved.route,
        message,
        messageId,
        rawMimeCipherRef: encrypted.cipherRef,
        rawSizeBytes: plaintext.byteLength,
      });
      if (!ingest.ok) {
        log?.({
          level: "warn",
          event: "mail_ingest_failed",
          requestId,
          organizationId: resolved.route.organizationId,
          mailboxId: resolved.route.mailboxId,
          routeId: resolved.route.id,
          messageId,
        });
        message.setReject("mail_ingest_failed");
        return;
      }
      if (!ingest.created) {
        if (ingest.messageId !== messageId) {
          await deleteDuplicateInboundObjects(env.RAVI_MAIL_OBJECTS, [
            objectRef,
            addressSummary.cipherRef.ciphertextRef,
          ]);
        }
        log?.({
          level: "info",
          event: "mail_inbound_duplicate",
          requestId,
          organizationId: resolved.route.organizationId,
          mailboxId: resolved.route.mailboxId,
          routeId: resolved.route.id,
          messageId: ingest.messageId,
        });
        return;
      }

      const enqueuedAt = now().toISOString();
      const parseMessage: MailParseQueueMessage = {
        schemaVersion: 1,
        source: "mail_worker",
        requestId,
        enqueuedAt,
        organizationId: resolved.route.organizationId,
        projectId: resolved.route.projectId ?? null,
        mailboxId: resolved.route.mailboxId,
        routeId: resolved.route.id,
        messageId,
        providerAdapter: "cloudflare_email",
        direction: "inbound",
        encryptedRawMime: {
          cipherRef: encrypted.cipherRef,
          objectRef,
          keyVersion: encrypted.keyVersion,
          sha256: encrypted.sha256,
          sizeBytes: encrypted.sizeBytes,
        },
        envelope: {
          senderHash: await sha256Hex(message.from.trim().toLowerCase()),
          recipientHash: await sha256Hex(message.to.trim().toLowerCase()),
          rawSizeBytes: plaintext.byteLength,
        },
      };
      await env.RAVI_MAIL_PARSE_QUEUE.send(parseMessage);

      const usageAuditMessage: MailUsageAuditQueueMessage = {
        schemaVersion: 1,
        source: "mail_worker",
        requestId,
        occurredAt: enqueuedAt,
        eventType: "mail.inbound.accepted",
        organizationId: resolved.route.organizationId,
        projectId: resolved.route.projectId ?? null,
        mailboxId: resolved.route.mailboxId,
        routeId: resolved.route.id,
        messageId,
        providerAdapter: "cloudflare_email",
        direction: "inbound",
        metrics: {
          rawSizeBytes: plaintext.byteLength,
          encryptedSizeBytes: encrypted.sizeBytes,
        },
      };
      const usageAuditSend = env.RAVI_MAIL_USAGE_AUDIT_QUEUE.send(usageAuditMessage);
      if (ctx) {
        ctx.waitUntil(usageAuditSend);
      } else {
        await usageAuditSend;
      }

      log?.({
        level: "info",
        event: "mail_inbound_enqueued",
        requestId,
        organizationId: resolved.route.organizationId,
        mailboxId: resolved.route.mailboxId,
        routeId: resolved.route.id,
        messageId,
      });
    },

    async queue(batch: MailQueueBatch<MailParseQueueMessage>, env: MailWorkerEnv): Promise<void> {
      const validation = validateMailWorkerConfig(env, { requireEncryptionKey: true });
      for (const message of batch.messages) {
        if (!validation.ok) {
          log({
            level: "warn",
            event: "mail_worker_config_invalid",
            requestId: message.body.requestId,
            issues: validation.issues,
            organizationId: message.body.organizationId,
            mailboxId: message.body.mailboxId,
            routeId: message.body.routeId,
            messageId: message.body.messageId,
          });
          message.retry();
          continue;
        }

        let result;
        try {
          result = await processEncryptedRawMimeParseJob({
            job: message.body as MailParseJobInput,
            decryptRawMime: async (input) => {
              const object = await env.RAVI_MAIL_OBJECTS.get(input.encryptedRawMime.objectRef);
              if (!object) throw new Error("mail_object_missing");
              return decryptMailWorkerPayload({
                ciphertext: await object.arrayBuffer(),
                cipherRef: input.encryptedRawMime.cipherRef as MailCipherRef,
                aad: {
                  organizationId: input.organizationId,
                  projectId: input.projectId ?? null,
                  mailboxId: input.mailboxId,
                  messageId: input.messageId,
                  routeId: message.body.routeId,
                  payloadKind: "raw_mime",
                  keyVersionPurpose: "mail_message",
                },
                env,
              });
            },
            encryptParsedPayload: async (input) => {
              const objectRef = parsedPayloadObjectRef({
                organizationId: input.organizationId,
                mailboxId: input.mailboxId,
                messageId: input.messageId,
                payloadKind: input.payloadKind,
                attachmentId: input.attachmentId,
              });
              const plaintext =
                typeof input.plaintext === "string"
                  ? new TextEncoder().encode(input.plaintext).buffer
                  : binaryToArrayBuffer(input.plaintext);
              const encrypted = await encryptMailWorkerPayload({
                plaintext,
                aad: {
                  organizationId: input.organizationId,
                  projectId: input.projectId ?? null,
                  mailboxId: input.mailboxId,
                  messageId: input.messageId,
                  routeId: message.body.routeId,
                  attachmentId: input.attachmentId ?? null,
                  payloadKind: input.payloadKind,
                  keyVersionPurpose: "mail_message",
                },
                env,
                ciphertextRef: objectRef,
              });
              await env.RAVI_MAIL_OBJECTS.put(objectRef, encrypted.ciphertext, {
                httpMetadata: {
                  contentType: "application/octet-stream",
                },
                customMetadata: {
                  organizationId: input.organizationId,
                  mailboxId: input.mailboxId,
                  messageId: input.messageId,
                  payloadKind: input.payloadKind,
                  keyVersion: encrypted.keyVersion,
                  ciphertextSha256: encrypted.sha256,
                  requestId: input.requestId,
                },
              });
              return {
                cipherRef: encrypted.cipherRef,
                objectRef,
                sha256: encrypted.sha256,
                sizeBytes: encrypted.sizeBytes,
              };
            },
            guardParsedMime: async (input) =>
              scanParsedMailWithModelArmor({
                env,
                fetchImpl,
                input,
                log,
              }),
            persistParsedMessage: async (input) => {
              const persisted = await ingestParsedInboundMessage({
                env,
                fetchImpl,
                input,
                rawMimeCipherRef: message.body.encryptedRawMime.cipherRef as MailCipherRef,
                rawSizeBytes: message.body.envelope?.rawSizeBytes ?? null,
                routeId: message.body.routeId,
              });
              if (!persisted.ok) throw new Error("mail_parsed_ingest_failed");
            },
            // Attachment durable records will use the same encrypted object format;
            // scanning and attachment metadata APIs are intentionally separate.
            persistParsedAttachment: async () => {},
            recordParseFailure: async (input) => {
              log({
                level: "warn",
                event: "mail_parse_failed",
                requestId: input.requestId,
                reason: input.reason,
                organizationId: input.organizationId,
                mailboxId: input.mailboxId,
                messageId: input.messageId,
              });
            },
          });
        } catch (error) {
          log({
            level: "warn",
            event: "mail_parse_exception",
            requestId: message.body.requestId,
            reason: error instanceof Error ? error.message : "unknown",
            organizationId: message.body.organizationId,
            mailboxId: message.body.mailboxId,
            routeId: message.body.routeId,
            messageId: message.body.messageId,
          });
          message.retry();
          continue;
        }

        if (result.ok) {
          log({
            level: "info",
            event: "mail_parse_done",
            requestId: message.body.requestId,
            organizationId: message.body.organizationId,
            mailboxId: message.body.mailboxId,
            routeId: message.body.routeId,
            messageId: message.body.messageId,
          });
          message.ack();
        } else {
          log({
            level: "warn",
            event: "mail_parse_failed",
            requestId: message.body.requestId,
            reason: result.reason,
            organizationId: message.body.organizationId,
            mailboxId: message.body.mailboxId,
            routeId: message.body.routeId,
            messageId: message.body.messageId,
          });
          message.retry();
        }
      }
    },
  };
}

function defaultMailWorkerLogger(event: MailWorkerLogEvent): void {
  const message = JSON.stringify(event);
  if (event.level === "warn") {
    console.warn(message);
  } else {
    console.log(message);
  }
}

export default createMailWorker();

async function encryptInboundAddressSummary({
  env,
  mailboxId,
  message,
  messageId,
  organizationId,
  projectId,
  requestId,
  routeId,
}: {
  env: MailWorkerEnv;
  mailboxId: string;
  message: MailWorkerEmailMessage;
  messageId: string;
  organizationId: string;
  projectId?: string | null;
  requestId: string;
  routeId: string;
}): Promise<EncryptedMailPayload> {
  const objectRef = parsedPayloadObjectRef({
    organizationId,
    mailboxId,
    messageId,
    payloadKind: "address_summary",
  });
  const plaintext = uint8ArrayToArrayBuffer(
    new TextEncoder().encode(
      serializeMailAddressSummary(
        mailAddressSummaryForOutbound({
          from: message.from,
          to: [message.to],
          internetMessageId: message.headers?.get("message-id") ?? null,
        }),
      ),
    ),
  );
  const encrypted = await encryptMailWorkerPayload({
    plaintext,
    aad: {
      organizationId,
      projectId: projectId ?? null,
      mailboxId,
      messageId,
      routeId,
      payloadKind: "address_summary",
      keyVersionPurpose: "mail_message",
    },
    env,
    ciphertextRef: objectRef,
  });

  await env.RAVI_MAIL_OBJECTS.put(objectRef, encrypted.ciphertext, {
    httpMetadata: {
      contentType: "application/octet-stream",
    },
    customMetadata: {
      organizationId,
      mailboxId,
      messageId,
      routeId,
      payloadKind: "address_summary",
      keyVersion: encrypted.keyVersion,
      ciphertextSha256: encrypted.sha256,
      requestId,
    },
  });

  return encrypted;
}

export function validateMailWorkerConfig(
  env: Partial<MailWorkerEnv>,
  options: { requireEncryptionKey?: boolean } = {},
): MailWorkerConfigValidation {
  const requireEncryptionKey = options.requireEncryptionKey ?? true;
  const issues: MailWorkerConfigIssue[] = [];
  const consoleApiUrl = isValidConsoleApiUrl(env.RAVI_CONSOLE_API_URL);
  const controlToken = isNonEmptyString(env.RAVI_MAIL_CONTROL_TOKEN);
  const encryptionKey = !requireEncryptionKey || isValidRootKeyBase64(env.RAVI_MAIL_ROOT_KEY_BASE64);
  const r2ObjectsBinding = hasFunction(env.RAVI_MAIL_OBJECTS, "put");
  const parseQueueBinding = hasFunction(env.RAVI_MAIL_PARSE_QUEUE, "send");
  const usageAuditQueueBinding = hasFunction(env.RAVI_MAIL_USAGE_AUDIT_QUEUE, "send");

  if (!env.RAVI_CONSOLE_API_URL) {
    issues.push({ field: "RAVI_CONSOLE_API_URL", code: "missing" });
  } else if (!consoleApiUrl) {
    issues.push({ field: "RAVI_CONSOLE_API_URL", code: "invalid" });
  }

  if (!controlToken) {
    issues.push({ field: "RAVI_MAIL_CONTROL_TOKEN", code: "missing" });
  }

  if (requireEncryptionKey) {
    if (!env.RAVI_MAIL_ROOT_KEY_BASE64) {
      issues.push({ field: "RAVI_MAIL_ROOT_KEY_BASE64", code: "missing" });
    } else if (!encryptionKey) {
      issues.push({ field: "RAVI_MAIL_ROOT_KEY_BASE64", code: "invalid" });
    }
  }

  if (!r2ObjectsBinding) {
    issues.push({ field: "RAVI_MAIL_OBJECTS", code: "missing" });
  }

  if (!parseQueueBinding) {
    issues.push({ field: "RAVI_MAIL_PARSE_QUEUE", code: "missing" });
  }

  if (!usageAuditQueueBinding) {
    issues.push({ field: "RAVI_MAIL_USAGE_AUDIT_QUEUE", code: "missing" });
  }

  return {
    ok: issues.length === 0,
    issues,
    checks: {
      consoleApiUrl,
      controlToken,
      encryptionKey,
      r2ObjectsBinding,
      parseQueueBinding,
      usageAuditQueueBinding,
      sendEmailBinding: env.RAVI_MAIL_SEND_EMAIL !== undefined,
    },
  };
}

async function handleOutboundSendRequest({
  env,
  log,
  now,
  randomUUID,
  request,
}: {
  env: MailWorkerEnv;
  log?: (event: MailWorkerLogEvent) => void;
  now: () => Date;
  randomUUID: () => string;
  request: Request;
}): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  if (request.method !== "POST") {
    return Response.json({ status: "error", code: "method_not_allowed" }, { status: 405 });
  }
  if (!authorizeMailWorkerRequest(request, env.RAVI_MAIL_CONTROL_TOKEN)) {
    log?.({
      level: "warn",
      event: "mail_outbound_auth_failed",
      requestId,
    });
    return Response.json({ status: "error", code: "unauthorized" }, { status: 401, headers: noStoreHeaders(requestId) });
  }
  if (!hasFunction(env.RAVI_MAIL_SEND_EMAIL, "send")) {
    log?.({
      level: "warn",
      event: "mail_worker_config_invalid",
      requestId,
      issues: [{ field: "RAVI_MAIL_SEND_EMAIL", code: "missing" }],
    });
    return Response.json(
      { status: "error", code: "send_email_binding_missing" },
      { status: 503, headers: noStoreHeaders(requestId) },
    );
  }

  let input: MailOutboundSendRequest;
  try {
    input = parseOutboundSendRequest(await request.json());
  } catch {
    return Response.json({ status: "error", code: "invalid_request" }, { status: 400, headers: noStoreHeaders(requestId) });
  }

  try {
    const result = await env.RAVI_MAIL_SEND_EMAIL.send({
      from: { email: input.from, name: "Ravi Mail" },
      to: oneOrMany(input.to),
      ...(input.cc?.length ? { cc: oneOrMany(input.cc) } : {}),
      ...(input.bcc?.length ? { bcc: oneOrMany(input.bcc) } : {}),
      subject: input.subject,
      text: input.text,
      headers: {
        "X-Ravi-Mail-Message-Id": input.messageId,
        ...(input.idempotencyKey ? { "X-Ravi-Mail-Idempotency-Key": input.idempotencyKey } : {}),
      },
    });
    const acceptedAt = now().toISOString();
    const providerMessageId =
      result && typeof result === "object" && typeof result.messageId === "string"
        ? result.messageId
        : `accepted:${input.messageId}`;
    const providerMessageRefHash = await sha256Label(providerMessageId);
    const deliveryEventRefHash = await sha256Label(`accepted:${providerMessageId}`);

    log?.({
      level: "info",
      event: "mail_outbound_send_accepted",
      requestId,
      messageId: input.messageId,
    });

    return Response.json(
      {
        status: "ok",
        acceptedAt,
        providerMessageRefHash,
        deliveryEventRefHash,
      },
      { headers: noStoreHeaders(requestId) },
    );
  } catch (error) {
    const providerError = providerSafeError(error);
    log?.({
      level: "warn",
      event: "mail_outbound_send_failed",
      requestId,
      reason: providerError.code,
      messageId: input.messageId,
    });
    return Response.json(
      {
        status: "error",
        code: "send_failed",
        providerErrorCode: providerError.code,
        providerErrorMessage: providerError.message,
      },
      { status: 502, headers: noStoreHeaders(requestId) },
    );
  }
}

function oneOrMany(values: string[]): string | string[] {
  return values.length === 1 ? values[0]! : values;
}

function providerSafeError(error: unknown): { code: string; message?: string } {
  let code = "unknown";
  let message: string | undefined;
  if (error && typeof error === "object") {
    const providerCode = (error as { code?: unknown }).code;
    if (typeof providerCode === "string" && /^[A-Z0-9_:-]{1,100}$/.test(providerCode)) code = providerCode;
  }
  if (error instanceof Error) {
    if (code === "unknown") code = error.name;
    message = redactProviderErrorMessage(error.message);
  }
  return message ? { code, message } : { code };
}

function redactProviderErrorMessage(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 240);
}

function parseOutboundSendRequest(value: unknown): MailOutboundSendRequest {
  if (!value || typeof value !== "object") throw new Error("invalid_request");
  const record = value as Partial<MailOutboundSendRequest>;
  if (record.schemaVersion !== 1) throw new Error("invalid_schema");
  if (!isSafeToken(record.messageId)) throw new Error("invalid_message_id");
  const from = assertOutboundEmail(record.from);
  const to = assertOutboundRecipients(record.to);
  const cc = record.cc === undefined ? undefined : assertOutboundRecipients(record.cc);
  const bcc = record.bcc === undefined ? undefined : assertOutboundRecipients(record.bcc);
  const subject = assertHeaderValue(record.subject, "subject");
  if (typeof record.text !== "string") throw new Error("invalid_text");
  if (new TextEncoder().encode(record.text).byteLength > 10 * 1024 * 1024) throw new Error("text_too_large");

  return {
    schemaVersion: 1,
    from,
    to,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    subject,
    text: record.text,
    messageId: record.messageId,
    ...(typeof record.idempotencyKey === "string" && record.idempotencyKey.trim()
      ? { idempotencyKey: assertHeaderValue(record.idempotencyKey, "idempotencyKey") }
      : {}),
  };
}

function assertOutboundRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new Error("invalid_recipients");
  return value.map(assertOutboundEmail);
}

function assertOutboundEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_email");
  const email = assertHeaderValue(value, "email").toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new Error("invalid_email");
  return email;
}

function assertHeaderValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`invalid_${field}`);
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
}

function authorizeMailWorkerRequest(request: Request, expectedToken: string | undefined): boolean {
  const token = expectedToken?.trim();
  if (!token) return false;
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match?.[1]?.trim();
  if (!bearerToken) return false;
  return timingSafeStringEqual(bearerToken, token);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function noStoreHeaders(requestId: string): HeadersInit {
  return {
    "cache-control": "no-store",
    "x-request-id": requestId,
  };
}

async function resolveInboundRoute({
  env,
  fetchImpl,
  requestId,
  sender,
  recipient,
  rawSizeBytes,
}: {
  env: MailWorkerEnv;
  fetchImpl: typeof fetch;
  requestId: string;
  sender: string;
  recipient: string;
  rawSizeBytes: number;
}): Promise<MailRouteResolveResult> {
  const response = await fetchImpl(new URL(routeResolvePath(env), env.RAVI_CONSOLE_API_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ravi-mail-worker": "route-resolve",
      ...(env.RAVI_MAIL_CONTROL_TOKEN ? { authorization: `Bearer ${env.RAVI_MAIL_CONTROL_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId,
      sender,
      recipient,
      rawSize: rawSizeBytes,
    }),
  });

  if (response.status === 404) {
    return {
      ok: false,
      reason: "route_not_found",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "console_unavailable",
    };
  }

  const payload = (await response.json()) as
    | {
        status?: "accept" | "drop" | "reject";
        action?: "deliver" | "drop" | "reject";
        organizationId?: string;
        projectId?: string | null;
        mailboxId?: string;
        routeId?: string;
        messageId?: string | null;
      }
    | {
        status?: "ok";
        messageId?: string | null;
        route?: Partial<MailResolvedRoute> | null;
      };

  if ("route" in payload) {
    if (payload.status !== "ok" || !payload.route) {
      return {
        ok: false,
        reason: "route_not_found",
      };
    }

    if (!payload.route.id || !payload.route.organizationId || !payload.route.mailboxId) {
      return {
        ok: false,
        reason: "route_rejected",
      };
    }

    return {
      ok: true,
      messageId: payload.messageId ?? null,
      route: {
        id: payload.route.id,
        organizationId: payload.route.organizationId,
        projectId: payload.route.projectId ?? null,
        mailboxId: payload.route.mailboxId,
        action: payload.route.action ?? "accept",
      },
    };
  }

  if (payload.status === "drop") {
    return {
      ok: true,
      messageId: payload.messageId ?? null,
      route: {
        id: payload.routeId ?? "drop",
        organizationId: payload.organizationId ?? "unknown",
        projectId: payload.projectId ?? null,
        mailboxId: payload.mailboxId ?? "unknown",
        action: "drop",
      },
    };
  }

  if (payload.status === "reject") {
    return {
      ok: false,
      reason: "route_rejected",
    };
  }

  if (
    payload.status !== "accept" ||
    payload.action !== "deliver" ||
    !payload.organizationId ||
    !payload.mailboxId ||
    !payload.routeId
  ) {
    return {
      ok: false,
      reason: "route_not_found",
    };
  }

  return {
    ok: true,
    messageId: payload.messageId ?? null,
    route: {
      id: payload.routeId,
      organizationId: payload.organizationId,
      projectId: payload.projectId ?? null,
      mailboxId: payload.mailboxId,
      action: "accept",
    },
  };
}

function routeResolvePath(env: MailWorkerEnv): string {
  return env.RAVI_MAIL_ROUTE_RESOLVE_PATH ?? DEFAULT_ROUTE_RESOLVE_PATH;
}

async function ingestEncryptedInboundMessage({
  addressSummaryCipherRef,
  env,
  fetchImpl,
  message,
  messageId,
  rawMimeCipherRef,
  rawSizeBytes,
  requestId,
  route,
}: {
  addressSummaryCipherRef?: MailCipherRef | null;
  env: MailWorkerEnv;
  fetchImpl: typeof fetch;
  message: MailWorkerEmailMessage;
  messageId: string;
  rawMimeCipherRef: MailCipherRef;
  rawSizeBytes: number;
  requestId: string;
  route: MailResolvedRoute;
}): Promise<{ ok: true; created: boolean; messageId: string } | { ok: false }> {
  const response = await fetchImpl(new URL(ingestPath(env), env.RAVI_CONSOLE_API_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ravi-mail-worker": "message-ingest",
      ...(env.RAVI_MAIL_CONTROL_TOKEN ? { authorization: `Bearer ${env.RAVI_MAIL_CONTROL_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      organizationId: route.organizationId,
      projectId: route.projectId ?? null,
      mailboxId: route.mailboxId,
      routeId: route.id,
      messageId,
      providerAdapter: "cloudflare_email",
      providerMessageRefHash: await optionalMessageHeaderHash(message.headers?.get("message-id")),
      internetMessageIdHash: await optionalMessageHeaderHash(message.headers?.get("message-id")),
      fromHash: await sha256Label(message.from.trim().toLowerCase()),
      toHashesJson: [await sha256Label(message.to.trim().toLowerCase())],
      rawMimeCipherRef,
      addressSummaryCipherRef: addressSummaryCipherRef ?? null,
      headersCipherRef: rawMimeCipherRef,
      sizeBytes: rawSizeBytes,
      receivedAt: new Date().toISOString(),
      requestId,
      metadataJson: {
        ingress: {
          schemaVersion: 1,
          source: "mail_worker",
          rawSizeBytes,
        },
      },
    }),
  });

  if (!response.ok) return { ok: false };
  const payload = (await response.json()) as {
    status?: string;
    created?: boolean;
    messageId?: string;
  };
  return payload.status === "ok" && typeof payload.created === "boolean" && isNonEmptyString(payload.messageId)
    ? { ok: true, created: payload.created, messageId: payload.messageId }
    : { ok: false };
}

async function deleteDuplicateInboundObjects(bucket: MailR2Bucket, objectRefs: string[]): Promise<void> {
  if (!bucket.delete) return;
  try {
    await bucket.delete([...new Set(objectRefs.filter(Boolean))]);
  } catch {
    // Duplicate cleanup is best effort; the canonical message remains durable.
  }
}

async function ingestParsedInboundMessage({
  env,
  fetchImpl,
  input,
  rawMimeCipherRef,
  rawSizeBytes,
  routeId,
}: {
  env: MailWorkerEnv;
  fetchImpl: typeof fetch;
  input: MailPersistParsedMessageInput;
  rawMimeCipherRef: MailCipherRef;
  rawSizeBytes: number | null;
  routeId: string;
}): Promise<{ ok: true } | { ok: false }> {
  const response = await fetchImpl(new URL(ingestPath(env), env.RAVI_CONSOLE_API_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ravi-mail-worker": "parsed-message-ingest",
      ...(env.RAVI_MAIL_CONTROL_TOKEN ? { authorization: `Bearer ${env.RAVI_MAIL_CONTROL_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      mailboxId: input.mailboxId,
      routeId,
      messageId: input.messageId,
      providerAdapter: "cloudflare_email",
      rawMimeCipherRef,
      subjectCipherRef: input.subjectCipherRef,
      headersCipherRef: input.headersCipherRef,
      parsedBodyCipherRef: input.parsedBodyCipherRef,
      addressSummaryCipherRef: input.addressSummaryCipherRef,
      attachments: input.attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        filenameCipherRef: attachment.filenameCipherRef ?? null,
        objectCipherRef: attachment.objectCipherRef,
        contentType: attachment.contentType ?? null,
        sizeBytes: attachment.sizeBytes ?? null,
        sha256: attachment.sha256 ?? null,
        status: attachment.status,
        metadataJson: attachment.metadataJson ?? {},
      })),
      sizeBytes: rawSizeBytes,
      requestId: input.requestId,
      metadataJson: {
        parse: {
          schemaVersion: 1,
          status: "ok",
          parsedAt: input.parsedAt,
          classification: input.classification,
        },
        ...(input.metadataJson ?? {}),
      },
    }),
  });

  if (!response.ok) return { ok: false };
  const payload = (await response.json()) as { status?: string };
  return payload.status === "ok" ? { ok: true } : { ok: false };
}

function ingestPath(env: MailWorkerEnv): string {
  return env.RAVI_MAIL_INGEST_PATH ?? DEFAULT_INGEST_PATH;
}

function parsedPayloadObjectRef({
  organizationId,
  mailboxId,
  messageId,
  payloadKind,
  attachmentId,
}: {
  organizationId: string;
  mailboxId: string;
  messageId: string;
  payloadKind: MailParsedPayloadKind;
  attachmentId?: string;
}): string {
  const suffix = attachmentId ? `${encodeSegment(attachmentId)}/${payloadKind}.enc` : `${payloadKind}.enc`;
  return `mail/org/${encodeSegment(organizationId)}/mailbox/${encodeSegment(mailboxId)}/message/${encodeSegment(
    messageId,
  )}/parsed/${suffix}`;
}

function encryptedRawMimeObjectRef({
  organizationId,
  mailboxId,
  messageId,
}: {
  organizationId: string;
  mailboxId: string;
  messageId: string;
}): string {
  return `mail/org/${encodeSegment(organizationId)}/mailbox/${encodeSegment(mailboxId)}/message/${encodeSegment(
    messageId,
  )}/raw.mime.enc`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

async function readRawMime(raw: MailWorkerEmailMessage["raw"]): Promise<ArrayBuffer> {
  if (typeof raw === "string") {
    return uint8ArrayToArrayBuffer(new TextEncoder().encode(raw));
  }

  if (raw instanceof ArrayBuffer) {
    return raw;
  }

  if (ArrayBuffer.isView(raw)) {
    return uint8ArrayToArrayBuffer(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }

  return new Response(raw).arrayBuffer();
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function binaryToArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return uint8ArrayToArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Label(value: string): Promise<string> {
  return `sha256:${await sha256Hex(value)}`;
}

async function optionalMessageHeaderHash(value: string | undefined | null): Promise<string | null> {
  const normalized = value?.trim().toLowerCase();
  return normalized ? sha256Label(normalized) : null;
}

function isValidConsoleApiUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasFunction<T extends string>(value: unknown, property: T): value is Record<T, (...args: never[]) => unknown> {
  return typeof value === "object" && value !== null && typeof (value as Record<T, unknown>)[property] === "function";
}
