import type { TransactionSql } from "postgres";
import { ConsoleApiError } from "../api-error";
import type { AuthorizationActor } from "./identity";
import { compilePolicy, type AuthorizationDecision } from "./engine";
import { ORGANIZATION_ACTIONS, policyDigest, policySchema, type OrganizationAction } from "./policy";
import { auditAuthorizationDecision } from "./audit-policy";

/** Native postgres-js adapter for Fleet's EXISTING transaction. Human-only at
 * this boundary; delegated callers must use the verified CLI/Drizzle adapter.
 * It neither opens a connection nor alters the driver's shared JSON parsers.
 * Keep the transaction open through the effect. A returned decision is not a
 * capability. Caller must return denial through its transaction before throwing
 * at HTTP boundary if it wants the denial audit to commit.
 */
export async function decideOrganizationInPostgresTransaction(tx: TransactionSql, actor: AuthorizationActor,
  action: OrganizationAction, requestId: string) {
  return (await organizationDecisionSnapshot(tx, actor))(action, requestId);
}

/** Request/transaction-local only. Never persist this closure as a capability.
 * Identity, policy head and revision are fetched once, under share locks, for
 * this transaction; the next request starts with fresh database facts. */
export async function organizationDecisionSnapshot(tx: TransactionSql, actor: AuthorizationActor) {
  if (actor.delegation) throw new ConsoleApiError(403, { error: "authorization_delegation_not_supported" });
  const [identity] = await tx`select m.role from organization_memberships m join users u on u.id=m.user_id
    join organizations o on o.id=m.organization_id where m.organization_id=${actor.organizationId} and m.user_id=${actor.userId}
    and m.status='active' and u.status='active' and o.status='active' for share of m,u,o`;
  if (!identity) throw new ConsoleApiError(403, { error: "authorization_identity_invalid" });
  const [head] = await tx`select * from authorization_policy_heads where organization_id=${actor.organizationId} for share`;
  let engine: Awaited<ReturnType<typeof compilePolicy>> | null = null;
  if (head?.active_revision_id) {
    const [revision] = await tx`select document,digest from authorization_policy_revisions
      where id=${head.active_revision_id} and organization_id=${actor.organizationId}`;
    const parsed = policySchema.safeParse(revision?.document);
    if (!parsed.success || policyDigest(parsed.data) !== revision?.digest) throw new ConsoleApiError(503, { error: "authorization_revision_invalid" });
    engine = await compilePolicy(parsed.data);
  }
  return async (action: OrganizationAction, requestId: string, observation = false) => {
  if (!(ORGANIZATION_ACTIONS as readonly string[]).includes(action)) throw new ConsoleApiError(400, { error: "authorization_action_invalid" });
  const result: AuthorizationDecision = engine ? await engine.decideOrganization({ organizationId: actor.organizationId,
    userId: actor.userId, organizationRole: identity.role, active: true }, action)
    : { allowed: false, reason: "not_configured", policyDigest: null, lanes: [] };
  const decision = { ...result, revisionId: (head?.active_revision_id ?? null) as string | null, generation: Number(head?.generation ?? 0) };
  if (auditAuthorizationDecision(action, result.allowed, observation ? "observation" : "decision")) await tx`insert into authorization_audit(organization_id,actor_id,action,revision_id,generation,request_id,metadata)
    values(${actor.organizationId},${actor.userId},${action},${decision.revisionId},${decision.generation},${requestId},
    ${JSON.stringify({ resourceKind: "organization", allowed: result.allowed, reason: result.reason, policyDigest: result.policyDigest, lanes: result.lanes })}::text::jsonb)`;
  return decision;
  };
}
