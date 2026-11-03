import type { TransactionSql } from "postgres";
import { ConsoleApiError } from "../api-error";
import { compilePolicy } from "./engine";
import type { AuthorizationActor } from "./identity";
import { policyDigest, policySchema } from "./policy";
import { decideOrganizationInPostgresTransaction } from "./postgres";

/** SERVER ONLY: membership-only lifecycle seam for onboarding's native tx.
 * Call BEFORE acquiring membership/head locks, inside the transaction owning the
 * effect and its business receipt/audit. The callback is trusted adapter code;
 * target validation, CAS/replay and session admission remain its responsibility.
 * Do NOT call a separately committing policy store from the callback. This seam
 * does not grant roles or implement combined lifecycle/policy publication.
 * All exceptions must escape the outer tx. A caught error followed by commit
 * would defeat atomic rollback. There is no autonomous transaction or cache.
 */
export async function withAuthorizedMembershipMutationInPostgresTransaction<T>(
  tx: TransactionSql, actor: AuthorizationActor, requestId: string,
  effect: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (actor.delegation) throw new ConsoleApiError(403, { error: "authorization_delegation_not_supported" });
  const org = actor.organizationId;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${org}`},0))`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${org}`},0))`;
  for (const action of ["organization.members.read", "organization.members.manage"] as const) {
    const decision = await decideOrganizationInPostgresTransaction(tx, actor, action, requestId);
    if (!decision.allowed) throw new ConsoleApiError(403, { error: "authorization_members_required" });
  }
  const [before] = await tx`select h.active_revision_id,h.generation,r.digest from authorization_policy_heads h
    join authorization_policy_revisions r on r.id=h.active_revision_id and r.organization_id=h.organization_id
    where h.organization_id=${org} for share of h,r`;
  // Both decisions already required an active policy; still fail closed on drift.
  if (!before?.active_revision_id) throw new ConsoleApiError(503, { error: "authorization_revision_invalid" });
  const result = await effect(tx);
  const [after] = await tx`select active_revision_id,generation from authorization_policy_heads
    where organization_id=${org} for share`;
  if (!after || before.active_revision_id !== after.active_revision_id || before.generation !== after.generation)
    throw new ConsoleApiError(409, { error: "authorization_membership_policy_changed" });
  const [revision] = await tx`select document,digest from authorization_policy_revisions
    where id=${after.active_revision_id} and organization_id=${org}`;
  const parsed = policySchema.safeParse(revision?.document);
  if (!parsed.success || parsed.data.organizationId !== org || policyDigest(parsed.data) !== revision?.digest)
    throw new ConsoleApiError(503, { error: "authorization_revision_invalid" });
  if (revision?.digest !== before.digest) throw new ConsoleApiError(409, { error: "authorization_membership_policy_changed" });
  const engine = await compilePolicy(parsed.data);
  // Current identities, not policy principal labels or owner counts. The locks
  // survive through outer commit; policy publication uses the same advisory lock.
  const members = await tx`select m.user_id,m.role from organization_memberships m
    join users u on u.id=m.user_id join organizations o on o.id=m.organization_id
    where m.organization_id=${org} and m.status='active' and u.status='active' and o.status='active'
    order by m.user_id limit 1001 for share of m,u,o`;
  if (members.length > 1000) throw new ConsoleApiError(422, { error: "authorization_membership_review_too_large" });
  let managerRemains = false;
  for (const member of members) {
    const facts = { organizationId: org, userId: member.user_id as string, organizationRole: member.role as string, active: true };
    if ((await engine.decideOrganization(facts, "organization.authorization.read")).allowed &&
      (await engine.decideOrganization(facts, "organization.authorization.manage")).allowed) { managerRemains = true; break; }
  }
  if (!managerRemains) throw new ConsoleApiError(409, { error: "authorization_last_manager_required" });
  await tx`insert into authorization_audit(organization_id,actor_id,action,revision_id,generation,request_id,metadata)
    values(${org},${actor.userId},'membership.authorization',${after.active_revision_id},${after.generation},${requestId},
    ${JSON.stringify({ resourceKind: "organization", policyDigest: revision!.digest, managerRemains: true })}::jsonb)`;
  return result;
}
