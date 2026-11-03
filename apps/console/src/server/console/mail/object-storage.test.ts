import { describe, expect, test } from "bun:test";

import { base64UrlEncode, encryptRawMime } from "../../../../workers/mail/src/crypto";
import { createMailPayloadDecrypter, createMailPayloadEncryptor } from "./object-storage";
import type { MailMessage } from "./storage";

describe("Ravi Mail object storage decrypter", () => {
  test("reads encrypted worker payloads from object storage and enforces message AAD", async () => {
    const rootKeyBase64 = base64UrlEncode(new Uint8Array(32).fill(3));
    const objectKey = "mail/org/org_1/mailbox/mailbox_1/message/message_1/raw.mime.enc";
    const encrypted = await encryptRawMime({
      plaintext: new TextEncoder().encode("Subject: Private\r\n\r\nsecret body").buffer,
      ciphertextRef: objectKey,
      aad: {
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        routeId: "route_1",
        payloadKind: "raw_mime",
        keyVersionPurpose: "mail_message",
      },
      env: {
        RAVI_MAIL_ROOT_KEY_BASE64: rootKeyBase64,
        RAVI_MAIL_KEY_VERSION: "1",
      },
      now: () => new Date("2026-05-11T03:00:00.000Z"),
    });
    const decrypter = createMailPayloadDecrypter({
      rootKeyBase64,
      objectStore: {
        async getObject(key) {
          expect(key).toBe(objectKey);
          return encrypted.ciphertext as ArrayBuffer;
        },
        async putObject() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      decrypter.decryptMessagePayload({
        cipherRef: encrypted.cipherRef,
        message: message(),
        payloadKind: "raw_mime",
      }),
    ).resolves.toBe("Subject: Private\r\n\r\nsecret body");

    await expect(
      decrypter.decryptMessagePayload({
        cipherRef: encrypted.cipherRef,
        message: {
          ...message(),
          mailboxId: "other_mailbox",
        },
        payloadKind: "raw_mime",
      }),
    ).rejects.toThrow("mail_operation_denied");
  });

  test("encrypts outbound payloads into worker-compatible object refs", async () => {
    const rootKeyBase64 = base64UrlEncode(new Uint8Array(32).fill(5));
    const objects = new Map<string, ArrayBuffer>();
    const encryptor = createMailPayloadEncryptor({
      rootKeyBase64,
      keyVersion: "1",
      objectStore: {
        async getObject(key) {
          return objects.get(key) ?? null;
        },
        async putObject(key, value) {
          objects.set(key, await new Response(value).arrayBuffer());
        },
      },
    });
    const encrypted = await encryptor.encryptMessagePayload({
      direction: "outbound",
      organizationId: "org_1",
      projectId: "proj_1",
      mailboxId: "mailbox_1",
      messageId: "message_1",
      payloadKind: "subject",
      plaintext: "Private subject",
    });

    expect(encrypted.objectRef).toBe("mail/org/org_1/mailbox/mailbox_1/message/message_1/outbound/subject.enc");
    expect(objects.has(encrypted.objectRef)).toBe(true);

    const decrypter = createMailPayloadDecrypter({
      rootKeyBase64,
      objectStore: {
        async getObject(key) {
          return objects.get(key) ?? null;
        },
        async putObject() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      decrypter.decryptMessagePayload({
        cipherRef: encrypted.cipherRef,
        message: message({ direction: "outbound" }),
        payloadKind: "subject",
      }),
    ).resolves.toBe("Private subject");
  });
});

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "message_1",
    organizationId: "org_1",
    projectId: "proj_1",
    mailboxId: "mailbox_1",
    threadId: null,
    direction: "inbound",
    providerAdapter: "cloudflare_email",
    providerMessageRefHash: "provider_hash",
    internetMessageIdHash: null,
    fromHash: "from_hash",
    toHashesJson: ["to_hash"],
    subjectCipherRef: null,
    rawMimeCipherRef: {},
    parsedBodyCipherRef: null,
    addressSummaryCipherRef: null,
    headersCipherRef: {},
    status: "received",
    sizeBytes: 64,
    receivedAt: new Date("2026-05-11T03:00:00.000Z"),
    sentAt: null,
    metadataJson: {},
    createdAt: new Date("2026-05-11T03:00:00.000Z"),
    updatedAt: new Date("2026-05-11T03:00:00.000Z"),
    ...overrides,
  };
}
