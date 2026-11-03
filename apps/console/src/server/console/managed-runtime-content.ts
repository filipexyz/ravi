import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { JsonRecord } from "@/server/db/schema";

const CONTENT_SCHEMA = "ravi.managed-runtime.content/v1";
const CONTENT_ALGORITHM = "A256GCM";
const CONTENT_KEY_VERSION = 1;
const CONTENT_KEY_ENV = "RAVI_MANAGED_RUNTIME_CONTENT_KEY";
const MAX_PLAINTEXT_BYTES = 512 * 1024;

export type ManagedRuntimeContentScope = {
  organizationId: string;
  projectId: string | null;
  instanceId: string;
  sessionId: string | null;
  commandId: string | null;
  chatId?: string | null;
  messageId?: string | null;
  actorId?: string | null;
  purpose:
    | "command_input"
    | "command_result"
    | "session_event"
    | "chat_message";
};

export type ManagedRuntimeContentCodec = {
  decrypt(envelope: JsonRecord, scope: ManagedRuntimeContentScope): unknown;
  encrypt(value: unknown, scope: ManagedRuntimeContentScope): JsonRecord;
};

export class ManagedRuntimeContentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManagedRuntimeContentError";
  }
}

export function managedRuntimeContentCodec(
  env: NodeJS.ProcessEnv = process.env,
): ManagedRuntimeContentCodec {
  return managedRuntimeContentCodecFromKey(readContentKey(env));
}

export function managedRuntimeContentCodecFromKey(
  key: Uint8Array,
): ManagedRuntimeContentCodec {
  if (key.byteLength !== 32) {
    throw new ManagedRuntimeContentError("managed_runtime_content_key_invalid");
  }
  const keyBytes = Buffer.from(key);

  return {
    encrypt(value, scope) {
      const plaintext = Buffer.from(JSON.stringify(value), "utf8");
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new ManagedRuntimeContentError("managed_runtime_content_too_large");
      }
      const aad = contentAad(scope);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        schemaVersion: CONTENT_SCHEMA,
        algorithm: CONTENT_ALGORITHM,
        keyVersion: CONTENT_KEY_VERSION,
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        aadHash: createHash("sha256").update(aad).digest("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      };
    },

    decrypt(envelope, scope) {
      assertEnvelope(envelope);
      const aad = contentAad(scope);
      const aadHash = createHash("sha256").update(aad).digest("base64url");
      if (envelope.aadHash !== aadHash) {
        throw new ManagedRuntimeContentError("managed_runtime_content_scope_mismatch");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          keyBytes,
          Buffer.from(envelope.nonce as string, "base64url"),
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(envelope.tag as string, "base64url"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext as string, "base64url")),
          decipher.final(),
        ]);
        if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
          throw new ManagedRuntimeContentError("managed_runtime_content_too_large");
        }
        return JSON.parse(plaintext.toString("utf8"));
      } catch (error) {
        if (error instanceof ManagedRuntimeContentError) throw error;
        throw new ManagedRuntimeContentError("managed_runtime_content_decrypt_failed");
      }
    },
  };
}

function readContentKey(env: NodeJS.ProcessEnv): Buffer {
  const value = env[CONTENT_KEY_ENV]?.trim();
  if (!value) {
    throw new ManagedRuntimeContentError("managed_runtime_content_key_missing");
  }
  try {
    const key = Buffer.from(value, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== value) {
      throw new Error("invalid key");
    }
    return key;
  } catch {
    throw new ManagedRuntimeContentError("managed_runtime_content_key_invalid");
  }
}

function contentAad(scope: ManagedRuntimeContentScope): Buffer {
  const legacyScope = [
    CONTENT_SCHEMA,
    `organization:${scope.organizationId}`,
    `project:${scope.projectId ?? "-"}`,
    `instance:${scope.instanceId}`,
    `session:${scope.sessionId ?? "-"}`,
    `command:${scope.commandId ?? "-"}`,
  ];
  return Buffer.from(
    (scope.purpose === "chat_message"
      ? [
          ...legacyScope,
          `chat:${scope.chatId ?? "-"}`,
          `message:${scope.messageId ?? "-"}`,
          `actor:${scope.actorId ?? "-"}`,
          `purpose:${scope.purpose}`,
        ]
      : [...legacyScope, `purpose:${scope.purpose}`]
    ).join("\n"),
    "utf8",
  );
}

function assertEnvelope(envelope: JsonRecord): void {
  if (
    envelope.schemaVersion !== CONTENT_SCHEMA ||
    envelope.algorithm !== CONTENT_ALGORITHM ||
    envelope.keyVersion !== CONTENT_KEY_VERSION ||
    !base64Url(envelope.nonce, 16) ||
    !base64Url(envelope.tag, 22) ||
    !base64Url(envelope.aadHash, 43) ||
    typeof envelope.ciphertext !== "string" ||
    !/^[A-Za-z0-9_-]*$/.test(envelope.ciphertext)
  ) {
    throw new ManagedRuntimeContentError("managed_runtime_content_envelope_invalid");
  }
}

function base64Url(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
