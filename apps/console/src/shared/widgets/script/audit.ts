// The accessibility audit of a widget with `widget.js` (JS-CONTRACT J3):
// axe-core over the card rendered from example.json with its code running.
// The rules shared by the Console frame that runs it, the endpoint that
// stores it, and the page kit that refuses an unaudited version.

import type { WidgetScriptAudit, WidgetScriptAuditStatus, WidgetScriptViolation } from "../types";

/** axe-core impacts that fail the audit. */
export const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(["serious", "critical"]);

export function auditStatusOf(violations: readonly Pick<WidgetScriptViolation, "impact">[]): WidgetScriptAuditStatus {
  return violations.some((violation) => violation.impact !== null && BLOCKING_IMPACTS.has(violation.impact)) ? "fail" : "pass";
}

/** Whether `audit` lets a page ship the script whose sha256 is `scriptSha256`. */
export function isAuditPassing(audit: Pick<WidgetScriptAudit, "status" | "scriptSha256"> | null | undefined, scriptSha256: string) {
  return audit?.status === "pass" && audit.scriptSha256 === scriptSha256;
}

/** A stored audit read back from JSON; null when it is not one. */
export function readScriptAudit(value: unknown): WidgetScriptAudit | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ((record.status !== "pass" && record.status !== "fail") || typeof record.scriptSha256 !== "string") return null;
  const violations = Array.isArray(record.violations) ? (record.violations as WidgetScriptViolation[]) : [];
  return {
    status: record.status,
    violations,
    scriptSha256: record.scriptSha256,
    auditedBy: typeof record.auditedBy === "string" ? record.auditedBy : null,
    auditedAt: typeof record.auditedAt === "string" ? record.auditedAt : "",
  };
}
