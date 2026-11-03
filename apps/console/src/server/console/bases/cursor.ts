// Opaque keyset cursors for Bases reads. AES-256-GCM under a key derived with
// HKDF-SHA256 from a server secret. A cursor binds the scope (base or view),
// the view version, the schema version, a query hash, and the caller principal,
// and expires after `BASES_LIMITS.cursorTtlMs`.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import { BASES_LIMITS } from "@/shared/bases/limits";

/** What a cursor is bound to. Decoding fails unless every field matches. */
export type BaseCursorBinding = {
  /** `base:<baseId>` for direct reads, `view:<viewId>` for view reads. */
  scope: string;
  /** View version; 0 for direct reads. */
  viewVersion: number;
  schemaVersion: number;
  /** `baseQueryHash` of the normalized filter, sort, and projection. */
  queryHash: string;
  /** Caller principal chosen by the services (for example `user:<id>`). */
  principal: string;
};

export type BaseCursorPayload = BaseCursorBinding & {
  /** Sort values (`__s<i>`) of the last row of the page. */
  values: Array<string | null>;
  /** Epoch milliseconds. */
  issuedAt: number;
};

const TOKEN_PREFIX = "c1.";
const TOKEN_MAX_CHARS = 4096;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_VALUES = 16;
const CLOCK_SKEW_MS = 60_000;
const AAD = Buffer.from("ravi.bases.cursor.c1");
const SECRET_ENV_KEYS = ["RAVI_BASES_CURSOR_SECRET", "RAVI_CLI_ACCESS_TOKEN_SECRET", "WORKOS_COOKIE_PASSWORD"] as const;

let derivedKey: { fingerprint: string; key: Buffer } | null = null;
let processKey: Buffer | null = null;

function cursorKey(): Buffer {
  for (const name of SECRET_ENV_KEYS) {
    const secret = process.env[name]?.trim();
    if (!secret) continue;
    const fingerprint = createHash("sha256").update(`${name}\u0000${secret}`).digest("base64url");
    if (derivedKey?.fingerprint !== fingerprint) {
      derivedKey = { fingerprint, key: Buffer.from(hkdfSync("sha256", secret, "ravi.bases.cursor", "v1", 32)) };
    }
    return derivedKey.key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new ConsoleApiError(503, { error: "bases_cursor_unavailable" });
  }
  processKey ??= randomBytes(32);
  return processKey;
}

function invalid(): never {
  throw new ConsoleApiError(400, { error: "cursor_invalid" });
}

function isCursorValues(value: unknown): value is Array<string | null> {
  return (
    Array.isArray(value) &&
    value.length <= MAX_VALUES &&
    value.every((item) => item === null || typeof item === "string")
  );
}

/** Encrypts a cursor payload into an opaque `c1.` token; `issuedAt` defaults to `now`. */
export function encodeBaseCursor(
  payload: BaseCursorBinding & { values: ReadonlyArray<string | null>; issuedAt?: number },
  now: Date = new Date(),
): string {
  const values = [...payload.values];
  if (!isCursorValues(values)) throw new Error("Cursor values must be strings or null.");
  const body = JSON.stringify({
    s: payload.scope,
    vv: payload.viewVersion,
    sv: payload.schemaVersion,
    q: payload.queryHash,
    p: payload.principal,
    v: values,
    t: payload.issuedAt ?? now.getTime(),
  });
  const key = cursorKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return `${TOKEN_PREFIX}${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
}

/**
 * Decrypts and verifies a cursor against the expected binding. Throws
 * `ConsoleApiError(400, cursor_invalid)` on any mismatch, tampering, bad
 * encoding, or expiry.
 */
export function decodeBaseCursor(token: unknown, expected: BaseCursorBinding, now: Date = new Date()): BaseCursorPayload {
  if (typeof token !== "string" || token.length > TOKEN_MAX_CHARS || !token.startsWith(TOKEN_PREFIX)) invalid();
  const encoded = token.slice(TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES + 2) invalid();
  const key = cursorKey();

  let body: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    invalid();
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    parsed = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConsoleApiError) throw error;
    invalid();
  }

  const { s: scope, vv: viewVersion, sv: schemaVersion, q: queryHash, p: principal, v: values, t: issuedAt } = parsed;
  if (
    scope !== expected.scope ||
    viewVersion !== expected.viewVersion ||
    schemaVersion !== expected.schemaVersion ||
    queryHash !== expected.queryHash ||
    principal !== expected.principal ||
    !isCursorValues(values) ||
    typeof issuedAt !== "number" ||
    !Number.isFinite(issuedAt)
  ) {
    invalid();
  }
  const age = now.getTime() - issuedAt;
  if (age > BASES_LIMITS.cursorTtlMs || age < -CLOCK_SKEW_MS) invalid();
  return { ...expected, values, issuedAt };
}
