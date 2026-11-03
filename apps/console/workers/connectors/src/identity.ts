/**
 * Account identity read from a provider token response.
 *
 * Google returns an OpenID Connect `id_token` from its token endpoint
 * when `openid` is requested. The Worker reads `sub` (the stable account
 * id) and `email` from the JWT payload. The signature is not checked:
 * the token came straight from the provider's token endpoint over TLS
 * (or from the vault, where it was stored after such an exchange), so
 * the transport already authenticated it.
 */

export interface AccountIdentity {
  sub: string | null;
  email: string | null;
}

export function decodeIdTokenClaims(idToken: string | null | undefined): AccountIdentity | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const sub = typeof record.sub === "string" && record.sub.trim() ? record.sub.trim() : null;
  const email =
    typeof record.email === "string" && record.email.trim() ? record.email.trim().toLowerCase() : null;
  if (!sub && !email) return null;
  return { sub, email };
}

/**
 * Two identities name the same account when their subs match; when a sub
 * is missing on either side, the emails decide. `null` means unknown.
 */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean | null {
  if (a.sub && b.sub) return a.sub === b.sub;
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return null;
}

function base64UrlDecodeToString(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
