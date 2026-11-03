import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** v2 receipts are domain-separated from authentication and from each other.
 * Legacy acceptance is read-only and only for an existing unversioned receipt.
 * It cannot downgrade a v2 receipt or create a new legacy receipt. */
export function operationDigest(secret: string, domain: "fleet" | "fleet-sso", payload: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, "ravi-console-fleet", `operation-receipt:v2:${domain}`, 32));
  return `v2:${createHmac("sha256", key).update(payload).digest("hex")}`;
}
export function legacyOperationDigest(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
export function matchesOperationDigest(stored: string, secret: string, domain: "fleet" | "fleet-sso", payload: string) {
  const expected = stored.startsWith("v2:") ? operationDigest(secret, domain, payload)
    : /^[a-f0-9]{64}$/.test(stored) ? legacyOperationDigest(secret, payload) : "";
  return expected.length === stored.length && expected.length > 0 && timingSafeEqual(Buffer.from(stored), Buffer.from(expected));
}
