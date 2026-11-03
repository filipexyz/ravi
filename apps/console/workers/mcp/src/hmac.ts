import { hmacSha256Base64, sha256Hex } from "./crypto";
import type { McpWorkerEnv } from "./env";

const TIMESTAMP_HEADER = "x-ravi-hmac-timestamp";
const KEY_ID_HEADER = "x-ravi-hmac-key-id";
const SIGNATURE_HEADER = "x-ravi-hmac-signature";

export async function signConsoleRequest(input: {
  env: McpWorkerEnv;
  method: string;
  path: string;
  bodyText: string;
}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signingString = [
    timestamp,
    input.method.toUpperCase(),
    input.path,
    await sha256Hex(input.bodyText),
  ].join("\n");
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [KEY_ID_HEADER]: input.env.RAVI_MCP_WORKER_HMAC_KEY_CURRENT_ID,
    [SIGNATURE_HEADER]: await hmacSha256Base64({
      key: input.env.RAVI_MCP_WORKER_HMAC_KEY_CURRENT,
      message: signingString,
    }),
  };
}
