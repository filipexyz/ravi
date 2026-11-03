import { describe, expect, test } from "bun:test";

import { base64UrlEncode, decryptRawMimeForTest, encryptRawMime, isValidRootKeyBase64, type MailEncryptionAad } from "./crypto";

describe("ravi mail worker crypto", () => {
  test("encrypts raw MIME with AES-GCM metadata and decrypts only with matching AAD", async () => {
    const plaintext = new TextEncoder().encode("Subject: Plain subject\r\n\r\nsecret body").buffer;
    const aad = encryptionAad();
    const encrypted = await encryptRawMime({
      plaintext,
      aad,
      env: {
        RAVI_MAIL_ROOT_KEY_BASE64: rootKeyBase64(),
        RAVI_MAIL_KEY_VERSION: "mail-key-v1",
      },
      now: () => new Date("2026-05-11T03:00:00.000Z"),
    });

    expect(encrypted.keyVersion).toBe("mail-key-v1");
    expect(encrypted.cipherRef).toMatchObject({
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      ciphertextRef: "",
      wrappedKeyRef: "inline:mail-key-v1",
      keyVersion: 1,
      keyVersionLabel: "mail-key-v1",
      wrappedKey: {
        algorithm: "AES-256-GCM",
        keyVersion: "mail-key-v1",
      },
      createdAt: "2026-05-11T03:00:00.000Z",
    });
    expect(encrypted.sizeBytes).toBeGreaterThan(plaintext.byteLength);
    expect(JSON.stringify(encrypted.cipherRef)).not.toContain("Plain subject");
    expect(JSON.stringify(encrypted.cipherRef)).not.toContain("secret body");
    expect(new TextDecoder().decode(encrypted.ciphertext as ArrayBuffer)).not.toContain("secret body");

    const decrypted = await decryptRawMimeForTest({
      ciphertext: encrypted.ciphertext as ArrayBuffer,
      cipherRef: encrypted.cipherRef,
      aad,
      env: {
        RAVI_MAIL_ROOT_KEY_BASE64: rootKeyBase64(),
      },
    });
    expect(new TextDecoder().decode(decrypted)).toBe("Subject: Plain subject\r\n\r\nsecret body");

    await expect(
      decryptRawMimeForTest({
        ciphertext: encrypted.ciphertext as ArrayBuffer,
        cipherRef: encrypted.cipherRef,
        aad: {
          ...aad,
          mailboxId: "other_mailbox",
        },
        env: {
          RAVI_MAIL_ROOT_KEY_BASE64: rootKeyBase64(),
        },
      }),
    ).rejects.toThrow();
  });

  test("validates the local root key shape without exposing key material", () => {
    expect(isValidRootKeyBase64(rootKeyBase64())).toBe(true);
    expect(isValidRootKeyBase64(base64UrlEncode(new Uint8Array(16)))).toBe(false);
    expect(isValidRootKeyBase64(undefined)).toBe(false);
  });
});

function encryptionAad(): MailEncryptionAad {
  return {
    organizationId: "org_1",
    projectId: "proj_1",
    mailboxId: "mailbox_1",
    messageId: "message_1",
    routeId: "route_1",
    payloadKind: "raw_mime",
    keyVersionPurpose: "mail_message",
  };
}

function rootKeyBase64(): string {
  return base64UrlEncode(new Uint8Array(32).fill(9));
}
