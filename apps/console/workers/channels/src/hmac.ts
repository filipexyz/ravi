const TIMESTAMP_HEADER = "x-ravi-hmac-timestamp";
const KEY_ID_HEADER = "x-ravi-hmac-key-id";
const SIGNATURE_HEADER = "x-ravi-hmac-signature";
const MAX_CLOCK_SKEW_SECONDS = 300;

export interface HmacKeyMaterial {
  currentId: string;
  currentKey: string;
  previousId?: string;
  previousKey?: string;
}

export type HmacAuthFailureReason =
  | "missing_headers"
  | "stale_timestamp"
  | "unknown_key_id"
  | "signature_mismatch";

export class HmacAuthError extends Error {
  constructor(public readonly reason: HmacAuthFailureReason) {
    super(reason);
    this.name = "HmacAuthError";
  }
}

export async function verifyHmacRequest(input: {
  request: Request;
  bodyText: string;
  keys: HmacKeyMaterial;
  now?: Date;
}): Promise<void> {
  const timestamp = input.request.headers.get(TIMESTAMP_HEADER);
  const keyId = input.request.headers.get(KEY_ID_HEADER);
  const signatureProvided = input.request.headers.get(SIGNATURE_HEADER);
  if (!timestamp || !keyId || !signatureProvided) {
    throw new HmacAuthError("missing_headers");
  }

  const parsedTs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTs)) throw new HmacAuthError("missing_headers");
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parsedTs) > MAX_CLOCK_SKEW_SECONDS) {
    throw new HmacAuthError("stale_timestamp");
  }

  const key = selectKey(input.keys, keyId);
  if (!key) throw new HmacAuthError("unknown_key_id");

  const url = new URL(input.request.url);
  const signingString = await buildSigningString({
    timestamp,
    method: input.request.method.toUpperCase(),
    path: url.pathname,
    bodyText: input.bodyText,
  });
  const expected = await hmacSha256Base64(key, signingString);
  if (!timingSafeEqualString(expected, signatureProvided)) {
    throw new HmacAuthError("signature_mismatch");
  }
}

function selectKey(keys: HmacKeyMaterial, keyId: string): string | null {
  if (keyId === keys.currentId) return keys.currentKey;
  if (keys.previousId && keys.previousKey && keyId === keys.previousId) return keys.previousKey;
  return null;
}

async function buildSigningString(input: {
  timestamp: string;
  method: string;
  path: string;
  bodyText: string;
}): Promise<string> {
  return [
    input.timestamp,
    input.method,
    input.path,
    await sha256Hex(input.bodyText),
  ].join("\n");
}

async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message) as BufferSource);
  return bufferToBase64(signature);
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message) as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i += 1) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
