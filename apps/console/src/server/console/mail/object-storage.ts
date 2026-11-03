import { AwsClient } from "aws4fetch";
import * as Sentry from "@sentry/nextjs";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  encryptMailWorkerPayload,
  type MailEncryptionAad,
} from "../../../../workers/mail/src/crypto";
import type { MailDecryptPayloadKind, MailMessagePayloadKind, MailPayloadDecrypter } from "./service";
import type { MailCipherRef, MailMessage } from "./storage";

export type MailObjectStore = {
  getObject(key: string): Promise<ArrayBuffer | null>;
  putObject(key: string, value: ArrayBuffer | string | ReadableStream): Promise<void>;
};

export type MailPayloadDecrypterConfig = {
  objectStore: MailObjectStore;
  rootKeyBase64: string;
};

export type MailPayloadEncryptorConfig = MailPayloadDecrypterConfig & {
  keyVersion?: string;
};

export type EncryptMailMessagePayloadInput = {
  direction: "inbound" | "outbound";
  mailboxId: string;
  messageId: string;
  organizationId: string;
  payloadKind: MailMessagePayloadKind;
  plaintext: string | ArrayBuffer | ArrayBufferView;
  projectId?: string | null;
  routeId?: string | null;
};

export type EncryptMailMessagePayloadResult = {
  cipherRef: MailCipherRef;
  ciphertextSizeBytes: number;
  objectRef: string;
  plaintextSizeBytes: number;
  sha256: string;
};

export type MailPayloadEncryptor = {
  encryptMessagePayload(input: EncryptMailMessagePayloadInput): Promise<EncryptMailMessagePayloadResult>;
};

type WorkerMailCipherRef = MailCipherRef & {
  nonce: string;
  wrappedKey: {
    algorithm: "AES-256-GCM";
    keyVersion: string;
    nonce: string;
    ciphertext: string;
  };
  keyVersionLabel?: string;
  keyScope: {
    organizationId: string;
    projectId?: string | null;
    mailboxId: string;
    messageId: string;
    routeId?: string | null;
    attachmentId?: string | null;
    payloadKind: MailMessagePayloadKind | "attachment_filename" | "attachment_object";
    keyVersionPurpose: "mail_message";
  };
};

const AES_GCM = "AES-GCM";

export function createMailPayloadDecrypter(config: MailPayloadDecrypterConfig): MailPayloadDecrypter {
  return {
    async decryptMessagePayload({ attachmentId, cipherRef, message, payloadKind }) {
      const ref = assertWorkerCipherRef(cipherRef, payloadKind, message, attachmentId ?? null);
      const ciphertext = await config.objectStore.getObject(ref.ciphertextRef);
      if (!ciphertext) {
        logMailDecryptFailure("object_missing", { message, payloadKind, ref });
        throw mailDecryptError("object_missing");
      }

      let cekBytes: ArrayBuffer;
      try {
        const rootKey = await importAesGcmKey(decodeBase64Url(config.rootKeyBase64));
        const keyVersion = ref.keyVersionLabel ?? ref.wrappedKey.keyVersion;
        cekBytes = await crypto.subtle.decrypt(
          {
            name: AES_GCM,
            iv: toArrayBuffer(decodeBase64Url(ref.wrappedKey.nonce)),
            additionalData: aadBytes(ref.keyScope, keyVersion, "wrap"),
            tagLength: 128,
          },
          rootKey,
          toArrayBuffer(decodeBase64Url(ref.wrappedKey.ciphertext)),
        );
      } catch {
        logMailDecryptFailure("unwrap_failed", { message, payloadKind, ref });
        throw mailDecryptError("unwrap_failed");
      }

      try {
        const keyVersion = ref.keyVersionLabel ?? ref.wrappedKey.keyVersion;
        const cekKey = await importAesGcmKey(new Uint8Array(cekBytes));
        const plaintext = await crypto.subtle.decrypt(
          {
            name: AES_GCM,
            iv: toArrayBuffer(decodeBase64Url(ref.nonce)),
            additionalData: aadBytes(ref.keyScope, keyVersion, "payload"),
            tagLength: 128,
          },
          cekKey,
          ciphertext,
        );

        return new TextDecoder().decode(plaintext);
      } catch {
        logMailDecryptFailure("payload_decrypt_failed", { message, payloadKind, ref });
        throw mailDecryptError("payload_decrypt_failed");
      }
    },
  };
}

