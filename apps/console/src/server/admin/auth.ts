import { timingSafeEqual } from "node:crypto";

/**
 * Shared admin namespace for read-only diagnostic and break-glass endpoints.
 *
 * Endpoints under `/api/internal/admin/*` MUST require the `RAVI_ADMIN_TOKEN`
 * bearer secret. The token is operator-issued and never exchanged via WorkOS.
 * Use it only for narrow, audited operations; never expose it to product code.
 */

export function getAdminToken(): string | null {
  const value = process.env.RAVI_ADMIN_TOKEN?.trim();
  return value && value.length >= 24 ? value : null;
}

export function authorizeAdminRequest(request: Request, expectedToken = getAdminToken()): boolean {
  if (!expectedToken) return false;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  if (!bearer) return false;

  if (bearer.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(bearer), Buffer.from(expectedToken));
}
