import { describe, expect, test } from "bun:test";

import { assertSafeMailParseQueueMessage, processMailParseQueueMessage } from "./parse-queue";

describe("Ravi Mail parse queue foundation", () => {
  test("accepts queue metadata with only encrypted refs and hashes", () => {
    const payload = queueMessage();

    expect(() => assertSafeMailParseQueueMessage(payload)).not.toThrow();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Plain subject");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("contract.pdf");
    expect(serialized).not.toContain("sender@example.com");
  });

  test("rejects unsafe queue payload fields before decrypting", async () => {
    const unsafePayload = {
      ...queueMessage(),
      subject: "Plain subject",
    };
    let decryptCalled = false;

    await expect(
      processMailParseQueueMessage(unsafePayload, {
        decryptRawMime: async () => {
          decryptCalled = true;
          return rawMime();
        },
        encryptParsedPayload: async (input) => cipherRef(input.payloadKind),
        persistParsedMessage: async () => {},
        persistParsedAttachment: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "unsafe_queue_payload",
    });
    expect(decryptCalled).toBe(false);
  });

  test("passes encrypted raw MIME refs through the decrypt boundary and persists cipher refs", async () => {
    const decryptCalls: unknown[] = [];
    const persisted: unknown[] = [];

    const result = await processMailParseQueueMessage(queueMessage(), {
      decryptRawMime: async (input) => {
        decryptCalls.push(input);
        return rawMime();
      },
      encryptParsedPayload: async (input) => cipherRef(input.payloadKind),
      persistParsedMessage: async (input) => {
        persisted.push(input);
      },
      persistParsedAttachment: async (input) => {
        persisted.push(input);
      },
      now: () => new Date("2026-05-11T04:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(decryptCalls).toEqual([
      {
        requestId: "req_1",
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        encryptedRawMime: queueMessage().encryptedRawMime,
      },
    ]);
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain("object://mail/subject");
    expect(serialized).toContain("object://mail/parsed_body");
    expect(serialized).toContain("\"status\":\"unscanned\"");
    expect(serialized).not.toContain("Plain subject");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("contract.pdf");
  });
});

function queueMessage() {
  return {
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
      cipherRef: "cipher_raw_mime_1",
      objectRef: "mail/org/org_1/mailbox/mailbox_1/message/message_1/raw.mime.enc",
      keyVersion: "key_v1",
      sha256: "raw_cipher_sha256",
      sizeBytes: 2048,
    },
    envelope: {
      senderHash: "sender_hash",
      recipientHash: "recipient_hash",
      rawSizeBytes: 2048,
    },
  };
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
    "",
  ].join("\r\n");
}

function cipherRef(kind: string) {
  return {
    cipherRef: {
      schemaVersion: 1,
      ciphertextRef: `object://mail/${kind}`,
      algorithm: "AES-256-GCM",
      wrappedKeyRef: `mail_key_wraps/${kind}`,
      aadHash: `sha256:${kind}`,
      keyVersion: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
    },
    objectRef: `object://mail/${kind}`,
    sha256: `sha256_${kind}`,
    sizeBytes: 32,
  };
}
