import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import {
  associationStartSchema, associationPollSchema, associationApproveSchema,
  enqueueSchema, revokeSchema, finishSchema, receiptSchema, commandEnvelopeSchema,
  operationResultSchema, type Installation, type ManagedOperation, type CommandEnvelope,
} from "@ravi/operation-contracts/console";
import { commandDigest } from "@ravi/operation-contracts/digest";
import { withFleetAuthorization } from "./authorization";
import { ConsoleApiError } from "../api-error";
import { FleetError, type FleetActor } from "./contract";
import { verifiedRequest, type NodeCertificateIssuer } from "./node-pki";
import type { OrganizationAction } from "../authorization/policy";

type Row = Record<string, any>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value: Date | string) => new Date(value).toISOString();
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new FleetError("invalid_request", 400);
  return result.data;
};
function installation(row: Row): Installation {
  return { id: row.id, name: row.name, platform: row.platform,
    revision: row.management_revision, lastSeenAt: row.state_reported_at ? iso(row.state_reported_at) : null,
    status: row.status !== "active" ? "revoked" : !row.state_reported_at ? "pending" : row.online ? "online" : "offline" };
}
function operation(row: Row): ManagedOperation {
  return { id: row.id, installationId: row.installation_id, status: row.state,
    createdAt: iso(row.created_at), result: row.result, error: row.error };
}
const nodeColumns = `id,name,platform,status,management_revision,state_reported_at,
  (state_reported_at > clock_timestamp() - interval '45 seconds') as online`;

/** Owns management lifecycle, reusing the Console's single current-policy transaction. */
export class NodeManagementService {
  constructor(private sql: Sql, private organizationId: string, private issuer: NodeCertificateIssuer,
    private origins: { console: string; transport: string }) {}

