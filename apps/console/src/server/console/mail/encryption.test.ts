import { describe, expect, test } from "bun:test";

import {
  MAIL_CIPHER_ALGORITHM,
  MAIL_CIPHER_NONCE_BYTES,
  MAIL_CIPHER_SCHEMA_VERSION,
  assertEncryptedMailPayload,
  buildMailCipherAad,
  buildMailCipherAadHash,
  buildMailCipherAadFields,
  decryptMailPayload,
  decryptMailPayloadToString,
  encryptMailPayload,
  generateMailCipherNonce,
  generateMailContentEncryptionKeyBytes,
  type MailCipherScopeInput,
} from "./encryption";

const messageScope = {
  organizationId: "org_1",
  projectId: "project_1",
  mailboxId: "mailbox_1",
  resourceType: "message",
  resourceId: "message_1",
  payloadKind: "parsed_body",
} satisfies MailCipherScopeInput;

describe("Ravi Mail envelope encryption", () => {
  test("builds deterministic AAD bound to the Ravi mail scope", async () => {
    const fields = buildMailCipherAadFields({
      keyVersion: 3,
      scope: messageScope,
    });

    expect(fields).toEqual({
      schemaVersion: MAIL_CIPHER_SCHEMA_VERSION,
      algorithm: MAIL_CIPHER_ALGORITHM,
      organizationId: "org_1",
      projectId: "project_1",
      mailboxId: "mailbox_1",
      resourceType: "message",
      resourceId: "message_1",
      payloadKind: "parsed_body",
      keyVersion: 3,
    });

    const aadText = new TextDecoder().decode(
      buildMailCipherAad({
        keyVersion: 3,
        scope: messageScope,
      }),
    );
    expect(JSON.parse(aadText)).toEqual(fields);

    const bodyHash = await buildMailCipherAadHash({
      keyVersion: 3,
      scope: messageScope,
    });
    const headersHash = await buildMailCipherAadHash({
      keyVersion: 3,
      scope: {
        ...messageScope,
        payloadKind: "headers",
      },
    });
    expect(bodyHash).not.toEqual(headersHash);
  });

  test("encrypts and decrypts with AES-256-GCM without durable plaintext", async () => {
    const key = generateMailContentEncryptionKeyBytes();
    const plaintext = "Sensitive email body with account details.";
    const payload = await encryptMailPayload({
      plaintext,
      key,
      keyVersion: 4,
      wrappedKeyRef: "mail_key_wraps/org_1/mailbox_1/v4",
      scope: messageScope,
      createdAt: "2026-05-11T00:00:00.000Z",
    });

    assertEncryptedMailPayload(payload);
    expect(payload).not.toHaveProperty("plaintext");
    expect(payload).not.toHaveProperty("cleartext");
    expect(payload.ciphertext).not.toEqual(plaintext);
    expect(payload.cipherRef.algorithm).toBe("AES-256-GCM");
    expect(payload.cipherRef.tag.length).toBeGreaterThan(0);

    await expect(
      decryptMailPayloadToString({
        payload,
        key,
        scope: messageScope,
      }),
    ).resolves.toBe(plaintext);
  });

  test("round-trips payload bytes with key version metadata", async () => {
    const key = generateMailContentEncryptionKeyBytes();
    const payload = await encryptMailPayload({
      plaintext: "Subject line",
      key,
      keyVersion: 7,
      wrappedKeyRef: "mail_key_wraps/org_1/mailbox_1/v7",
      scope: {
        ...messageScope,
        payloadKind: "subject",
      },
      createdAt: "2026-05-11T12:00:00.000Z",
      ciphertextRef: "object://mail/org_1/mailbox_1/message_1/subject",
    });

    expect(payload.cipherRef).toMatchObject({
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      wrappedKeyRef: "mail_key_wraps/org_1/mailbox_1/v7",
      keyVersion: 7,
      createdAt: "2026-05-11T12:00:00.000Z",
      ciphertextRef: "object://mail/org_1/mailbox_1/message_1/subject",
      keyScope: {
        organizationId: "org_1",
        projectId: "project_1",
        mailboxId: "mailbox_1",
        resourceType: "message",
        resourceId: "message_1",
        payloadKind: "subject",
      },
    });
    expect(payload.cipherRef.aadHash.startsWith("sha256:")).toBe(true);

    await expect(
      decryptMailPayloadToString({
        payload,
        key,
        scope: {
          ...messageScope,
          payloadKind: "subject",
        },
      }),
    ).resolves.toBe("Subject line");
  });

  test("fails decrypt when AAD scope changes", async () => {
    const key = generateMailContentEncryptionKeyBytes();
    const payload = await encryptMailPayload({
      plaintext: "Bound to one message only.",
      key,
      keyVersion: 2,
      wrappedKeyRef: "mail_key_wraps/org_1/mailbox_1/v2",
      scope: messageScope,
    });

    const wrongScopes = [
      {
        ...messageScope,
        organizationId: "org_2",
      },
      {
        ...messageScope,
        mailboxId: "mailbox_2",
      },
      {
        ...messageScope,
        resourceId: "message_2",
      },
      {
        ...messageScope,
        payloadKind: "headers",
      },
    ] satisfies MailCipherScopeInput[];

    for (const scope of wrongScopes) {
      await expect(
        decryptMailPayload({
          payload,
          key,
          scope,
        }),
      ).rejects.toThrow("Unable to decrypt mail payload.");
    }
  });

  test("fails decrypt when the cipher ref AAD hash is tampered", async () => {
    const key = generateMailContentEncryptionKeyBytes();
    const payload = await encryptMailPayload({
      plaintext: "AAD metadata matters.",
      key,
      keyVersion: 1,
      wrappedKeyRef: "mail_key_wraps/org_1/mailbox_1/v1",
      scope: messageScope,
    });

    await expect(
      decryptMailPayload({
        payload: {
          ...payload,
          cipherRef: {
            ...payload.cipherRef,
            aadHash: "sha256:tampered",
          },
        },
        key,
        scope: messageScope,
      }),
    ).rejects.toThrow("Unable to decrypt mail payload.");
  });

  test("generates random 96-bit nonces", () => {
    const nonces = new Set<string>();

    for (let index = 0; index < 128; index += 1) {
      const nonce = generateMailCipherNonce();
      expect(nonce.byteLength).toBe(MAIL_CIPHER_NONCE_BYTES);
      nonces.add(Array.from(nonce).join("."));
    }

    expect(nonces.size).toBe(128);
  });
});
