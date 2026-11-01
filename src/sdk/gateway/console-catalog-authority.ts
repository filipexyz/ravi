import type { ConsoleGrant } from "./console-contract.js";
import type { BridgeService } from "../../bridge/service.js";
import { BridgeError } from "../../bridge/protocol.js";

export const isPermissionCatalog = (grant: Pick<ConsoleGrant, "command">) =>
  grant.command === "desktop.permissions.catalog";
export const consoleHeadProject = (grant: Pick<ConsoleGrant, "command" | "projectId">) =>
  isPermissionCatalog(grant) ? `catalog:${grant.projectId}` : grant.projectId;

/** Metadata authority has a separate revision head. It can neither overwrite a
 * running conversation's execution ceiling nor renew/cancel its lease. */
export function acceptCatalogDelegation(service: BridgeService, grant: ConsoleGrant) {
  if (
    !isPermissionCatalog(grant) ||
    grant.scope.kind !== "installation" ||
    grant.access.resource !== "desktop.permissions" ||
    grant.access.kind !== "read" ||
    grant.access.action !== "catalog" ||
    grant.agents.length ||
    grant.canSend ||
    grant.canApprove
  )
    throw new BridgeError("INVALID_DELEGATION");
  service.store.atomic(() => {
    const live = service.store.enrollment(grant.enrollmentId);
    if (!live?.active || live.epoch !== grant.epoch) throw new BridgeError("ACCESS_REVOKED");
    const key = consoleHeadProject(grant);
    const head = service.store.db
      .query<{ revision: number; digest: string }, [string, string, string]>(
        "SELECT revision,digest FROM delegation_heads WHERE enrollment_id=? AND subject=? AND project_id=?",
      )
      .get(grant.enrollmentId, grant.sub, key);
    if (
      head &&
      (grant.policyRevision < head.revision ||
        (grant.policyRevision === head.revision && grant.policyDigest !== head.digest))
    )
      throw new BridgeError("STALE_DELEGATION");
    service.store.db
      .query(
        "INSERT INTO delegation_heads VALUES (?,?,?,?,?) ON CONFLICT(enrollment_id,subject,project_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest",
      )
      .run(grant.enrollmentId, grant.sub, key, grant.policyRevision, grant.policyDigest);
  });
}
