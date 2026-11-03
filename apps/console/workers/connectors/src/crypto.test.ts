import { describe, expect, test } from "bun:test";

import {
  ConnectorCryptoError,
  createDek,
  decryptPayload,
  encryptPayload,
  importRootWrapKey,
  unwrapDek,
  type ConnectorEncryptionAad,
} from "./crypto";

const ROOT_KEY_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 zero-padded bytes
const ALT_ROOT_KEY_BASE64 = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";

function baseAad(): ConnectorEncryptionAad {
  return {
    organizationId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    providerConnectionId: "33333333-3333-3333-3333-333333333333",
    payloadKind: "access_token",
    dekKeyVersion: 1,
    payloadKeyVersion: 1,
    schemaVersion: 1,
  };
}

describe("connector crypto", () => {
  test("imports a 32-byte root wrap key", async () => {
    const key = await importRootWrapKey(ROOT_KEY_BASE64);
    expect(key.algorithm.name).toBe("AES-KW");
  });

  test("rejects root keys with wrong length", async () => {
    await expect(importRootWrapKey("c2hvcnQ=")).rejects.toMatchObject({
      code: "import_failed",
    });
  });

  test("encrypts and decrypts a payload with matching AAD", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const aad = baseAad();
    const enc = await encryptPayload({
      plaintext: "ya29.fake-access-token",
      aad,
      dek: dek.key,
    });

    const plaintext = await decryptPayload({
      ciphertextBase64: enc.ciphertextBase64,
      nonceBase64: enc.nonceBase64,
      aadHash: enc.aadHash,
      wrappedDekBase64: dek.wrappedDekBase64,
      aad,
      rootWrapKey: root,
    });

    expect(plaintext).toBe("ya29.fake-access-token");
  });

  test("rejects decrypt when AAD does not match", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const aad = baseAad();
    const enc = await encryptPayload({ plaintext: "secret", aad, dek: dek.key });

    const tamperedAad: ConnectorEncryptionAad = {
      ...aad,
      providerConnectionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };

    await expect(
      decryptPayload({
        ciphertextBase64: enc.ciphertextBase64,
        nonceBase64: enc.nonceBase64,
        aadHash: enc.aadHash,
        wrappedDekBase64: dek.wrappedDekBase64,
        aad: tamperedAad,
        rootWrapKey: root,
      }),
    ).rejects.toMatchObject({ code: "aad_mismatch" });
  });

  test("rejects decrypt when stored AAD hash was swapped", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const aad = baseAad();
    const enc = await encryptPayload({ plaintext: "secret", aad, dek: dek.key });

    await expect(
      decryptPayload({
        ciphertextBase64: enc.ciphertextBase64,
        nonceBase64: enc.nonceBase64,
        aadHash: "00000000",
        wrappedDekBase64: dek.wrappedDekBase64,
        aad,
        rootWrapKey: root,
      }),
    ).rejects.toMatchObject({ code: "aad_mismatch" });
  });

  test("rejects decrypt when ciphertext is tampered", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const aad = baseAad();
    const enc = await encryptPayload({ plaintext: "secret", aad, dek: dek.key });

    const tampered = mutateBase64Byte(enc.ciphertextBase64, 0);

    await expect(
      decryptPayload({
        ciphertextBase64: tampered,
        nonceBase64: enc.nonceBase64,
        aadHash: enc.aadHash,
        wrappedDekBase64: dek.wrappedDekBase64,
        aad,
        rootWrapKey: root,
      }),
    ).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  test("uses unique nonces across encryptions of the same payload", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const aad = baseAad();
    const a = await encryptPayload({ plaintext: "same", aad, dek: dek.key });
    const b = await encryptPayload({ plaintext: "same", aad, dek: dek.key });
    expect(a.nonceBase64).not.toBe(b.nonceBase64);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });

  test("unwraps a previously wrapped DEK", async () => {
    const root = await importRootWrapKey(ROOT_KEY_BASE64);
    const dek = await createDek(root);
    const recovered = await unwrapDek(dek.wrappedDekBase64, root);
    expect(recovered.algorithm.name).toBe("AES-GCM");
  });

  test("rejects unwrap with the wrong root key", async () => {
    const rootA = await importRootWrapKey(ROOT_KEY_BASE64);
    const rootB = await importRootWrapKey(ALT_ROOT_KEY_BASE64);
    const dek = await createDek(rootA);
    await expect(unwrapDek(dek.wrappedDekBase64, rootB)).rejects.toMatchObject({
      code: "unwrap_failed",
    });
  });

  test("ConnectorCryptoError carries machine-readable code", async () => {
    try {
      await importRootWrapKey("xx");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorCryptoError);
      expect((error as ConnectorCryptoError).code).toBe("import_failed");
    }
  });
});

function mutateBase64Byte(base64: string, offset: number): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  bytes[offset] = bytes[offset]! ^ 0xff;
  let mutated = "";
  for (let i = 0; i < bytes.length; i += 1) mutated += String.fromCharCode(bytes[i]!);
  return btoa(mutated);
}
