import { createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { safeAuthReturnTo } from "./return-to";
import type { OidcConfig } from "./oidc-config";

export const OIDC_TRANSACTION_COOKIE = "__Host-ravi_oidc_transaction";
export const OIDC_SESSION_COOKIE = "__Host-ravi_console_session";
export const OIDC_TRANSACTION_SECONDS = 300;
export const oidcCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };

const transactionSchema = z.object({
  state: z.string().min(32), nonce: z.string().min(32), verifier: z.string().min(43),
  returnTo: z.string().refine((value) => safeAuthReturnTo(value) === value),
});
export type OidcTransaction = z.infer<typeof transactionSchema>;

function key(config: OidcConfig) {
  return createHash("sha256").update(`ravi-oidc-transaction\0${config.secret}`).digest();
}

export async function sealOidcTransaction(transaction: OidcTransaction, config: OidcConfig) {
  return new EncryptJWT(transactionSchema.parse(transaction))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "ravi-oidc-transaction" })
    .setIssuer(config.origin).setAudience(`${config.issuer}#${config.clientId}${config.generation ? `#${config.generation}` : ""}`)
    .setIssuedAt().setExpirationTime(`${OIDC_TRANSACTION_SECONDS}s`).encrypt(key(config));
}

export async function openOidcTransaction(value: string, config: OidcConfig): Promise<OidcTransaction> {
  const { payload } = await jwtDecrypt(value, key(config), {
    issuer: config.origin, audience: `${config.issuer}#${config.clientId}${config.generation ? `#${config.generation}` : ""}`,
    typ: "ravi-oidc-transaction", keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
    maxTokenAge: `${OIDC_TRANSACTION_SECONDS}s`,
  });
  return transactionSchema.parse(payload);
}

export function newBrowserSessionToken() { return randomBytes(32).toString("base64url"); }
export function hashBrowserSessionToken(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return createHash("sha256").update(value).digest("hex");
}