  private async authorize<T>(actor: FleetActor, actions: OrganizationAction[], run: (tx: TransactionSql) => Promise<T>, operationId?: string) {
    if (!actor.sessionId) throw new FleetError("auth_required", 401);
    try { return await withFleetAuthorization(this.sql, this.organizationId, actor, actions, run, operationId); }
    catch (error) {
      if (error instanceof ConsoleApiError && [401,403].includes(error.status)) throw new FleetError(error.status === 401 ? "auth_required" : "forbidden", error.status);
      throw error;
    }
  }
  private async audit(tx: TransactionSql, actor: FleetActor, action: string, target: string, operationId: string) {
    await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
      values(${actor.organizationId},'user',${actor.userId},'local_installation',${target},${action},${operationId},'{}')`;
  }
  private async nodes(tx: TransactionSql) {
    const rows = await tx.unsafe(`select ${nodeColumns} from local_installations where organization_id=$1 and subject_type='installation' order by first_seen_at,id limit 500`, [this.organizationId]);
    return rows.map(installation);
  }
  list(actor: FleetActor) {
    return this.authorize(actor, ["organization.installations.read"], async tx => ({ installations: await this.nodes(tx) }));
  }

  /** Public bootstrap has no authority and returns no credentials. Browser consent is mandatory. */
  async startAssociation(body: unknown) {
    const input = parse(associationStartSchema, body);
    const verified = await verifiedRequest(input.csr);
    const challengeHash = hash(input.challenge);
    const row = await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended('fleet:association-admission',0))`;
      const [existing] = await tx`select * from fleet_associations where challenge_hash=${challengeHash}`;
      if (existing) {
        if (existing.fingerprint !== verified.fingerprint || existing.name !== input.name || existing.platform !== input.platform)
          throw new FleetError("intent_conflict", 409);
        return existing;
      }
      const [count] = await tx`select count(*)::int as count from fleet_associations where expires_at>clock_timestamp() and status='pending'`;
      if (!count || count.count >= 1000) throw new FleetError("association_capacity", 429);
      const [created] = await tx`insert into fleet_associations(id,challenge_hash,csr,fingerprint,name,platform,expires_at)
        values(${randomUUID()},${challengeHash},${input.csr},${verified.fingerprint},${input.name},${input.platform},clock_timestamp()+interval '10 minutes') returning *`;
      return created;
    }) as Row;
    const [organization] = await this.sql`select slug from organizations where id=${this.organizationId} and status='active'`;
    if (!organization) throw new FleetError("organization_unavailable", 503);
    const url = new URL(`/${encodeURIComponent(organization.slug)}/installations/associate`, this.origins.console);
    // Fragment avoids leaking the proof into HTTP access logs and Referer headers.
    url.hash = new URLSearchParams({ request: row.id, challenge: input.challenge }).toString();
    return { associationId: row.id, verificationUrl: url.href, fingerprint: row.fingerprint, expiresAt: iso(row.expires_at) };
  }
  association(actor: FleetActor, body: unknown) {
    const input = parse(associationPollSchema, body);
    return this.authorize(actor, ["organization.installations.read"], async tx => {
      const [row] = await tx`select *,expires_at<=clock_timestamp() as expired from fleet_associations
        where id=${input.associationId} and challenge_hash=${hash(input.challenge)}`;
      if (!row || (row.organization_id && row.organization_id !== actor.organizationId)) throw new FleetError("not_found", 404);
      return { id: row.id, name: row.name, platform: row.platform, fingerprint: row.fingerprint,
        status: row.expired ? "expired" : row.status, installationId: row.installation_id, expiresAt: iso(row.expires_at) };
    });
  }
  async approve(actor: FleetActor, body: unknown) {
    const input = parse(associationApproveSchema, body);
    // Read permission is checked before accessing or signing a candidate. Signing grants no authority.
    await this.association(actor, { associationId: input.associationId, challenge: input.challenge });
    const [candidate] = await this.sql`select * from fleet_associations where id=${input.associationId}`;
    if (!candidate || candidate.fingerprint !== input.fingerprint) throw new FleetError("association_changed", 409);
    const installationId = candidate.installation_id ?? randomUUID();
    const certificate = await this.issuer.issue(candidate.csr, installationId);
    return this.authorize(actor, ["organization.installations.read", "organization.installations.manage"], async tx => {
      const [row] = await tx`select *,expires_at<=clock_timestamp() as expired from fleet_associations where id=${input.associationId} for update`;
      if (!row || row.challenge_hash !== hash(input.challenge) || row.fingerprint !== input.fingerprint)
        throw new FleetError("association_changed", 409);
      if (row.status === "approved") {
        if (row.organization_id !== actor.organizationId || row.approved_by !== actor.userId || row.approval_operation !== input.operationId)
          throw new FleetError("intent_conflict", 409);
        const [existing] = await tx.unsafe(`select ${nodeColumns} from local_installations where id=$1`, [row.installation_id]);
        if (!existing) throw new FleetError("installation_unavailable", 409);
        if (existing.name !== input.name) throw new FleetError("intent_conflict", 409);
        return installation(existing);
      }
      if (row.expired || row.status !== "pending") throw new FleetError("association_expired", 409);
      const [created] = await tx`insert into local_installations(id,organization_id,user_id,subject_type,name,platform,install_state,management_revision)
        values(${installationId},${actor.organizationId},null,'installation',${input.name},${row.platform},'requested',1) returning *`;
      await tx`insert into fleet_node_credentials(id,installation_id,revision,fingerprint,certificate,expires_at)
        values(${randomUUID()},${installationId},1,${certificate.fingerprint},${certificate.certificate},${iso(certificate.expiresAt)})`;
      await tx`update fleet_associations set status='approved',organization_id=${actor.organizationId},installation_id=${installationId},
        approved_by=${actor.userId},approved_session=${actor.sessionId!},approval_operation=${input.operationId} where id=${row.id}`;
      await this.audit(tx, actor, "fleet.node.associated", installationId, input.operationId);
      const [live] = await tx`select 1 from fleet_associations where id=${row.id} and expires_at>clock_timestamp()`;
      if (!live) throw new FleetError("association_expired", 409);
      if (!created) throw new FleetError("installation_unavailable", 409);
      return installation(created);
    }, input.operationId);
  }
  async pollAssociation(body: unknown) {
    const input = parse(associationPollSchema, body);
    const [row] = await this.sql`select a.*,a.expires_at<=clock_timestamp() as expired,c.certificate,c.expires_at as certificate_expires_at
      from fleet_associations a left join fleet_node_credentials c on c.installation_id=a.installation_id and c.revoked_at is null
      left join local_installations n on n.id=a.installation_id
      where a.id=${input.associationId} and a.challenge_hash=${hash(input.challenge)} and (n.id is null or n.status='active')`;
    if (!row) throw new FleetError("association_unavailable", 404);
    if (row.expired) throw new FleetError("association_expired", 410);
    if (row.status !== "approved") return { status: row.status };
    if (!row.certificate) throw new FleetError("installation_revoked", 403);
    return { status: "approved", installationId: row.installation_id, organizationId: row.organization_id,
      certificate: row.certificate, ca: await this.issuer.ca(), transportUrl: this.origins.transport,
      expiresAt: iso(row.certificate_expires_at) };
  }

  revoke(actor: FleetActor, body: unknown) {
    const input = parse(revokeSchema, body), digest = hash(input);
    return this.authorize(actor, ["organization.installations.read", "organization.installations.manage"], async tx => {
      const [receipt] = await tx`select * from fleet_node_mutations where organization_id=${actor.organizationId} and subject_id=${actor.userId} and operation_id=${input.operationId}`;
      if (receipt) {
        if (receipt.action !== "revoke" || receipt.digest !== digest) throw new FleetError("intent_conflict", 409);
        return receipt.result as Installation;
      }
      const [row] = await tx`select * from local_installations where id=${input.installationId} and organization_id=${actor.organizationId} and subject_type='installation' for update`;
      if (!row) throw new FleetError("not_found", 404);
      if (row.management_revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      const [changed] = await tx`update local_installations set status='revoked',revoked_at=clock_timestamp(),management_revision=management_revision+1 where id=${row.id} returning *`;
      await tx`update fleet_node_credentials set revoked_at=clock_timestamp() where installation_id=${row.id} and revoked_at is null`;
      await tx`update cli_sessions set status='revoked',revoked_at=clock_timestamp() where local_installation_id=${row.id} and subject_type='installation'`;
      await tx`update fleet_node_operations set state=case when state='queued' then 'cancelled' else 'uncertain' end,error='installation_revoked'
        where installation_id=${row.id} and state in ('queued','delivered')`;
      if (!changed) throw new FleetError("installation_unavailable", 409);
      const result = installation(changed);
      await tx`insert into fleet_node_mutations(organization_id,subject_id,operation_id,action,digest,result)
        values(${actor.organizationId},${actor.userId},${input.operationId},'revoke',${digest},${JSON.stringify(result)}::text::jsonb)`;
      await this.audit(tx, actor, "fleet.node.revoked", row.id, input.operationId);
      return result;
    }, input.operationId);
  }

  async enqueue(actor: FleetActor, body: unknown) {
    const input = parse(enqueueSchema, body);
    const digest = await commandDigest(input.installationId, input.operationId, input.command);
    return this.authorize(actor, ["organization.installations.read", "organization.installations.manage"], async tx => {
      const [node] = await tx`select * from local_installations where id=${input.installationId} and organization_id=${actor.organizationId} and subject_type='installation' for share`;
      if (!node || node.status !== "active") throw new FleetError("installation_unavailable", 409);
      const [existing] = await tx`select * from fleet_node_operations where id=${input.operationId}`;
      if (existing) {
        if (existing.organization_id !== actor.organizationId || existing.subject_id !== actor.userId || existing.digest !== digest)
          throw new FleetError("intent_conflict", 409);
        return operation(existing);
      }
      if (input.command.kind === "channel.configure") {
        const command = input.command;
        const [binding] = await tx`select c.*,p.state from fleet_native_channels c join fleet_node_operations p on p.id=c.operation_id
          where c.organization_id=${actor.organizationId} and (c.team_id=${command.identity.teamId} and c.bot_user_id=${command.identity.botUserId}
            or c.installation_id=${node.id} and c.name=${command.name}) for update of c`;
        if (binding && (binding.installation_id !== node.id || binding.name !== command.name || binding.team_id !== command.identity.teamId || binding.bot_user_id !== command.identity.botUserId))
          throw new FleetError("channel_owner_conflict", 409);
        if (binding && ["queued","delivered","uncertain"].includes(binding.state)) throw new FleetError("channel_operation_pending", 409);
        if (!binding && !command.enabled) throw new FleetError("channel_not_managed", 409);
      }
      const [created] = await tx`insert into fleet_node_operations(id,organization_id,installation_id,subject_id,session_id,command,digest,installation_revision,expires_at)
        values(${input.operationId},${actor.organizationId},${node.id},${actor.userId},${actor.sessionId!},${JSON.stringify(input.command)}::text::jsonb,
          ${digest},${node.management_revision},clock_timestamp()+interval '5 minutes') returning *`;
      if (input.command.kind === "channel.configure") {
        const command = input.command;
        await tx`insert into fleet_native_channels(id,organization_id,installation_id,name,team_id,bot_user_id,credential_connection,enabled,operation_id)
          values(${randomUUID()},${actor.organizationId},${node.id},${command.name},${command.identity.teamId},${command.identity.botUserId},${command.credentialConnection},${command.enabled},${input.operationId})
          on conflict(organization_id,team_id,bot_user_id) do update set credential_connection=excluded.credential_connection,enabled=excluded.enabled,operation_id=excluded.operation_id`;
      }
      await this.audit(tx, actor, "fleet.node.operation.queued", node.id, input.operationId);
      if (!created) throw new FleetError("operation_unavailable", 503);
      return operation(created);
    }, input.operationId);
  }
  channels(actor: FleetActor) {
    return this.authorize(actor, ["organization.installations.read"], async tx => {
      const rows = await tx`select c.*,p.state from fleet_native_channels c join fleet_node_operations p on p.id=c.operation_id where c.organization_id=${actor.organizationId} order by c.created_at limit 500`;
      return { channels: rows.map(row => ({ id: row.id, name: row.name, installationId: row.installation_id,
        identity: { teamId: row.team_id, botUserId: row.bot_user_id }, credentialConnection: row.credential_connection,
        enabled: row.enabled, operationId: row.operation_id, status: row.state })) };
    });
  }
  latestOperation(actor: FleetActor, installationId: string) {
    parse(z.string().uuid(), installationId);
    return this.authorize(actor, ["organization.installations.read"], async tx => {
      const [row] = await tx`select p.* from fleet_node_operations p join local_installations n on n.id=p.installation_id
        where p.installation_id=${installationId} and p.organization_id=${actor.organizationId} and p.subject_id=${actor.userId}
        and p.installation_revision=n.management_revision and p.command->>'kind'='health' order by p.created_at desc limit 1`;
      return { operation: row ? operation(row) : null };
    });
  }
  showOperation(actor: FleetActor, operationId: string) {
    parse(z.string().uuid(), operationId);
    return this.authorize(actor, ["organization.installations.read"], async tx => {
      const [row] = await tx`select * from fleet_node_operations where id=${operationId} and organization_id=${actor.organizationId} and subject_id=${actor.userId}`;
      if (!row) throw new FleetError("not_found", 404);
      return operation(row);
    });
  }
  private async onboarding(tx: TransactionSql) {
    const installations = await this.nodes(tx);
    const receipts = await tx`select id,installation_id from fleet_node_operations where organization_id=${this.organizationId} and state='succeeded' and command->>'kind'='health' order by id`;
    const [completed] = await tx`select 1 from fleet_onboarding where organization_id=${this.organizationId} and flow_version=2`;
    return { completed: !!completed, ready: installations.some(n => n.status === "online" && receipts.some(r => r.installation_id === n.id)), installations,
      snapshot: hash([installations.map(n => [n.id,n.revision,n.status]),receipts.map(r => r.id)]), receipts };
  }
  state(actor: FleetActor) {
    return this.authorize(actor, ["organization.onboarding.read", "organization.installations.read"], async tx => {
      const { receipts: _, ...state } = await this.onboarding(tx); return state;
    });
  }
  finish(actor: FleetActor, body: unknown) {
    const input = parse(finishSchema, body);
    return this.authorize(actor, ["organization.onboarding.manage", "organization.installations.read"], async tx => {
      const { receipts, ...state } = await this.onboarding(tx);
      if (state.completed) return state;
      if (state.snapshot !== input.snapshot) throw new FleetError("version_conflict", 409);
      if (!state.installations.some(n => n.status === "online" && receipts.some(r => r.installation_id === n.id)))
        throw new FleetError("installation_test_required", 409);
      await tx`insert into fleet_onboarding(organization_id,completed_by,snapshot_hash,completed_at,flow_version)
        values(${actor.organizationId},${actor.userId},${input.snapshot},clock_timestamp(),2)
        on conflict(organization_id) do update set completed_by=excluded.completed_by,snapshot_hash=excluded.snapshot_hash,completed_at=excluded.completed_at,flow_version=2`;
      await this.audit(tx, actor, "fleet.onboarding.completed", actor.organizationId, input.operationId);
      return { ...state, completed: true };
    }, input.operationId);
  }

  /** The credential is obtained only from the verified TLS socket, never headers. */
  private async currentNode(tx: TransactionSql, fingerprint: string) {
    const [row] = await tx`select n.*,c.id as credential_id,c.fingerprint,c.expires_at as credential_expires_at
      from fleet_node_credentials c join local_installations n on n.id=c.installation_id
      join organizations o on o.id=n.organization_id where c.fingerprint=${fingerprint}
      and c.revoked_at is null and c.expires_at>clock_timestamp() and n.status='active'
      and n.subject_type='installation' and o.status='active' and n.organization_id=${this.organizationId} for share of c,n,o`;
    if (!row) throw new FleetError("installation_revoked", 403);
    return row;
  }
  private async nodeTransaction<T>(fingerprint: string, run: (tx: TransactionSql, node: Row) => Promise<T>, rotates = false): Promise<T> {
    return await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${this.organizationId}`},0))`;
      const node = await this.currentNode(tx, fingerprint);
      const result = await run(tx, node);
      if (!rotates) await this.currentNode(tx, fingerprint);
      return result;
    }) as T;
  }
  heartbeat(fingerprint: string) {
    return this.nodeTransaction(fingerprint, async (tx, node) => {
      await tx`update local_installations set state_reported_at=clock_timestamp(),last_seen_at=clock_timestamp() where id=${node.id}`;
      return { installationId: node.id, revision: node.management_revision };
    });
  }
  async rotate(fingerprint: string, body: unknown) {
    const input = parse(z.object({ operationId: z.string().uuid(), csr: z.string().min(200).max(8192) }).strict(), body);
    const { fingerprint: csrFingerprint } = await verifiedRequest(input.csr);
    // A revoked predecessor may retrieve ONLY its exact rotation result after response loss.
    const recovered = await this.sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${this.organizationId}`},0))`;
      const [row] = await tx`select next.certificate,next.expires_at,next.csr_fingerprint,n.id,n.management_revision from fleet_node_credentials old
        join fleet_node_credentials next on next.installation_id=old.installation_id and next.rotation_operation=old.rotation_operation and next.revision=old.revision+1
        join local_installations n on n.id=old.installation_id join organizations o on o.id=n.organization_id
        where old.fingerprint=${fingerprint} and old.rotation_operation=${input.operationId}
        and next.revoked_at is null and next.expires_at>clock_timestamp() and n.status='active' and o.status='active'
        and n.organization_id=${this.organizationId} for share of old,next,n,o`;
      if (row && row.csr_fingerprint !== csrFingerprint) throw new FleetError("intent_conflict", 409);
      return row;
    });
    if (recovered) return { certificate: recovered.certificate, expiresAt: iso(recovered.expires_at), revision: recovered.management_revision };
    const current = await this.nodeTransaction(fingerprint, async (_tx, node) => node);
    const certificate = await this.issuer.issue(input.csr, current.id);
    return this.nodeTransaction(fingerprint, async (tx, node) => {
      await tx`update fleet_node_credentials set revoked_at=clock_timestamp(),rotation_operation=${input.operationId} where id=${node.credential_id}`;
      const [revision] = await tx`select coalesce(max(revision),0)+1 as revision from fleet_node_credentials where installation_id=${node.id}`;
      await tx`insert into fleet_node_credentials(id,installation_id,revision,fingerprint,certificate,expires_at,rotation_operation,csr_fingerprint)
        values(${randomUUID()},${node.id},${revision!.revision},${certificate.fingerprint},${certificate.certificate},${iso(certificate.expiresAt)},${input.operationId},${csrFingerprint})`;
      const [live] = await tx`select 1 from fleet_node_credentials where fingerprint=${certificate.fingerprint} and expires_at>clock_timestamp()`;
      if (!live || new Date(node.credential_expires_at).getTime() <= Date.now()) throw new FleetError("installation_revoked", 403);
      return { certificate: certificate.certificate, expiresAt: iso(certificate.expiresAt), revision: node.management_revision };
    }, true);
  }
  async nextCommand(fingerprint: string): Promise<CommandEnvelope | null> {
    const candidate = await this.nodeTransaction(fingerprint, async (tx, node) => {
      const [row] = await tx`select * from fleet_node_operations where installation_id=${node.id} and state in ('queued','delivered') order by created_at limit 1`;
      return row;
    });
    if (!candidate) return null;
    const actor: FleetActor = { mode: "oidc", role: "", organizationId: this.organizationId,
      userId: candidate.subject_id, sessionId: candidate.session_id };
    try {
      return await this.authorize(actor, ["organization.installations.read", "organization.installations.manage"], async tx => {
        const node = await this.currentNode(tx, fingerprint);
        const [row] = await tx`select *,expires_at<=clock_timestamp() as expired from fleet_node_operations where id=${candidate.id} and installation_id=${node.id} for update`;
        if (!row || !["queued","delivered"].includes(row.state)) return null;
        if (node.management_revision !== row.installation_revision || (row.state === "queued" && row.expired)) {
          await tx`update fleet_node_operations set state='cancelled',error='grant_expired' where id=${row.id}`;
          return null;
        }
        if (row.state === "queued") {
          const [updated] = await tx`update fleet_node_operations set state='delivered',delivered_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 seconds' where id=${row.id} returning *`;
          Object.assign(row, updated);
        }
        // Redelivery retains bytes/deadline. It is a receipt lookup, not renewed execution authority.
        return commandEnvelopeSchema.parse({ operationId: row.id, installationId: node.id, organizationId: this.organizationId,
          subject: row.subject_id, sessionId: row.session_id, revision: row.installation_revision,
          createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), digest: row.digest, command: row.command });
      }, candidate.id);
    } catch (error) {
      if (!(error instanceof FleetError) || ![401,403].includes(error.status)) throw error;
      await this.nodeTransaction(fingerprint, async tx => {
        await tx`update fleet_node_operations set state=case when state='queued' then 'cancelled' else 'uncertain' end,error='authorization_revoked'
          where id=${candidate.id} and state in ('queued','delivered')`;
      });
      return null;
    }
  }
  receipt(fingerprint: string, body: unknown) {
    const input = parse(receiptSchema, body);
    return this.nodeTransaction(fingerprint, async (tx, node) => {
      const [row] = await tx`select * from fleet_node_operations where id=${input.operationId} and installation_id=${node.id} for update`;
      if (!row || row.digest !== input.digest) throw new FleetError("receipt_conflict", 409);
      if (["succeeded","failed"].includes(row.state)) {
        if (row.state !== input.status || !isDeepStrictEqual(row.result, input.result) || row.error !== input.error) throw new FleetError("receipt_conflict", 409);
        return { accepted: true };
      }
      if (!["delivered","uncertain"].includes(row.state)) throw new FleetError("receipt_conflict", 409);
      if (input.status === "succeeded") {
        if (!input.result || input.result.kind !== row.command.kind || input.error) throw new FleetError("invalid_receipt", 400);
        parse(operationResultSchema, input.result);
        if (input.result.kind === "channel.configure") {
          const channel = input.result.channel;
          if (channel.name !== row.command.name || channel.provider !== row.command.provider || channel.enabled !== row.command.enabled || channel.credentialConnection !== row.command.credentialConnection)
            throw new FleetError("invalid_receipt", 400);
        }
      } else if (input.result) throw new FleetError("invalid_receipt", 400);
      await tx`update fleet_node_operations set state=${input.status},result=${input.result ? JSON.stringify(input.result) : null}::text::jsonb,error=${input.error},completed_at=clock_timestamp() where id=${row.id}`;
      return { accepted: true };
    });
  }
}
