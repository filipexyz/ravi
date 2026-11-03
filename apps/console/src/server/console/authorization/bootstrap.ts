import { createHash, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { ConsoleApiError } from "../api-error";
import { canonicalJson, policyDigest, policySchema, type OrganizationAction } from "./policy";

/** Deliberately NOT derived from ORGANIZATION_ACTIONS. New catalog entries must
 * never change the authority granted during first-identity bootstrap. */
export const BOOTSTRAP_CONFIGURATION_ACTIONS = [
  "organization.settings.read", "organization.settings.manage",
  "organization.onboarding.read", "organization.onboarding.manage",
  "organization.sso.read", "organization.sso.manage",
  "organization.credentials.read", "organization.credentials.manage",
  "organization.installations.read", "organization.installations.manage",
  "organization.authorization.read", "organization.authorization.manage",
] as const satisfies readonly OrganizationAction[];

const proofSchema = z.object({ organizationId: z.uuid(), userId: z.uuid(), identityId: z.uuid(), attemptId: z.uuid() }).strict();
export type BootstrapAuthorizationProof = z.infer<typeof proofSchema>;
function unavailable(): never { throw new ConsoleApiError(409, { error: "authorization_bootstrap_unavailable" }); }

/** SERVER-ONLY bootstrap adapter; no HTTP endpoint. Call AFTER protected OIDC
 * completion creates identity/membership and consumes fleet_bootstrap_grants,
 * BEFORE that SAME postgres-js transaction commits. No role name is consulted.
 * Requires the database writer transaction, not a connection from the client.
 * OIDC/token proof stays owned by BootstrapService; this independently checks the
 * consumed attempt, unique first identity and creation transaction in Postgres.
 */
export async function initializeAuthorizationInBootstrapTransaction(tx: TransactionSql, raw: BootstrapAuthorizationProof) {
  const input = proofSchema.parse(raw), org = input.organizationId;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${org}`},0))`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${org}`},0))`;
  const inputDigest = createHash("sha256").update(canonicalJson(input)).digest("hex");
  const [grant] = await tx`select claimed_by,attempt_id,consumed_at,
      expires_at>now() and attempt_expires_at>now() as fresh,
      xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text as same_transaction
    from fleet_bootstrap_grants where organization_id=${org} for update`;
  if (!grant || !grant.consumed_at || grant.claimed_by !== input.userId || grant.attempt_id !== input.attemptId) unavailable();
  const [existing] = await tx`select * from authorization_bootstrap_receipts where organization_id=${org}`;
  if (existing) {
    if (existing.input_digest !== inputDigest || existing.actor_id !== input.userId || existing.identity_id !== input.identityId || existing.operation_key !== input.attemptId) unavailable();
    // Receipt only; NEVER restore/regrant a revoked or subsequently edited policy.
    return { revisionId: existing.revision_id as string, replay: true };
  }
  if (!grant.fresh || !grant.same_transaction) unavailable();
  const memberships = await tx`select user_id,status,
    xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text as same_transaction
    from organization_memberships where organization_id=${org} for update`;
  if (memberships.length !== 1 || memberships[0]!.user_id !== input.userId || memberships[0]!.status !== "active" || !memberships[0]!.same_transaction) unavailable();
  const [identity] = await tx`select i.id from auth_identities i join users u on u.id=i.user_id
    join organizations o on o.id=${org}
    where i.id=${input.identityId} and i.user_id=${input.userId} and u.status='active' and o.status='active'
      and i.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text
      and u.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text
    for share of i,u,o`;
  if (!identity || (await tx`select organization_id from authorization_policy_heads where organization_id=${org}`).length ||
    (await tx`select id from authorization_policy_revisions where organization_id=${org} limit 1`).length) unavailable();
  const revisionId = randomUUID(), roleId = randomUUID();
  const document = policySchema.parse({ format: 1, organizationId: org, groups: [], rules: [],
    administrators: [{ kind: "role", id: roleId }],
    roles: [{ id: roleId, name: "Organization steward", members: [input.userId], groups: [], scope: { kind: "organization" } }],
    organizationRules: [{ id: "initial-organization-steward", effect: "allow", principals: [{ kind: "role", id: roleId }],
      actions: [...BOOTSTRAP_CONFIGURATION_ACTIONS] }],
  });
  const digest = policyDigest(document);
  await tx`insert into authorization_policy_revisions(id,organization_id,document,digest,created_by,reason)
    values(${revisionId},${org},${JSON.stringify(document)}::jsonb,${digest},${input.userId},'Protected first-identity bootstrap')`;
  await tx`insert into authorization_policy_heads(organization_id,generation,active_revision_id) values(${org},1,${revisionId})`;
  await tx`insert into authorization_bootstrap_receipts(organization_id,operation_key,actor_id,identity_id,revision_id,input_digest)
    values(${org},${input.attemptId},${input.userId},${input.identityId},${revisionId},${inputDigest})`;
  await tx`insert into authorization_audit(organization_id,actor_id,action,revision_id,generation,request_id,metadata)
    values(${org},${input.userId},'policy.bootstrap',${revisionId},1,${input.attemptId},
      ${JSON.stringify({ inputDigest, identityId: input.identityId, roleId, policyDigest: digest, projectGrants: 0 })}::jsonb)`;
  return { revisionId, replay: false };
}
