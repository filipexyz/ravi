import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createMailWorker,
  validateMailWorkerConfig,
  type EncryptedMailPayload,
  type MailRawMimeEncryptor,
  type MailWorkerEnv,
  type MailWorkerLogEvent,
} from "./index";
import { base64UrlEncode } from "./crypto";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ravi mail worker", () => {
  test("health endpoint validates runtime config without exposing secret values", async () => {
    const response = await createMailWorker().fetch(new Request("https://worker.example/health"), fullEnv());
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toMatchObject({
      ok: true,
      service: "ravi-mail",
      checks: {
        consoleApiUrl: true,
        controlToken: true,
        encryptionKey: true,
        r2ObjectsBinding: true,
        parseQueueBinding: true,
        usageAuditQueueBinding: true,
        sendEmailBinding: false,
      },
      issues: [],
    });
    expect(JSON.stringify(payload)).not.toContain("control_token");
    expect(JSON.stringify(payload)).not.toContain(rootKeyBase64());
  });

  test("config validation reports missing bindings and invalid URLs without values", async () => {
    const response = await createMailWorker().fetch(
      new Request("https://worker.example/healthz"),
      {
        RAVI_CONSOLE_API_URL: "http://console.ravi.bot",
        RAVI_MAIL_CONTROL_TOKEN: "super-secret",
      } as MailWorkerEnv,
    );
    expect(response.status).toBe(503);
    const payload = await response.json();

    expect(payload.ok).toBe(false);
    expect(payload.issues).toEqual([
      { field: "RAVI_CONSOLE_API_URL", code: "invalid" },
      { field: "RAVI_MAIL_ROOT_KEY_BASE64", code: "missing" },
      { field: "RAVI_MAIL_OBJECTS", code: "missing" },
      { field: "RAVI_MAIL_PARSE_QUEUE", code: "missing" },
      { field: "RAVI_MAIL_USAGE_AUDIT_QUEUE", code: "missing" },
    ]);
    expect(JSON.stringify(payload)).not.toContain("super-secret");
    expect(validateMailWorkerConfig(fullEnv()).ok).toBe(true);
  });

  test("authorized outbound HTTP endpoint sends through send_email binding without logging plaintext", async () => {
    const sentMessages: unknown[] = [];
    const logs: unknown[] = [];
    const response = await createMailWorker({
      log: (event) => logs.push(event),
      now: () => new Date("2026-05-11T03:00:00.000Z"),
      randomUUID: () => "req_send_1",
    }).fetch(
      new Request("https://worker.example/internal/outbound/send", {
        method: "POST",
        headers: {
          authorization: "Bearer control_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          messageId: "message_1",
          idempotencyKey: "idem_1",
          from: "agent@mail.ravi.bot",
          to: ["lead@example.com"],
          subject: "Private subject",
          text: "secret outbound body",
        }),
      }),
      {
        ...fullEnv(),
        RAVI_MAIL_SEND_EMAIL: {
          async send(message) {
            sentMessages.push(message);
            return {
              messageId: "cf_message_1",
            };
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      acceptedAt: "2026-05-11T03:00:00.000Z",
      providerMessageRefHash: await sha256LabelForTest("cf_message_1"),
      deliveryEventRefHash: await sha256LabelForTest("accepted:cf_message_1"),
    });
    expect(sentMessages).toEqual([
      {
        from: { email: "agent@mail.ravi.bot", name: "Ravi Mail" },
        to: "lead@example.com",
        subject: "Private subject",
        text: "secret outbound body",
        headers: {
          "X-Ravi-Mail-Message-Id": "message_1",
          "X-Ravi-Mail-Idempotency-Key": "idem_1",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("Private subject");
    expect(JSON.stringify(logs)).not.toContain("secret outbound body");
    expect(JSON.stringify(logs)).not.toContain("lead@example.com");
  });

  test("rejects inbound mail with no configured route before reading, storing, or queueing", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: 1,
        requestId: "req_1",
        sender: "sender@example.com",
        recipient: "unknown@mail.ravi.bot",
        rawSize: 77,
      });
      return Response.json({ status: "not_found" }, { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const rejected: string[] = [];
    const encryptRawMime = mock(async () => encryptedPayload());
    const queued: unknown[] = [];
    const stored: Array<{ key: string; value: unknown; options: unknown }> = [];

    await createMailWorker({ encryptRawMime, randomUUID: () => "req_1" }).email(
      {
        from: "sender@example.com",
        to: "unknown@mail.ravi.bot",
        raw: streamThatShouldNotBeRead(),
        rawSize: 77,
        setReject(reason) {
          rejected.push(reason);
        },
      },
      env({ queued, stored }),
    );

    expect(rejected).toEqual(["mail_route_not_found"]);
    expect(encryptRawMime).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
    expect(queued).toEqual([]);
  });

  test("accepts a configured inbound route, encrypts before R2 storage, and enqueues parse metadata", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/internal/mail/routes/resolve") {
        return Response.json({
          status: "accept",
          action: "deliver",
          messageId: "message_1",
          routeId: "route_1",
          organizationId: "org_1",
          projectId: "proj_1",
          mailboxId: "mailbox_1",
        });
      }

      expect(url.pathname).toBe("/api/internal/mail/messages/ingest");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        routeId: "route_1",
        messageId: "message_1",
        providerAdapter: "cloudflare_email",
        sizeBytes: rawMime().length,
        requestId: "req_1",
      });
      expect(body.rawMimeCipherRef).toMatchObject({
        schemaVersion: 1,
        ciphertextRef: "object://mail/raw",
        algorithm: "AES-256-GCM",
        wrappedKeyRef: "mail_key_wraps/raw",
        keyVersion: 1,
      });
      expect(JSON.stringify(body)).not.toContain("Plain subject");
      expect(JSON.stringify(body)).not.toContain("secret body");
      return Response.json({ status: "ok", created: true, messageId: body.messageId, requestId: "req_1" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const queued: unknown[] = [];
    const usageAuditQueued: unknown[] = [];
    const stored: Array<{ key: string; value: unknown; options: unknown }> = [];
    const encryptRawMime = mock<MailRawMimeEncryptor>(async ({ plaintext, aad }) => {
      expect(new TextDecoder().decode(plaintext)).toContain("Subject: Plain subject");
      expect(aad).toEqual({
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        routeId: "route_1",
        payloadKind: "raw_mime",
        keyVersionPurpose: "mail_message",
      });
      return encryptedPayload();
    });
    const rejected: string[] = [];

    await createMailWorker({
      encryptRawMime,
      now: () => new Date("2026-05-11T03:00:00.000Z"),
      randomUUID: () => "req_1",
    }).email(
      {
        from: "sender@example.com",
        to: "agent@mail.ravi.bot",
        raw: rawMime(),
        rawSize: rawMime().length,
        setReject(reason) {
          rejected.push(reason);
        },
      },
      fullEnv({ queued, usageAuditQueued, stored }),
    );

    expect(rejected).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      key: "mail/org/org_1/mailbox/mailbox_1/message/message_1/raw.mime.enc",
      value: "ciphertext-bytes",
      options: {
        customMetadata: {
          organizationId: "org_1",
          mailboxId: "mailbox_1",
          messageId: "message_1",
          routeId: "route_1",
          payloadKind: "raw_mime",
          keyVersion: "key_v1",
          ciphertextSha256: "cipher_sha256",
          requestId: "req_1",
        },
      },
    });
    expect(stored[1]).toMatchObject({
      key: "mail/org/org_1/mailbox/mailbox_1/message/message_1/parsed/address_summary.enc",
      options: {
        customMetadata: {
          organizationId: "org_1",
          mailboxId: "mailbox_1",
          messageId: "message_1",
          routeId: "route_1",
          payloadKind: "address_summary",
          requestId: "req_1",
        },
      },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      schemaVersion: 1,
      source: "mail_worker",
      requestId: "req_1",
      enqueuedAt: "2026-05-11T03:00:00.000Z",
      organizationId: "org_1",
      projectId: "proj_1",
      mailboxId: "mailbox_1",
      routeId: "route_1",
      messageId: "message_1",
      providerAdapter: "cloudflare_email",
      direction: "inbound",
      encryptedRawMime: {
        cipherRef: encryptedPayload().cipherRef,
        objectRef: "mail/org/org_1/mailbox/mailbox_1/message/message_1/raw.mime.enc",
        keyVersion: "key_v1",
        sha256: "cipher_sha256",
        sizeBytes: 16,
      },
      envelope: {
        rawSizeBytes: rawMime().length,
      },
    });
    expect(usageAuditQueued).toEqual([
      {
        schemaVersion: 1,
        source: "mail_worker",
        requestId: "req_1",
        occurredAt: "2026-05-11T03:00:00.000Z",
        eventType: "mail.inbound.accepted",
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        routeId: "route_1",
        messageId: "message_1",
        providerAdapter: "cloudflare_email",
        direction: "inbound",
        metrics: {
          rawSizeBytes: rawMime().length,
          encryptedSizeBytes: 16,
        },
      },
    ]);
  });

  test("drops duplicate temporary objects and does not enqueue or meter a canonical replay", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/internal/mail/routes/resolve") {
        return Response.json({
          status: "accept",
          action: "deliver",
          messageId: "message_temporary",
          routeId: "route_1",
          organizationId: "org_1",
          projectId: "proj_1",
          mailboxId: "mailbox_1",
        });
      }
      return Response.json({
        status: "ok",
        created: false,
        messageId: "message_canonical",
        requestId: "req_1",
      });
    }) as unknown as typeof fetch;

    const queued: unknown[] = [];
    const usageAuditQueued: unknown[] = [];
    const deleted: string[] = [];
    const logs: MailWorkerLogEvent[] = [];
    const workerEnv = fullEnv({ queued, usageAuditQueued });
    workerEnv.RAVI_MAIL_OBJECTS.delete = async (keys) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    };

    await createMailWorker({
      encryptRawMime: async () => encryptedPayload(),
      log: (event) => logs.push(event),
      randomUUID: () => "req_1",
    }).email(
      {
        from: "sender@example.com",
        to: "agent@mail.ravi.bot",
        raw: rawMime(),
        rawSize: rawMime().length,
        setReject(reason) {
          throw new Error(reason);
        },
      },
      workerEnv,
    );

    expect(queued).toEqual([]);
    expect(usageAuditQueued).toEqual([]);
    expect(deleted.sort()).toEqual([
      "mail/org/org_1/mailbox/mailbox_1/message/message_temporary/parsed/address_summary.enc",
      "mail/org/org_1/mailbox/mailbox_1/message/message_temporary/raw.mime.enc",
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mail_inbound_duplicate",
        messageId: "message_canonical",
      }),
    );
  });

  test("does not put plaintext subject, body, raw MIME, addresses, or attachment names in queue payloads or logs", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/internal/mail/routes/resolve") {
        return Response.json({
          status: "accept",
          action: "deliver",
          messageId: "message_1",
          routeId: "route_1",
          organizationId: "org_1",
          mailboxId: "mailbox_1",
        });
      }
      return Response.json({ status: "ok", created: true, messageId: "message_1", requestId: "req_1" });
    }) as unknown as typeof fetch;
    const queued: unknown[] = [];
    const usageAuditQueued: unknown[] = [];
    const logs: unknown[] = [];

    await createMailWorker({
      encryptRawMime: async () => encryptedPayload(),
      log: (event) => logs.push(event),
      now: () => new Date("2026-05-11T03:00:00.000Z"),
      randomUUID: () => "req_1",
    }).email(
      {
        from: "sender@example.com",
        to: "agent@mail.ravi.bot",
        raw: rawMime(),
        rawSize: rawMime().length,
        setReject() {
          throw new Error("should not reject");
        },
      },
      fullEnv({ queued, usageAuditQueued }),
    );

    const payload = JSON.stringify({ parse: queued[0], usageAudit: usageAuditQueued[0], logs });
    expect(payload).not.toContain("Plain subject");
    expect(payload).not.toContain("secret body");
    expect(payload).not.toContain("contract.pdf");
    expect(payload).not.toContain(rawMime());
    expect(payload).not.toContain("sender@example.com");
    expect(payload).not.toContain("agent@mail.ravi.bot");
  });

  test("queue consumer parses encrypted raw MIME and updates parsed cipher refs through Console ingest", async () => {
    const ingests: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/internal/mail/routes/resolve") {
        return Response.json({
          status: "accept",
          action: "deliver",
          messageId: "message_1",
          routeId: "route_1",
          organizationId: "org_1",
          projectId: "proj_1",
          mailboxId: "mailbox_1",
        });
      }
      const ingest = JSON.parse(String(init?.body));
      ingests.push(ingest);
      return Response.json({
        status: "ok",
        created: ingests.length === 1,
        messageId: ingest.messageId,
        requestId: "req_1",
      });
    }) as unknown as typeof fetch;
    const queued: unknown[] = [];
    const stored = new Map<string, ArrayBuffer | string | ArrayBufferView | ReadableStream>();
    const acks: string[] = [];
    const retries: string[] = [];
    const envWithObjects = {
      ...fullEnv(),
      RAVI_MAIL_OBJECTS: {
        async get(key: string) {
          const value = stored.get(key);
          if (!value) return null;
          return {
            async arrayBuffer() {
              if (value instanceof ArrayBuffer) return value;
              if (ArrayBuffer.isView(value)) {
                const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                const copy = new Uint8Array(bytes.byteLength);
                copy.set(bytes);
                return copy.buffer;
              }
              if (typeof value === "string") return new TextEncoder().encode(value).buffer;
              return new Response(value).arrayBuffer();
            },
          };
        },
        async put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream) {
          stored.set(key, value);
        },
      },
      RAVI_MAIL_PARSE_QUEUE: {
        async send(message: unknown) {
          queued.push(message);
        },
      },
    } satisfies MailWorkerEnv;

    const worker = createMailWorker({
      now: () => new Date("2026-05-11T03:00:00.000Z"),
      randomUUID: () => "req_1",
    });
    await worker.email(
      {
        from: "sender@example.com",
        to: "agent@mail.ravi.bot",
        raw: rawMime(),
        rawSize: rawMime().length,
        setReject(reason) {
          throw new Error(reason);
        },
      },
      envWithObjects,
    );
    await worker.queue(
      {
        messages: [
          {
            body: queued[0] as never,
            ack() {
              acks.push("ack");
            },
            retry() {
              retries.push("retry");
            },
          },
        ],
      },
      envWithObjects,
    );

    expect(acks).toEqual(["ack"]);
    expect(retries).toEqual([]);
    expect(ingests).toHaveLength(2);
    expect(ingests[1]).toMatchObject({
      messageId: "message_1",
      subjectCipherRef: {
        schemaVersion: 1,
      },
      parsedBodyCipherRef: {
        schemaVersion: 1,
      },
      addressSummaryCipherRef: {
        schemaVersion: 1,
      },
      metadataJson: {
        parse: {
          status: "ok",
        },
      },
    });
    expect(JSON.stringify(ingests[1])).not.toContain("Plain subject");
    expect(JSON.stringify(ingests[1])).not.toContain("secret body");
  });
});

