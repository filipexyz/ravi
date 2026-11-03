import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { OrganizationMember, OrganizationMembers, MembershipReceipt } from "@/shared/organization-members";
import { ConsoleApiError } from "../api-error";
import { withAuthorizedMembershipMutationInPostgresTransaction } from "../authorization/membership";
import { withFleetAuthorization } from "./authorization";
import { assertFleetActor, FleetError, type FleetActor } from "./contract";

const changeSchema = z.object({ operationId: z.string().uuid(), userId: z.string().uuid(),
  expectedVersion: z.string().min(1).max(64), status: z.enum(["active", "suspended", "removed"]) }).strict();

/** Admission only. No user creation, IdP association, policy/role assignment or
 * delegated administration. API actors must come from current browser auth. */
export class OrganizationMembersService {
  constructor(private sql: Sql, private organizationId: string) {}

  async list(actor: FleetActor): Promise<OrganizationMembers> {
    return withFleetAuthorization(this.sql, this.organizationId, actor, ["organization.members.read"], async tx => {
      const rows = await tx`select m.user_id as "userId",u.display_name as name,u.primary_email as email,
        m.status,m.updated_at::text as version from organization_memberships m join users u on u.id=m.user_id
        where m.organization_id=${this.organizationId} order by lower(u.display_name),m.user_id limit 1001`;
      if (rows.length > 1000) throw new FleetError("member_directory_too_large", 422);
      return { members: rows as unknown as OrganizationMember[], currentUserId: actor.userId };
    });
  }

  async change(actor: FleetActor, body: unknown): Promise<MembershipReceipt> {
    assertFleetActor(actor, this.organizationId);
    const parsed = changeSchema.safeParse(body);
    if (!parsed.success) throw new FleetError("invalid_request", 400);
    const input = parsed.data, org = this.organizationId;
    const digest = createHash("sha256").update(JSON.stringify({ kind: "membership.status.v1", org, actor: actor.userId, ...input })).digest("hex");
    // Let ALL errors escape begin: the core invariant must roll back the effect,
    // revocations, business audit AND receipt, including last-manager races.
    return await this.sql.begin(tx => withAuthorizedMembershipMutationInPostgresTransaction(tx,
      { organizationId: org, userId: actor.userId }, input.operationId, async tx => {
        const [receipt] = await tx`select input_hash,result_json from fleet_mutation_receipts
          where organization_id=${org} and operation_id=${input.operationId}`;
        if (receipt) {
          if (receipt.input_hash !== digest) throw new FleetError("idempotency_conflict", 409);
          return receipt.result_json as MembershipReceipt;
        }
        const [before] = await tx`select m.user_id as "userId",u.display_name as name,u.primary_email as email,
          m.status,m.updated_at::text as version,u.status as "userStatus",
          exists(select 1 from auth_identities i where i.user_id=m.user_id and i.provider like 'oidc:%') as "hasIdentity"
          from organization_memberships m join users u on u.id=m.user_id
          where m.organization_id=${org} and m.user_id=${input.userId} for update of m for share of u`;
        if (!before) throw new ConsoleApiError(404, { error: "member_not_found" });
        if (before.version !== input.expectedVersion) throw new FleetError("version_conflict", 409);
        // Never convert an invitation/stub into an authenticated identity here.
        if (input.status === "active" && (before.status === "invited" || before.userStatus !== "active" || !before.hasIdentity))
          throw new FleetError("member_admission_unsupported", 409);
        const changed = before.status !== input.status;
        let version = before.version as string;
        if (changed) {
          const [updated] = await tx`update organization_memberships set status=${input.status},
            updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
            where organization_id=${org} and user_id=${input.userId} returning updated_at::text as version`;
          version = updated!.version;
        }
        // Even a first no-op inactive intent invalidates previously issued sessions;
        // exact retries return the stored result only after current authorization.
        if (input.status !== "active") await revokeMemberSessions(tx, org, input.userId);
        const result: MembershipReceipt = { operationId: input.operationId, changed, member: {
          userId: input.userId, name: before.name, email: before.email, status: input.status, version,
        } };
        await tx`insert into audit_events(id,organization_id,actor_type,actor_id,target_type,target_id,action,
          request_id,before_json,after_json,metadata_json) values(${randomUUID()},${org},'user',${actor.userId},
          'organization_membership',${input.userId},'organization_member.status_changed',${input.operationId},
          ${JSON.stringify({ status: before.status, version: before.version })}::jsonb,
          ${JSON.stringify({ status: input.status, version })}::jsonb,
          ${JSON.stringify({ source: "fleet.members", changed, grantsModified: false, sessionsRevoked: input.status !== "active" })}::jsonb)`;
        await tx`insert into fleet_mutation_receipts(organization_id,operation_id,input_hash,result_json)
          values(${org},${input.operationId},${digest},${JSON.stringify(result)}::jsonb)`;
        return result;
      })) as MembershipReceipt;
  }
}

async function revokeMemberSessions(tx: TransactionSql, org: string, user: string) {
  // Authorship is never ownership. Only exact, classified personal subjects.
  await tx`update api_keys set status='revoked',revoked_at=clock_timestamp(),
    updated_at=clock_timestamp(),revision=revision+1
    where organization_id=${org} and subject_kind='user' and subject_user_id=${user} and status<>'revoked'`;
  await tx`update mcp_oauth_tokens set revoked_at=now(),updated_at=now()
    where organization_id=${org} and subject_user_id=${user} and revoked_at is null`;
  await tx`update console_browser_sessions set revoked_at=now() where organization_id=${org} and user_id=${user} and revoked_at is null`;
  await tx`update pages_sessions set status='revoked',revoked_at=now(),updated_at=now()
    where organization_id=${org} and user_id=${user} and status='active'`;
  await tx`update pages_claim_codes set status='revoked',updated_at=now()
    where organization_id=${org} and user_id=${user} and status in ('active','consumed')`;
  await tx`update cli_sessions set status='revoked',revoked_at=now(),updated_at=now()
    where organization_id=${org} and user_id=${user} and status='active'`;
  await tx`update ravi_actor_bindings set status='revoked',revoked_at=now(),updated_at=now()
    where organization_id=${org} and console_user_id=${user} and status='active'`;
  await tx`update cli_device_authorizations set status='denied',denied_at=now(),updated_at=now()
    where organization_id=${org} and user_id=${user} and status in ('pending','approved')`;
  await tx`update ravi_link_requests set status='cancelled',cancelled_at=now(),updated_at=now()
    where organization_id=${org} and (requested_by_user_id=${user} or approved_by_user_id=${user}) and status='pending'`;
}
