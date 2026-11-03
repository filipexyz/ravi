import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_HEADER = "x-ravi-hmac-timestamp";
const KEY_ID_HEADER = "x-ravi-hmac-key-id";
const SIGNATURE_HEADER = "x-ravi-hmac-signature";
const MAX_CLOCK_SKEW_SECONDS = 300;

export type McpHmacConfig = {
  currentId: string;
  currentKey: string;
  previousId?: string;
  previousKey?: string;
};

export class McpHmacError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "McpHmacError";
  }
}

export function getMcpHmacConfig(env: NodeJS.ProcessEnv = process.env): McpHmacConfig | null {
  const currentId = env.RAVI_MCP_WORKER_HMAC_KEY_CURRENT_ID?.trim();
  const currentKey = env.RAVI_MCP_WORKER_HMAC_KEY_CURRENT?.trim();
  if (!currentId || !currentKey) return null;
  return {
    currentId,
    currentKey,
    previousId: env.RAVI_MCP_WORKER_HMAC_KEY_PREVIOUS_ID?.trim() || undefined,
    previousKey: env.RAVI_MCP_WORKER_HMAC_KEY_PREVIOUS?.trim() || undefined,
  };
}

export async function verifyMcpHmacRequest(input: {
  request: Request;
  bodyText: string;
  config?: McpHmacConfig | null;
}) {
  const config = input.config ?? getMcpHmacConfig();
  if (!config) throw new McpHmacError("server_not_configured");

  const timestamp = input.request.headers.get(TIMESTAMP_HEADER);
  const keyId = input.request.headers.get(KEY_ID_HEADER);
  const signature = input.request.headers.get(SIGNATURE_HEADER);
  if (!timestamp || !keyId || !signature) throw new McpHmacError("missing_hmac");

  const parsedTimestamp = Number.parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > MAX_CLOCK_SKEW_SECONDS) {
    throw new McpHmacError("stale_hmac");
  }

  const key = selectKey(config, keyId);
  if (!key) throw new McpHmacError("unknown_hmac_key");

  const path = new URL(input.request.url).pathname;
  const bodyHash = createHashHex(input.bodyText);
  const signingString = [timestamp, input.request.method.toUpperCase(), path, bodyHash].join("\n");
  const expected = createHmac("sha256", key).update(signingString).digest("base64");
  if (!safeEqual(expected, signature)) throw new McpHmacError("signature_mismatch");
}

function selectKey(config: McpHmacConfig, keyId: string) {
  if (keyId === config.currentId) return config.currentKey;
  if (config.previousId && config.previousKey && keyId === config.previousId) return config.previousKey;
  return null;
}

function createHashHex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.byteLength === bBuffer.byteLength && timingSafeEqual(aBuffer, bBuffer);
}
