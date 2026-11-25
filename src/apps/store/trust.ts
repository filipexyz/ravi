/**
 * Trust root of the official Ravi Apps source (spec apps/store, "Trust").
 *
 * Only the root public keys are compiled into Ravi. They sign `keys.json`,
 * which names the publication keys (sign `index.json`) and the block keys
 * (sign `blocklist.json`). Changing a root key or the source URL takes a Ravi
 * release; nothing in the environment or in state can add a trusted key.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export interface AppStoreSourceConfig {
  id: string;
  /** Base URL that holds keys.json, index.json, blocklist.json and bundles/. Ends with "/". */
  baseUrl: string;
  /** Raw Ed25519 public keys (base64, 32 bytes) allowed to sign keys.json. */
  rootKeys: readonly string[];
  /** Lowest serial this release accepts for every signed file (anti-rollback on a fresh install). */
  minSerial: number;
}

export const OFFICIAL_APP_SOURCE: AppStoreSourceConfig = Object.freeze({
  id: "official",
  baseUrl: "https://raw.githubusercontent.com/filipexyz/ravi-apps/main/",
  // Filled with the maintainer's offline root key before the first official index ships.
  rootKeys: Object.freeze([]) as readonly string[],
  minSerial: 0,
});

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519PublicKey(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) throw new Error("An Ed25519 public key has 32 bytes.");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** The raw public key (base64) of an Ed25519 private key in PKCS#8 PEM. */
export function ed25519PublicKeyFromPrivatePem(pem: string): string {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(ED25519_SPKI_PREFIX.length)).toString("base64");
}

/** True when `signatureBase64` is a valid signature of `data` by one of `keys`. */
export function verifyDetachedSignature(data: Uint8Array, signatureBase64: string, keys: readonly string[]): boolean {
  const signature = Buffer.from(signatureBase64.trim(), "base64");
  if (signature.length !== 64) return false;
  for (const key of keys) {
    try {
      if (verify(null, data, ed25519PublicKey(key), signature)) return true;
    } catch {
      // no-cause: a malformed configured key cannot verify anything; try the next one.
    }
  }
  return false;
}

/** Sign `data` with an Ed25519 private key in PKCS#8 PEM; returns the base64 signature. */
export function signDetached(data: Uint8Array, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 private key.");
  return sign(null, data, key).toString("base64");
}
