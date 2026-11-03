// AES-256-GCM for every `*_encrypted` column of cloud agents, keyed by
// `RAVI_CLOUD_AGENTS_KEY` (32 bytes, base64 or base64url). The additional
// data binds a ciphertext to its organization, purpose and record, so a value
// copied to another row does not decrypt.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { cloudError } from "./errors";

const KEY_ENV = "RAVI_CLOUD_AGENTS_KEY";
const PREFIX = "rca1";
const MAX_PLAINTEXT_BYTES = 1024 * 1024;

export type CloudSecretPurpose =
  | "credential"
  | "prompt"
  | "result"
  | "approval_input"
  | "schedule_prompt"
  | "bridge_token";

export type CloudSecretScope = {
  organizationId: string;
  purpose: CloudSecretPurpose;
  /** The row the value belongs to (credential, run, approval, schedule or bridge id). */
  recordId: string;
};

export type CloudSecretCodec = {
  encrypt(plaintext: string, scope: CloudSecretScope): string;
  decrypt(ciphertext: string, scope: CloudSecretScope): string;
};

/** True when the env key is set and well formed. */
export function cloudAgentsConfigured(env: NodeJS.ProcessEnv = process.env) {
  try {
    readKey(env);
    return true;
  } catch {
    return false;
  }
}

/** The codec, or `cloud_agents_unconfigured` (503) without a valid key. */
export function cloudSecretCodec(env: NodeJS.ProcessEnv = process.env): CloudSecretCodec {
  return cloudSecretCodecFromKey(readKey(env));
}

export function cloudSecretCodecFromKey(key: Uint8Array): CloudSecretCodec {
  if (key.byteLength !== 32) throw unconfigured();
  const keyBytes = Buffer.from(key);
  return {
    encrypt(plaintext, scope) {
      const bytes = Buffer.from(plaintext, "utf8");
      if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
        throw cloudError("validation_failed", "The value is too large to store.");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
      cipher.setAAD(aad(scope));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return [PREFIX, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    decrypt(value, scope) {
      const [prefix, nonce, tag, ciphertext, ...rest] = value.split(".");
      if (prefix !== PREFIX || nonce === undefined || tag === undefined || ciphertext === undefined || rest.length > 0) {
        throw decryptFailed();
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(nonce, "base64url"));
        decipher.setAAD(aad(scope));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw decryptFailed();
      }
    },
  };
}

function readKey(env: NodeJS.ProcessEnv) {
  const value = env[KEY_ENV]?.trim();
  if (!value) throw unconfigured();
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.byteLength !== 32) throw unconfigured();
  return key;
}

function aad(scope: CloudSecretScope) {
  return Buffer.from(
    [`ravi.cloud-agents/${PREFIX}`, `organization:${scope.organizationId}`, `purpose:${scope.purpose}`, `record:${scope.recordId}`].join("\n"),
    "utf8",
  );
}

function unconfigured() {
  return cloudError("cloud_agents_unconfigured", "Cloud agents are not configured on this Console (RAVI_CLOUD_AGENTS_KEY).");
}

function decryptFailed() {
  return cloudError("provider_error", "A stored cloud agents value could not be decrypted.");
}
