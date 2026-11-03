// Server-only authority for the two internal projection jobs. The WeakMap is
// intentionally not a field on BasesCaller: JSON, spread/cloning and client
// metadata cannot manufacture or transfer a service grant.
import { basesSystemCaller, type BasesCaller } from "./context";
import { forbidden } from "./errors";

export type BasesServiceJob = "usage-metrics" | "shared-chat-projection";
type ServiceGrant = { job: BasesServiceJob; organizationId: string; projectId: string; slugs: readonly string[] };
export type BasesServiceOperation = "base.create" | "base.resolve" | "property.create" |
  "view.list" | "view.create" | "view.update" | "rows.query" | "rows.create" | "rows.update";
const grants = new WeakMap<BasesCaller, ServiceGrant>();
const operations: Record<BasesServiceJob, readonly BasesServiceOperation[]> = {
  "usage-metrics": ["base.create", "base.resolve", "property.create", "view.list", "view.create", "view.update", "rows.query", "rows.create", "rows.update"],
  "shared-chat-projection": ["base.create", "base.resolve", "property.create", "view.list", "view.create", "rows.query", "rows.create", "rows.update"],
};

/** Called only by a job after resolving its trusted destination from storage. */
export function basesJobCaller(job: BasesServiceJob, project: { id: string; organizationId: string }, requestId: string): BasesCaller {
  const caller = basesSystemCaller(project.organizationId, requestId);
  // Retain the historical idempotency source identity for existing receipts.
  // Job attribution is separate metadata; switching source would duplicate a
  // previously committed effect on an exact retry after upgrading.
  grants.set(caller, Object.freeze({ job, organizationId: project.organizationId, projectId: project.id,
    slugs: Object.freeze(job === "usage-metrics" ? ["uso-dias", "uso-pessoas"] : ["conversas-pages"]) }));
  Object.freeze(caller.source);
  return Object.freeze(caller);
}

export function basesServiceIdentity(caller: BasesCaller) {
  const grant = grants.get(caller);
  return grant ? { principal: `console-job:${grant.job}`, job: grant.job } : null;
}

export function isBasesServiceProject(caller: BasesCaller, project: { id: string; organizationId: string }) {
  const grant = grants.get(caller);
  return Boolean(grant && caller.surface === "system" && caller.user === null && caller.actorType === "system" &&
    caller.organizationId === grant.organizationId && project.organizationId === grant.organizationId && project.id === grant.projectId);
}

/** Humans keep their existing policy path. All system operations fail closed
 * unless explicitly named by an authentic job grant and constrained Base. */
export function assertBasesServiceOperation(scope: { caller: BasesCaller; project: { id: string; organizationId: string }; base?: { slug: string } },
  operation?: BasesServiceOperation, slug = scope.base?.slug) {
  if (scope.caller.surface !== "system" && scope.caller.actorType !== "system") return;
  const grant = grants.get(scope.caller);
  if (!grant || !isBasesServiceProject(scope.caller, scope.project) || !operation || !slug ||
    !grant.slugs.includes(slug) || !operations[grant.job].includes(operation)) forbidden("Service operation is outside its job scope.");
}
