/** Decision audit is not a read/access log. Allowed reads (including navigation
 * previews) produce no row; denials and effect-capable actions remain recorded.
 * Actual administrative/data effects retain their separate operation audits. */
export type AuthorizationAuditMode = "decision" | "observation" | "probe";
/** "decision": effect checks. "observation": navigation previews, only denials.
 * "probe": capability discovery repeated on every request (can this reader also
 * write?); never a row. The effect keeps its own operation audit, and a refused
 * effect that relied on the probe re-decides as "decision". */
export function auditAuthorizationDecision(action: string, allowed: boolean, mode: AuthorizationAuditMode = "decision") {
  if (mode === "probe") return false;
  return !allowed || (mode === "decision" && !action.endsWith(".read"));
}
