import { dbGetContext, type ContextRecord } from "../router/router-db.js";

/**
 * Whether a context a caller holds in memory is still live: neither the copy nor
 * its stored row is revoked or expired. In-process authorization (host tools,
 * `source: "tool"` command access, child issue) works from a cached record that
 * revocation does not touch, so it asks the store here. A context with no
 * stored row (built in memory) is judged by its own fields.
 */
export function isRuntimeContextLive(
  context: Pick<ContextRecord, "contextId" | "revokedAt" | "expiresAt">,
  now = Date.now(),
): boolean {
  const ended = (record: Pick<ContextRecord, "revokedAt" | "expiresAt">) =>
    Boolean((record.revokedAt && record.revokedAt <= now) || (record.expiresAt && record.expiresAt <= now));
  if (ended(context)) return false;
  const stored = context.contextId ? dbGetContext(context.contextId) : null;
  return !stored || !ended(stored);
}
