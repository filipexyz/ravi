import { webcrypto } from "node:crypto";

/**
 * Uses Node's module API, available on Node 18 without global-WebCrypto flags.
 * @param {Uint8Array} bytes Canonical UTF-8 bytes supplied by the SDK.
 * @returns {Promise<ArrayBuffer>} The platform SHA-256 digest.
 */
export function digestSha256(bytes) {
  return webcrypto.subtle.digest("SHA-256", bytes);
}
