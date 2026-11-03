import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { policyDigest, policySchema, ORGANIZATION_ACTIONS, type ProjectPolicy } from "../../src/server/console/authorization/policy";

/** Test-only explicit fixture policy, NEVER a runtime migration/initializer. It
 * intentionally does not infer any grant from a membership's role name. */
export function fixturePolicy(organizationId: string, userId: string) {
  const roleId = randomUUID();
  return policySchema.parse({ format: 1, organizationId, groups: [], rules: [],
    administrators: [{ kind: "role", id: roleId }],
    roles: [{ id: roleId, name: "Synthetic organization steward", members: [userId], groups: [], scope: { kind: "organization" } }],
    organizationRules: [{ id: "explicit-fixture-grants", effect: "allow", principals: [{ kind: "role", id: roleId }], actions: [...ORGANIZATION_ACTIONS] }],
  });
}
export async function installFixturePolicy(sql: Sql, actorId: string, document: ProjectPolicy) {
  const parsed = policySchema.parse(document), revisionId = randomUUID(), digest = policyDigest(parsed);
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${parsed.organizationId}`},0))`;
    await tx`insert into authorization_policy_revisions(id,organization_id,document,digest,created_by,reason)
      values(${revisionId},${parsed.organizationId},${JSON.stringify(parsed)}::jsonb,${digest},${actorId},'Explicit isolated test fixture, not an operator migration')`;
    await tx`insert into authorization_policy_heads(organization_id,generation,active_revision_id) values(${parsed.organizationId},1,${revisionId})
      on conflict(organization_id) do update set generation=authorization_policy_heads.generation+1,active_revision_id=excluded.active_revision_id`;
  });
  return revisionId;
}
