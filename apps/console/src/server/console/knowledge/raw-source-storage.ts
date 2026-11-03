import * as Sentry from "@sentry/nextjs";
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";

export type KnowledgeRawSourceStatus = "pending" | "stored" | "external";
export type KnowledgeRawStorageBackend = "none" | "object_storage" | "external";

export type KnowledgeRawSourcePrivateRef = {
  schemaVersion: 1;
  status: KnowledgeRawSourceStatus;
  visibility: "private";
  storageBackend: KnowledgeRawStorageBackend;
  provider?: "cloudflare_r2";
  key?: string;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  storedAt?: string;
};

export type KnowledgeRawSourceSafeMetadata = {
  status: KnowledgeRawSourceStatus;
  storageBackend: KnowledgeRawStorageBackend;
  sha256: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  storedAt: number | null;
};

export type KnowledgeRawSourceObjectStore = {
  getObject(key: string): Promise<ArrayBuffer | null>;
  putObject(input: {
    body: ArrayBuffer;
    contentType: string;
    key: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<void>;
};

export type PutKnowledgeRawSourceObjectInput = {
  body: ArrayBuffer | ArrayBufferView | string;
  contentType?: string | null;
  documentId: string;
  filename?: string | null;
  organizationId: string;
  projectId: string;
  sourceId: string;
  store: KnowledgeRawSourceObjectStore;
};

type R2StorageConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint: URL;
  region: string;
  secretAccessKey: string;
};

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

export function pendingKnowledgeRawSourceRef(): KnowledgeRawSourcePrivateRef {
  return {
    schemaVersion: 1,
    status: "pending",
    visibility: "private",
    storageBackend: "none",
  };
}

/**
 * Written to `raw_ref_json` when the raw vault PUT after commit fails. Readers
 * treat it as "no raw copy" (pending): the chunks are already committed.
 */
export function failedKnowledgeRawSourceRef() {
  return {
    schemaVersion: 1 as const,
    status: "failed" as const,
    visibility: "private" as const,
    storageBackend: "none" as const,
  };
}

export function knowledgeRawSourceSafeMetadata(value: unknown): KnowledgeRawSourceSafeMetadata {
  const ref = privateRef(value);
  return {
    status: ref.status,
    storageBackend: ref.storageBackend,
    sha256: typeof ref.sha256 === "string" ? ref.sha256 : null,
    sizeBytes: typeof ref.sizeBytes === "number" ? ref.sizeBytes : null,
    contentType: typeof ref.contentType === "string" ? ref.contentType : null,
    storedAt: dateMsOrNull(ref.storedAt),
  };
}

export async function putKnowledgeRawSourceObject(
  input: PutKnowledgeRawSourceObjectInput,
): Promise<KnowledgeRawSourcePrivateRef> {
  const body = bodyToArrayBuffer(input.body);
  const bytes = new Uint8Array(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType = input.contentType?.trim() || DEFAULT_CONTENT_TYPE;
  const key = knowledgeRawSourceObjectKey({
    documentId: input.documentId,
    filename: input.filename,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sha256,
    sourceId: input.sourceId,
  });

  await input.store.putObject({
    body,
    contentType,
    key,
    sha256,
    sizeBytes: bytes.byteLength,
  });

  return {
    schemaVersion: 1,
    status: "stored",
    visibility: "private",
    storageBackend: "object_storage",
    provider: "cloudflare_r2",
    key,
    sha256,
    sizeBytes: bytes.byteLength,
    contentType,
    storedAt: new Date().toISOString(),
  };
}

export async function readKnowledgeRawSourceObject(
  store: KnowledgeRawSourceObjectStore,
  rawRef: unknown,
): Promise<ArrayBuffer | null> {
  const ref = privateRef(rawRef);
  if (ref.status !== "stored" || ref.storageBackend !== "object_storage" || !ref.key) return null;
  return store.getObject(ref.key);
}

export function createKnowledgeRawSourceObjectStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeRawSourceObjectStore | null {
  const bucket = env.RAVI_KNOWLEDGE_R2_BUCKET?.trim();
  const accessKeyId = env.RAVI_KNOWLEDGE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.RAVI_KNOWLEDGE_R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = knowledgeR2EndpointFromEnv(env);
  const region = env.RAVI_KNOWLEDGE_R2_REGION?.trim() || "auto";
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;

  return createR2KnowledgeRawSourceObjectStore({
    accessKeyId,
    bucket,
    endpoint,
    region,
    secretAccessKey,
  });
}

export function createR2KnowledgeRawSourceObjectStore(config: R2StorageConfig): KnowledgeRawSourceObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });

  return {
    async getObject(key) {
      let response: Response;
      try {
        const signed = await client.sign(r2ObjectUrl(config, key).toString(), { method: "GET" });
        response = await fetch(signed);
      } catch (error) {
        logKnowledgeRawStorageError("r2_get_failed", config, key, error);
        throw new Error("knowledge_raw_storage_unavailable");
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        await logKnowledgeRawStorageRejected("r2_get_rejected", config, key, response);
        throw new Error("knowledge_raw_storage_unavailable");
      }
      return response.arrayBuffer();
    },

    async putObject(input) {
      let response: Response;
      try {
        const signed = await client.sign(r2ObjectUrl(config, input.key).toString(), {
          method: "PUT",
          headers: {
            "content-length": String(input.sizeBytes),
            "content-type": input.contentType,
            "x-amz-meta-ravi-sha256": input.sha256,
            "x-amz-meta-ravi-visibility": "private",
          },
          body: input.body,
        });
        response = await fetch(signed);
      } catch (error) {
        logKnowledgeRawStorageError("r2_put_failed", config, input.key, error);
        throw new Error("knowledge_raw_storage_unavailable");
      }
      if (!response.ok) {
        await logKnowledgeRawStorageRejected("r2_put_rejected", config, input.key, response);
        throw new Error("knowledge_raw_storage_unavailable");
      }
    },
  };
}

