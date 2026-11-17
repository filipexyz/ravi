/**
 * Uses browser/edge WebCrypto without importing Node modules or changing globals.
 * @param {Uint8Array} bytes Canonical UTF-8 bytes supplied by the SDK.
 * @returns {Promise<ArrayBuffer>} The platform SHA-256 digest.
 */
export function digestSha256(bytes) {
  return globalThis.crypto.subtle.digest("SHA-256", bytes);
}
