import { ConsoleApiError } from "@/server/console/api-error";
import { executorOrigins, pageOperationSchema, signDelegation, type DelegationScope, type PageOperation } from "./protocol";

// Explicit adapters only. A catalog entry is not automatically safe to delegate.
export const DELEGATED_PAGE_ACTIONS = new Set([
  "ravi.projects.list", "ravi.pages.sites.list", "ravi.pages.published.list", "ravi.pages.theme.get",
  "ravi.bases.views.describe", "ravi.bases.views.query", "ravi.bases.views.version",
  "ravi.bases.views.rows.get", "ravi.bases.charts.data", "ravi.bases.views.rows.create",
]);
export function shouldDelegatePageOperation(id: string): boolean {
  return Boolean(process.env.RAVI_EXECUTOR_URL) && DELEGATED_PAGE_ACTIONS.has(id);
}
export async function delegatePageOperation(input: PageOperation & Omit<DelegationScope, "releaseId"> & { releaseId: string | null }) {
  if (!DELEGATED_PAGE_ACTIONS.has(input.id)) throw new ConsoleApiError(403, { error: "executor_action_forbidden" });
  if (!input.releaseId) throw new ConsoleApiError(403, { error: "connector_not_allowlisted" });
  const operation = pageOperationSchema.parse({ host: input.host, id: input.id, input: input.input,
    origin: input.origin ?? null, pagesSession: input.pagesSession, requestId: input.requestId });
  const delegation = await signDelegation(operation, {
    actorId: input.actorId, organizationId: input.organizationId, siteId: input.siteId,
    projectId: input.projectId, releaseId: input.releaseId,
  });
  const response = await fetch(`${executorOrigins().executor}/api/delegated-operations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ delegation, operation }), redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json() as { output?: unknown; error?: string; fieldErrors?: Record<string, string> };
  if (!response.ok) throw new ConsoleApiError(response.status, {
    error: result.error ?? "executor_unavailable",
    ...(result.error === "validation_failed" && result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  });
  return { output: result.output, auditMetadata: { via: "executor", delegation: "site-scoped" } };
}
