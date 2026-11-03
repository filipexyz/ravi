import type { JsonRecord } from "@/server/db/schema";

export const EVENT_PLANE_MAX_SAFE_JSON_BYTES = 16_384;
export const EVENT_PLANE_MAX_TEXT_LENGTH = 512;

const APPROVED_SECRET_REF_PREFIXES = [
  "vault://event-plane/",
  "op://event-plane/",
  "aws-secretsmanager://event-plane/",
  "gcp-secret-manager://event-plane/",
  "azure-keyvault://event-plane/",
  "ravi-secret://event-plane/",
];

const FORBIDDEN_SAFE_KEYS = new Set([
  "accesskey",
  "accesskeyid",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "creds",
  "jwt",
  "natscredentials",
  "natsjwt",
  "natstoken",
  "password",
  "privatekey",
  "seed",
  "secret",
  "secretaccesskey",
  "token",
  "tlskey",
]);

const RAW_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN NATS USER JWT-----/,
  /-----BEGIN NATS USER NKEY SEED-----/,
  /\bSU[A-Z0-9]{40,}\b/,
  /\bSA[A-Z0-9]{40,}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:token|secret|password|private[_-]?key|access[_-]?key)=/i,
  /\bravi_[a-z0-9_]*token/i,
];

export class EventPlaneControlError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "EventPlaneControlError";
  }
}

export function sanitizeEventPlaneSafeMetadata(value: unknown, field = "safeMetadata"): JsonRecord {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EventPlaneControlError(400, `event_plane_invalid_${field}`);
  }
  assertNoSecretLikeFields(value, field);
  const serialized = JSON.stringify(value);
  if (serialized.length > EVENT_PLANE_MAX_SAFE_JSON_BYTES) {
    throw new EventPlaneControlError(400, `event_plane_invalid_${field}`);
  }
  return JSON.parse(serialized) as JsonRecord;
}

export function assertNoSecretLikeFields(value: unknown, field = "metadata"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretLikeFields(item, field);
    return;
  }

  for (const [key, item] of Object.entries(value as JsonRecord)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_SAFE_KEYS.has(normalizedKey)) {
      throw new EventPlaneControlError(400, `event_plane_secret_like_${field}`);
    }
    if (typeof item === "string") assertNoRawSecretText(item, field);
    assertNoSecretLikeFields(item, field);
  }
}

export function assertSafeReference(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new EventPlaneControlError(400, `event_plane_invalid_${field}`);
  }
  assertNoRawSecretText(value, field);
}

export function assertSafeSecretRef(value: string): void {
  assertSafeReference(value, "secret_ref");
  const matchingPrefix = APPROVED_SECRET_REF_PREFIXES.find((prefix) => value.startsWith(prefix));
  if (!matchingPrefix || value.length === matchingPrefix.length || value.includes("?") || value.includes("#")) {
    throw new EventPlaneControlError(400, "event_plane_invalid_secret_ref");
  }
}

function assertNoRawSecretText(value: string, field: string): void {
  for (const pattern of RAW_SECRET_PATTERNS) {
    if (pattern.test(value)) {
      throw new EventPlaneControlError(400, `event_plane_secret_like_${field}`);
    }
  }
}