function env({
  queued = [],
  usageAuditQueued = [],
  stored = [],
}: {
  queued?: unknown[];
  usageAuditQueued?: unknown[];
  stored?: Array<{ key: string; value: unknown; options: unknown }>;
} = {}): MailWorkerEnv {
  return {
    RAVI_CONSOLE_API_URL: "https://console.ravi.bot",
    RAVI_MAIL_CONTROL_TOKEN: "control_token",
    RAVI_MAIL_OBJECTS: {
      async get() {
        return null;
      },
      async put(key, value, options) {
        stored.push({ key, value, options });
      },
    },
    RAVI_MAIL_PARSE_QUEUE: {
      async send(message) {
        queued.push(message);
      },
    },
    RAVI_MAIL_USAGE_AUDIT_QUEUE: {
      async send(message) {
        usageAuditQueued.push(message);
      },
    },
  };
}

function fullEnv(overrides: Parameters<typeof env>[0] = {}): MailWorkerEnv {
  return {
    ...env(overrides),
    RAVI_MAIL_ROOT_KEY_BASE64: rootKeyBase64(),
  };
}

function encryptedPayload(): EncryptedMailPayload {
  return {
    ciphertext: "ciphertext-bytes",
    cipherRef: {
      schemaVersion: 1,
      ciphertextRef: "object://mail/raw",
      algorithm: "AES-256-GCM",
      wrappedKeyRef: "mail_key_wraps/raw",
      keyVersion: 1,
      keyVersionLabel: "key_v1",
      keyScope: {
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        routeId: "route_1",
        attachmentId: null,
        payloadKind: "raw_mime",
        keyVersionPurpose: "mail_message",
      },
      nonce: "nonce",
      wrappedKey: {
        algorithm: "AES-256-GCM",
        keyVersion: "key_v1",
        nonce: "wrap_nonce",
        ciphertext: "wrapped_key_ciphertext",
      },
      aadHash: "aad_hash",
      ciphertextSha256: "cipher_sha256",
      createdAt: "2026-05-11T03:00:00.000Z",
    },
    keyVersion: "key_v1",
    sha256: "cipher_sha256",
    sizeBytes: 16,
  };
}

function rootKeyBase64(): string {
  return base64UrlEncode(new Uint8Array(32).fill(7));
}

function rawMime(): string {
  return [
    "From: sender@example.com",
    "To: agent@mail.ravi.bot",
    "Subject: Plain subject",
    "Content-Type: multipart/mixed; boundary=abc",
    "",
    "--abc",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "secret body",
    "--abc",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=\"contract.pdf\"",
    "",
    "attachment bytes",
    "--abc--",
  ].join("\r\n");
}

async function sha256LabelForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function streamThatShouldNotBeRead(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error("raw MIME was read before route acceptance");
    },
  });
}