export function createMailPayloadEncryptor(config: MailPayloadEncryptorConfig): MailPayloadEncryptor {
  return {
    async encryptMessagePayload(input) {
      const plaintext = plaintextToArrayBuffer(input.plaintext);
      const objectRef = mailMessagePayloadObjectRef(input);
      const aad: MailEncryptionAad = {
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        routeId: input.routeId ?? null,
        payloadKind: input.payloadKind,
        keyVersionPurpose: "mail_message",
      };
      const encrypted = await encryptMailWorkerPayload({
        plaintext,
        aad,
        ciphertextRef: objectRef,
        env: {
          RAVI_MAIL_ROOT_KEY_BASE64: config.rootKeyBase64,
          RAVI_MAIL_KEY_VERSION: config.keyVersion ?? process.env.RAVI_MAIL_KEY_VERSION ?? "1",
        },
      });

      await config.objectStore.putObject(objectRef, await encryptedBodyToArrayBuffer(encrypted.ciphertext));

      return {
        cipherRef: encrypted.cipherRef as MailCipherRef,
        ciphertextSizeBytes: encrypted.sizeBytes,
        objectRef,
        plaintextSizeBytes: plaintext.byteLength,
        sha256: encrypted.sha256,
      };
    },
  };
}

export function createMailPayloadDecrypterFromEnv(): MailPayloadDecrypter | null {
  const rootKeyBase64 = process.env.RAVI_MAIL_ROOT_KEY_BASE64?.trim();
  const objectStore = createMailR2ObjectStoreFromEnv();
  if (!rootKeyBase64 || !objectStore) return null;
  return createMailPayloadDecrypter({ objectStore, rootKeyBase64 });
}

export function createMailPayloadEncryptorFromEnv(): MailPayloadEncryptor | null {
  const rootKeyBase64 = process.env.RAVI_MAIL_ROOT_KEY_BASE64?.trim();
  const objectStore = createMailR2ObjectStoreFromEnv();
  if (!rootKeyBase64 || !objectStore) return null;
  return createMailPayloadEncryptor({
    objectStore,
    rootKeyBase64,
    keyVersion: process.env.RAVI_MAIL_KEY_VERSION?.trim() || "1",
  });
}

export function createMailR2ObjectStoreFromEnv(): MailObjectStore | null {
  const bucket = process.env.RAVI_MAIL_R2_BUCKET?.trim();
  const accessKeyId = process.env.RAVI_MAIL_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.RAVI_MAIL_R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = mailR2EndpointFromEnv();
  const region = process.env.RAVI_MAIL_R2_REGION?.trim() || "auto";
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region,
  });

  return {
    async getObject(key) {
      let response: Response;
      try {
        const signed = await client.sign(mailR2ObjectUrl({ bucket, endpoint }, key).toString(), { method: "GET" });
        response = await fetch(signed);
      } catch (error) {
        console.error("Ravi Mail R2 object fetch failed", {
          bucket,
          endpointHost: endpoint.hostname,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : "unknown",
          keyPrefix: safeObjectKeyPrefix(key),
        });
        throw mailDecryptError();
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        const providerError = await sanitizedR2Error(response);
        console.error("Ravi Mail R2 object fetch rejected", {
          bucket,
          endpointHost: endpoint.hostname,
          keyPrefix: safeObjectKeyPrefix(key),
          providerError,
          status: response.status,
          statusText: response.statusText,
        });
        Sentry.captureMessage("Ravi Mail R2 object fetch rejected", {
          level: "error",
          tags: {
            feature: "ravi-mail",
            reason: "r2_fetch_rejected",
            status: String(response.status),
          },
          contexts: {
            mail: {
              bucket,
              endpointHost: endpoint.hostname,
              keyPrefix: safeObjectKeyPrefix(key),
              providerError,
              status: response.status,
              statusText: response.statusText,
            },
          },
        });
        throw mailDecryptError("r2_fetch_rejected");
      }
      return response.arrayBuffer();
    },
    async putObject(key, value) {
      let response: Response;
      try {
        const body = objectStoreBody(value);
        const signed = await client.sign(mailR2ObjectUrl({ bucket, endpoint }, key).toString(), {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            ...(body.contentLength !== null ? { "content-length": String(body.contentLength) } : {}),
          },
          body: body.value,
        });
        response = await fetch(signed);
      } catch (error) {
        console.error("Ravi Mail R2 object put failed", {
          bucket,
          endpointHost: endpoint.hostname,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : "unknown",
          keyPrefix: safeObjectKeyPrefix(key),
        });
        throw mailDecryptError("r2_put_failed");
      }
      if (!response.ok) {
        const providerError = await sanitizedR2Error(response);
        console.error("Ravi Mail R2 object put rejected", {
          bucket,
          endpointHost: endpoint.hostname,
          keyPrefix: safeObjectKeyPrefix(key),
          providerError,
          status: response.status,
          statusText: response.statusText,
        });
        Sentry.captureMessage("Ravi Mail R2 object put rejected", {
          level: "error",
          tags: {
            feature: "ravi-mail",
            reason: "r2_put_rejected",
            status: String(response.status),
          },
          contexts: {
            mail: {
              bucket,
              endpointHost: endpoint.hostname,
              keyPrefix: safeObjectKeyPrefix(key),
              providerError,
              status: response.status,
              statusText: response.statusText,
            },
          },
        });
        throw mailDecryptError("r2_put_rejected");
      }
    },
  };
}

