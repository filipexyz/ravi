/**
 * Console -> channel-control Worker HMAC client.
 *
 * This is server-only. It authenticates Vercel intent to the Cloudflare Worker
 * without giving Vercel any Omni service or per-instance API key.
 */

const TIMESTAMP_HEADER = "x-ravi-hmac-timestamp";
const KEY_ID_HEADER = "x-ravi-hmac-key-id";
const SIGNATURE_HEADER = "x-ravi-hmac-signature";

export interface ChannelHmacConfig {
  controlUrl: string;
  keyId: string;
  key: string;
  fetchImpl?: typeof fetch;
}

export class ChannelHmacError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ChannelHmacError";
  }
}

export function getChannelHmacConfig(env: NodeJS.ProcessEnv = process.env): ChannelHmacConfig | null {
  const keyId = env.RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT_ID?.trim();
  const key = env.RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT?.trim();
  if (!keyId || !key) return null;
  const controlUrl = (env.RAVI_CHANNELS_CONTROL_URL?.trim() || "https://channels.ravi.bot").replace(/\/$/, "");
  return { controlUrl, keyId, key };
}

export async function channelHmacRequest<T>(
  config: ChannelHmacConfig,
  input: {
    method: "POST";
    path: string;
    body?: unknown;
  },
): Promise<T> {
  const bodyText = input.body === undefined ? "" : JSON.stringify(input.body);
  const headers = await signHmacRequest({
    key: config.key,
    keyId: config.keyId,
    method: input.method,
    path: input.path,
    bodyText,
  });
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.controlUrl}${input.path}`, {
    method: input.method,
    body: input.body === undefined ? undefined : bodyText,
    headers: {
      Accept: "application/json",
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  });
  const text = await response.text();
  const payload = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const code =
      (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
        ? ((payload as Record<string, unknown>).error as string)
        : null) ?? `http_${response.status}`;
    throw new ChannelHmacError(response.status, code, `Ravi Channels request failed (${response.status})`, payload);
  }
  return payload as T;
}

async function signHmacRequest(input: {
  key: string;
  keyId: string;
  method: string;
  path: string;
  bodyText: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000).toString();
  const bodyHash = await sha256Hex(input.bodyText);
  const signingString = [timestamp, input.method.toUpperCase(), input.path, bodyHash].join("\n");
  const signature = await hmacSha256Base64(input.key, signingString);
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [KEY_ID_HEADER]: input.keyId,
    [SIGNATURE_HEADER]: signature,
  };
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "invalid_response", body: text };
  }
}
