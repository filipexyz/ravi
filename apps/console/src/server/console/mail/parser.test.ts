import { describe, expect, test } from "bun:test";

import {
  processEncryptedRawMimeParseJob,
  type MailEncryptParsedPayloadInput,
  type MailParseJobInput,
  type MailPersistParsedAttachmentInput,
  type MailPersistParsedMessageInput,
} from "./parser";

describe("Ravi Mail parser foundation", () => {
  test("decrypts raw MIME through an injected boundary and persists only parsed cipher refs", async () => {
    const encrypted: MailEncryptParsedPayloadInput[] = [];
    const persistedMessages: MailPersistParsedMessageInput[] = [];
    const persistedAttachments: MailPersistParsedAttachmentInput[] = [];
    const decryptCalls: unknown[] = [];

    const result = await processEncryptedRawMimeParseJob({
      job: parseJob(),
      decryptRawMime: async (input) => {
        decryptCalls.push(input);
        return rawMime();
      },
      encryptParsedPayload: async (input) => {
        encrypted.push(input);
        return cipherRef(input.payloadKind);
      },
      persistParsedMessage: async (input) => {
        persistedMessages.push(input);
      },
      persistParsedAttachment: async (input) => {
        persistedAttachments.push(input);
      },
      now: () => new Date("2026-05-11T04:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      attachmentCount: 1,
      classification: {
        schemaVersion: 1,
        category: "unknown",
        hasAttachments: true,
        attachmentCount: 1,
      },
    });
    expect(decryptCalls).toEqual([
      {
        requestId: "req_1",
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        encryptedRawMime: parseJob().encryptedRawMime,
      },
    ]);
    expect(encrypted.map((input) => input.payloadKind)).toEqual([
      "subject",
      "headers",
      "parsed_body",
      "address_summary",
      "attachment_filename",
      "attachment_object",
    ]);
    expect(encrypted.find((input) => input.payloadKind === "subject")?.plaintext).toBe("Plain subject");
    expect(String(encrypted.find((input) => input.payloadKind === "parsed_body")?.plaintext)).toContain(
      "secret body",
    );

    expect(persistedMessages).toEqual([
      {
        requestId: "req_1",
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        attachments: [
          expect.objectContaining({
            attachmentId: "message_1:attachment:1",
            filenameCipherRef: cipherRef("attachment_filename").cipherRef,
            objectCipherRef: cipherRef("attachment_object").cipherRef,
            contentType: "application/pdf",
            status: "unscanned",
          }),
        ],
        subjectCipherRef: cipherRef("subject").cipherRef,
        headersCipherRef: cipherRef("headers").cipherRef,
        parsedBodyCipherRef: cipherRef("parsed_body").cipherRef,
        addressSummaryCipherRef: cipherRef("address_summary").cipherRef,
        classification: {
          schemaVersion: 1,
          category: "unknown",
          hasAttachments: true,
          attachmentCount: 1,
        },
        parsedAt: "2026-05-11T04:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(persistedMessages)).not.toContain("Plain subject");
    expect(JSON.stringify(persistedMessages)).not.toContain("secret body");
    expect(persistedAttachments[0]).toMatchObject({
      requestId: "req_1",
      organizationId: "org_1",
      projectId: "proj_1",
      mailboxId: "mailbox_1",
      messageId: "message_1",
      filenameCipherRef: cipherRef("attachment_filename").cipherRef,
      objectCipherRef: cipherRef("attachment_object").cipherRef,
      contentType: "application/pdf",
      status: "unscanned",
    });
  });

  test("treats attachment filename and content as sensitive callback inputs only", async () => {
    const encrypted: MailEncryptParsedPayloadInput[] = [];
    const persistedAttachments: MailPersistParsedAttachmentInput[] = [];

    await processEncryptedRawMimeParseJob({
      job: parseJob(),
      decryptRawMime: async () => rawMime(),
      encryptParsedPayload: async (input) => {
        encrypted.push(input);
        return cipherRef(input.payloadKind);
      },
      persistParsedMessage: async () => {},
      persistParsedAttachment: async (input) => {
        persistedAttachments.push(input);
      },
    });

    expect(encrypted.find((input) => input.payloadKind === "attachment_filename")?.plaintext).toBe("contract.pdf");
    expect(new TextDecoder().decode(encrypted.find((input) => input.payloadKind === "attachment_object")?.plaintext as Uint8Array)).toContain(
      "attachment bytes",
    );

    const durablePayload = JSON.stringify(persistedAttachments);
    expect(durablePayload).not.toContain("contract.pdf");
    expect(durablePayload).not.toContain("attachment bytes");
    expect(persistedAttachments[0]?.status).toBe("unscanned");
  });

  test("decodes encoded words and quoted-printable text before encrypting parsed payloads", async () => {
    const encrypted: MailEncryptParsedPayloadInput[] = [];
    const persistedAttachments: MailPersistParsedAttachmentInput[] = [];

    const result = await processEncryptedRawMimeParseJob({
      job: parseJob(),
      decryptRawMime: async () => encodedRawMime(),
      encryptParsedPayload: async (input) => {
        encrypted.push(input);
        return cipherRef(input.payloadKind);
      },
      persistParsedMessage: async () => {},
      persistParsedAttachment: async (input) => {
        persistedAttachments.push(input);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      attachmentCount: 1,
    });
    expect(encrypted.find((input) => input.payloadKind === "subject")?.plaintext).toBe("Anotações");

    const parsedBody = JSON.parse(String(encrypted.find((input) => input.payloadKind === "parsed_body")?.plaintext));
    expect(parsedBody.text).toBe("Olá, ações e anotações");
    expect(parsedBody.html).toBe("<p>Olá, ações e anotações</p>");
    expect(encrypted.find((input) => input.payloadKind === "attachment_filename")?.plaintext).toBe(
      "anotações.pdf",
    );
    expect(persistedAttachments[0]).toMatchObject({
      contentType: "application/pdf",
      status: "unscanned",
    });
  });

  test("passes decoded content and attachments through the guardrail gate before persistence", async () => {
    const guarded: unknown[] = [];
    const persistedMessages: MailPersistParsedMessageInput[] = [];

    await processEncryptedRawMimeParseJob({
      job: parseJob(),
      decryptRawMime: async () => encodedRawMime(),
      guardParsedMime: async (input) => {
        guarded.push(input);
        return {
          metadataJson: {
            guardrail: {
              provider: "model_armor",
              delivery: "deliver",
            },
          },
        };
      },
      encryptParsedPayload: async (input) => cipherRef(input.payloadKind),
      persistParsedMessage: async (input) => {
        persistedMessages.push(input);
      },
      persistParsedAttachment: async () => {},
    });

    expect(guarded).toHaveLength(1);
    expect(guarded[0]).toMatchObject({
      schemaVersion: 1,
      subject: "Anotações",
      bodyText: "Olá, ações e anotações",
      bodyHtml: "<p>Olá, ações e anotações</p>",
      attachments: [
        {
          attachmentId: "message_1:attachment:1",
          filename: "anotações.pdf",
          contentType: "application/pdf",
          sizeBytes: 16,
        },
      ],
    });
    expect(persistedMessages[0]?.metadataJson).toEqual({
      guardrail: {
        provider: "model_armor",
        delivery: "deliver",
      },
    });
  });

  test("records a safe failure for malformed MIME without persisting parsed payloads", async () => {
    const encrypted: MailEncryptParsedPayloadInput[] = [];
    const persistedMessages: MailPersistParsedMessageInput[] = [];
    const failures: unknown[] = [];

    const result = await processEncryptedRawMimeParseJob({
      job: parseJob(),
      decryptRawMime: async () => "this is not a valid MIME message",
      encryptParsedPayload: async (input) => {
        encrypted.push(input);
        return cipherRef(input.payloadKind);
      },
      persistParsedMessage: async (input) => {
        persistedMessages.push(input);
      },
      persistParsedAttachment: async () => {},
      recordParseFailure: async (input) => {
        failures.push(input);
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "malformed_mime",
    });
    expect(encrypted).toEqual([]);
    expect(persistedMessages).toEqual([]);
    expect(failures).toEqual([
      {
        requestId: "req_1",
        organizationId: "org_1",
        projectId: "proj_1",
        mailboxId: "mailbox_1",
        messageId: "message_1",
        reason: "malformed_mime",
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain("this is not a valid MIME message");
  });
});

function parseJob(): MailParseJobInput {
  return {
    schemaVersion: 1,
    requestId: "req_1",
    organizationId: "org_1",
    projectId: "proj_1",
    mailboxId: "mailbox_1",
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
    "Message-ID: <message-1@example.com>",
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

function encodedRawMime(): string {
  return [
    "From: sender@example.com",
    "To: agent@mail.ravi.bot",
    "Subject: =?UTF-8?Q?Anota=C3=A7=C3=B5es?=",
    "Message-ID: <message-encoded@example.com>",
    "Content-Type: multipart/mixed; boundary=encoded",
    "",
    "--encoded",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Ol=C3=A1, a=C3=A7=C3=B5es e anota=C3=A7=C3=B5es",
    "--encoded",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Ol=C3=A1, a=C3=A7=C3=B5es e anota=C3=A7=C3=B5es</p>",
    "--encoded",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=\"=?UTF-8?Q?anota=C3=A7=C3=B5es.pdf?=\"",
    "Content-Transfer-Encoding: base64",
    "",
    "YXR0YWNobWVudCBieXRlcw==",
    "--encoded--",
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