function objectStoreBody(value: ArrayBuffer | string | ReadableStream): {
  contentLength: number | null;
  value: ArrayBuffer | string | ReadableStream;
} {
  if (typeof value === "string") {
    return {
      contentLength: new TextEncoder().encode(value).byteLength,
      value,
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      contentLength: value.byteLength,
      value,
    };
  }
  return {
    contentLength: null,
    value,
  };
}

function mailMessagePayloadObjectRef(input: EncryptMailMessagePayloadInput): string {
  const filename = input.payloadKind === "raw_mime" ? "raw.mime.enc" : `${input.payloadKind}.enc`;
  return `mail/org/${encodeSegment(input.organizationId)}/mailbox/${encodeSegment(
    input.mailboxId,
  )}/message/${encodeSegment(input.messageId)}/${encodeSegment(input.direction)}/${filename}`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function plaintextToArrayBuffer(value: string | ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (typeof value === "string") return toArrayBuffer(new TextEncoder().encode(value));
  if (value instanceof ArrayBuffer) return value;
  return toArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

async function encryptedBodyToArrayBuffer(
  value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
): Promise<ArrayBuffer> {
  if (typeof value === "string") return toArrayBuffer(new TextEncoder().encode(value));
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return toArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return new Response(value).arrayBuffer();
}

function assertWorkerCipherRef(
  value: MailCipherRef,
  payloadKind: MailDecryptPayloadKind,
  message: MailMessage,
  attachmentId: string | null,
): WorkerMailCipherRef {
  const ref = value as Partial<WorkerMailCipherRef>;
  if (
    ref.schemaVersion !== 1 ||
    ref.algorithm !== "AES-256-GCM" ||
    typeof ref.ciphertextRef !== "string" ||
    typeof ref.nonce !== "string" ||
    typeof ref.wrappedKeyRef !== "string" ||
    typeof ref.keyVersion !== "number" ||
    typeof ref.createdAt !== "string" ||
    !ref.wrappedKey ||
    ref.wrappedKey.algorithm !== "AES-256-GCM" ||
    typeof ref.wrappedKey.keyVersion !== "string" ||
    typeof ref.wrappedKey.nonce !== "string" ||
    typeof ref.wrappedKey.ciphertext !== "string" ||
    !ref.keyScope
  ) {
    logMailDecryptFailure("cipher_ref_invalid", { message, payloadKind });
    throw mailDecryptError("cipher_ref_invalid");
  }

  const keyScope = ref.keyScope;
  if (
    keyScope.organizationId !== message.organizationId ||
    keyScope.projectId !== message.projectId ||
    keyScope.mailboxId !== message.mailboxId ||
    keyScope.messageId !== message.id ||
    keyScope.payloadKind !== payloadKind ||
    (attachmentId !== null && keyScope.attachmentId !== attachmentId)
  ) {
    logMailDecryptFailure("cipher_scope_mismatch", { message, payloadKind, ref: ref as WorkerMailCipherRef });
    throw mailDecryptError("cipher_scope_mismatch");
  }

  return ref as WorkerMailCipherRef;
}

function mailR2EndpointFromEnv() {
  const configured = process.env.RAVI_MAIL_R2_ENDPOINT?.trim();
  if (configured) return new URL(configured);
  const accountId = process.env.RAVI_MAIL_R2_ACCOUNT_ID?.trim();
  return accountId ? new URL(`https://${accountId}.r2.cloudflarestorage.com`) : null;
}

function mailR2ObjectUrl(config: { bucket: string; endpoint: URL }, key: string) {
  const normalizedKey = key
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return new URL(`/${encodeURIComponent(config.bucket)}/${normalizedKey}`, config.endpoint);
}

function safeObjectKeyPrefix(key: string) {
  return key.split("/").slice(0, 3).join("/");
}

async function sanitizedR2Error(response: Response) {
  try {
    const text = await response.clone().text();
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    return {
      code: code ?? null,
      message: message ? sanitizeProviderMessage(message) : null,
    };
  } catch {
    return null;
  }
}

function sanitizeProviderMessage(message: string) {
  return message.replace(/[A-Z0-9]{16,}/gi, "[redacted]");
}

function logMailDecryptFailure(
  reason: string,
  input: {
    message: Pick<MailMessage, "id" | "mailboxId" | "organizationId" | "projectId">;
    payloadKind: MailDecryptPayloadKind;
    ref?: Partial<WorkerMailCipherRef>;
  },
) {
  const diagnostics = {
    reason,
    messageId: input.message.id,
    mailboxId: input.message.mailboxId,
    organizationId: input.message.organizationId,
    projectId: input.message.projectId,
    payloadKind: input.payloadKind,
    cipherPayloadKind: input.ref?.keyScope?.payloadKind,
    keyVersion: input.ref?.keyVersion,
    keyVersionLabel: input.ref?.keyVersionLabel ?? input.ref?.wrappedKey?.keyVersion,
    keyScopeMessageId: input.ref?.keyScope?.messageId,
    keyScopeMailboxId: input.ref?.keyScope?.mailboxId,
    keyScopeProjectId: input.ref?.keyScope?.projectId ?? null,
    objectPrefix: input.ref?.ciphertextRef ? safeObjectKeyPrefix(input.ref.ciphertextRef) : undefined,
  };
  console.error("Ravi Mail decrypt failed", diagnostics);
  Sentry.captureMessage("Ravi Mail decrypt failed", {
    level: "error",
    tags: {
      feature: "ravi-mail",
      reason,
      payloadKind: input.payloadKind,
      cipherPayloadKind: String(input.ref?.keyScope?.payloadKind ?? "unknown"),
    },
    contexts: {
      mail: diagnostics,
    },
  });
}

function aadBytes(
  aad: WorkerMailCipherRef["keyScope"],
  keyVersion: string,
  mode: "payload" | "wrap",
): ArrayBuffer {
  const body =
    mode === "payload"
      ? {
          schemaVersion: 1,
          organizationId: aad.organizationId,
          projectId: aad.projectId ?? null,
          mailboxId: aad.mailboxId,
          messageId: aad.messageId,
          routeId: aad.routeId ?? null,
          attachmentId: aad.attachmentId ?? null,
          payloadKind: aad.payloadKind,
          keyVersionPurpose: aad.keyVersionPurpose,
          keyVersion,
        }
      : {
          schemaVersion: 1,
          purpose: "mail_message_cek_wrap",
          organizationId: aad.organizationId,
          projectId: aad.projectId ?? null,
          mailboxId: aad.mailboxId,
          messageId: aad.messageId,
          routeId: aad.routeId ?? null,
          attachmentId: aad.attachmentId ?? null,
          payloadKind: aad.payloadKind,
          keyVersion,
        };
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify(body)));
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function importAesGcmKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: AES_GCM, length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function mailDecryptError(reason?: string): ConsoleApiError {
  return new ConsoleApiError(403, {
    error: "mail_operation_denied",
    ...(reason ? { fieldErrors: { reason } } : {}),
  });
}
