import { createHash, randomBytes, randomUUID } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function generateBridgeToken() {
  return base32NoPadding(randomBytes(32));
}

export function generateOpaqueToken(byteLength = 32) {
  return randomBytes(byteLength).toString("base64url");
}

export function generateBridgeSessionRef() {
  return `mcp_session_${randomUUID()}`;
}

export function generateBridgeChannelId() {
  return `mcp:${randomUUID()}`;
}

function base32NoPadding(bytes: Uint8Array) {
  let output = "";
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }

  return output;
}