export function knowledgeRawSourceObjectKey(input: {
  documentId: string;
  filename?: string | null;
  organizationId: string;
  projectId: string;
  sha256: string;
  sourceId: string;
}) {
  const basename = safeFilename(input.filename) ?? `raw-${input.sha256}.txt`;
  return [
    "knowledge",
    "raw",
    "org",
    encodeSegment(input.organizationId),
    "project",
    encodeSegment(input.projectId),
    "source",
    encodeSegment(input.sourceId),
    "document",
    encodeSegment(input.documentId),
    basename,
  ].join("/");
}

function privateRef(value: unknown): KnowledgeRawSourcePrivateRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return pendingKnowledgeRawSourceRef();
  const ref = value as Partial<KnowledgeRawSourcePrivateRef>;
  if (ref.schemaVersion !== 1 || ref.visibility !== "private") return pendingKnowledgeRawSourceRef();
  if (ref.status === "stored" && ref.storageBackend === "object_storage") {
    return {
      schemaVersion: 1,
      status: "stored",
      visibility: "private",
      storageBackend: "object_storage",
      provider: ref.provider === "cloudflare_r2" ? "cloudflare_r2" : undefined,
      key: typeof ref.key === "string" ? ref.key : undefined,
      sha256: typeof ref.sha256 === "string" ? ref.sha256 : undefined,
      sizeBytes: typeof ref.sizeBytes === "number" ? ref.sizeBytes : undefined,
      contentType: typeof ref.contentType === "string" ? ref.contentType : undefined,
      storedAt: typeof ref.storedAt === "string" ? ref.storedAt : undefined,
    };
  }
  if (ref.status === "external" && ref.storageBackend === "external") {
    return {
      schemaVersion: 1,
      status: "external",
      visibility: "private",
      storageBackend: "external",
      sha256: typeof ref.sha256 === "string" ? ref.sha256 : undefined,
      sizeBytes: typeof ref.sizeBytes === "number" ? ref.sizeBytes : undefined,
      contentType: typeof ref.contentType === "string" ? ref.contentType : undefined,
      storedAt: typeof ref.storedAt === "string" ? ref.storedAt : undefined,
    };
  }
  return pendingKnowledgeRawSourceRef();
}

function bodyToArrayBuffer(value: ArrayBuffer | ArrayBufferView | string): ArrayBuffer {
  if (typeof value === "string") return toArrayBuffer(new TextEncoder().encode(value));
  if (value instanceof ArrayBuffer) return value;
  return toArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function knowledgeR2EndpointFromEnv(env: NodeJS.ProcessEnv) {
  const configured = env.RAVI_KNOWLEDGE_R2_ENDPOINT?.trim();
  if (configured) return new URL(configured);
  const accountId = env.RAVI_KNOWLEDGE_R2_ACCOUNT_ID?.trim();
  return accountId ? new URL(`https://${accountId}.r2.cloudflarestorage.com`) : null;
}

function r2ObjectUrl(config: Pick<R2StorageConfig, "bucket" | "endpoint">, key: string) {
  const normalizedKey = key
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return new URL(`/${encodeURIComponent(config.bucket)}/${normalizedKey}`, config.endpoint);
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

function safeFilename(value: string | null | undefined) {
  const filename = value
    ?.trim()
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return filename || null;
}

function dateMsOrNull(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function safeObjectKeyPrefix(key: string) {
  return key.split("/").slice(0, 4).join("/");
}

function logKnowledgeRawStorageError(reason: string, config: R2StorageConfig, key: string, error: unknown) {
  console.error("Knowledge raw object storage failed", {
    bucket: config.bucket,
    endpointHost: config.endpoint.hostname,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : "unknown",
    keyPrefix: safeObjectKeyPrefix(key),
    reason,
  });
}

async function logKnowledgeRawStorageRejected(
  reason: string,
  config: R2StorageConfig,
  key: string,
  response: Response,
) {
  const providerError = await sanitizedR2Error(response);
  console.error("Knowledge raw object storage rejected", {
    bucket: config.bucket,
    endpointHost: config.endpoint.hostname,
    keyPrefix: safeObjectKeyPrefix(key),
    providerError,
    reason,
    status: response.status,
    statusText: response.statusText,
  });
  Sentry.captureMessage("Knowledge raw object storage rejected", {
    level: "error",
    tags: {
      feature: "console-knowledge",
      reason,
      status: String(response.status),
    },
    contexts: {
      knowledge: {
        endpointHost: config.endpoint.hostname,
        keyPrefix: safeObjectKeyPrefix(key),
        providerError,
        status: response.status,
        statusText: response.statusText,
      },
    },
  });
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
