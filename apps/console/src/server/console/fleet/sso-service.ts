import { createHash, randomUUID } from "node:crypto";
import { operationDigest, matchesOperationDigest } from "./operation-digest";
import type { Sql, TransactionSql } from "postgres";
import { FleetError, parseFleet, revisionActionSchema, type FleetActor, type SecretVault } from "./contract";
import { withFleetAuthorization } from "./authorization";
import type { OrganizationAction } from "../authorization/policy";
import { admissionGroupsAllow, ssoConfigSchema, ssoActivateSchema, ssoWriteSchema, type SsoConnection, type SsoState } from "./sso-contract";
import { beginOidcLogin, completeOidcLogin, type OidcVerifiedIdentity } from "@/lib/auth/oidc-client";
import { openOidcTransaction, sealOidcTransaction } from "@/lib/auth/oidc-transaction";
import { oidcProvider, type OidcConfig } from "@/lib/auth/oidc-config";
import { postgresReservations, assertReservation, reservationConflict } from "./io-reservation";

export const SSO_TEST_CALLBACK = "/callback/fleet";
export const SSO_TEST_COOKIE = "__Host-ravi_fleet_oidc";
type BaseConfig = Omit<OidcConfig, "issuer" | "clientId" | "clientSecret">;
const decode = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) : value;
const iso = (value: string | Date) => new Date(value).toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type SsoRow = { id: string; revision: number; status: SsoConnection["status"]; issuer: string; client_id: string;
  credential_id: string; credential_version: number; config_json: string | Pick<SsoConnection, "label" | "allowPrivateNetwork" | "admissionGroups">;
  tested_at: Date | null; tested_by: string | null; tested_session_hash: string | null;
  tested_subject: string | null; tested_email: string | null; tested_groups: string[] | string | null; updated_at: Date };
function publicConnection(row: SsoRow): SsoConnection {
  return { id: row.id, revision: row.revision, status: row.status, issuer: row.issuer, clientId: row.client_id,
    credentialId: row.credential_id, credentialVersion: row.credential_version, ...ssoConfigSchema.parse(decode(row.config_json)),
    testedAt: row.tested_at ? iso(row.tested_at) : null, testedBy: row.tested_by, updatedAt: iso(row.updated_at) };
}
type LoginDriver = { begin: typeof beginOidcLogin; complete: typeof completeOidcLogin };

/** All changes lock the same org key as credential rotation/revocation. Login
 * driver injection is for isolated tests only; runtime always uses openid-client. */
export class FleetSsoService {
  constructor(private sql: Sql, private vault: SecretVault, private base: BaseConfig,
    private driver: LoginDriver = { begin: beginOidcLogin, complete: completeOidcLogin }) {}
  private async transaction<T>(actor: FleetActor, sessionHash: string, action: OrganizationAction, run: (tx: TransactionSql, member: { role: string; email: string }) => Promise<T>, requestId?: string): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(sessionHash)) throw new FleetError("auth_required", 401);
    return withFleetAuthorization(this.sql, this.base.organizationId, actor, [action], async tx => {
      const [member] = await tx`select m.role,u.primary_email as email from organization_memberships m
        join users u on u.id=m.user_id join organizations o on o.id=m.organization_id
        join console_browser_sessions s on s.user_id=u.id and s.organization_id=m.organization_id
        where m.organization_id=${actor.organizationId} and m.user_id=${actor.userId} and m.status='active'
          and u.status='active' and o.status='active' and s.token_hash=${sessionHash} and s.revoked_at is null and s.expires_at>clock_timestamp()
        for share of m,u,o,s`;
      if (!member) throw new FleetError("forbidden", 403);
      const result = await run(tx, { role: member.role, email: member.email.toLowerCase() });
      const [current] = await tx`select 1 from console_browser_sessions where token_hash=${sessionHash} and revoked_at is null and expires_at>clock_timestamp()`;
      if (!current) throw new FleetError("forbidden", 403);
      return result;
    }, requestId);
  }
  private inputHash(actor: FleetActor, operation: string, input: unknown) {
    return operationDigest(this.base.secret, "fleet-sso", JSON.stringify({ actor: actor.userId, operation, input }));
  }
  private matchesHash(stored: string, actor: FleetActor, operation: string, input: unknown) {
    return matchesOperationDigest(stored, this.base.secret, "fleet-sso", JSON.stringify({ actor: actor.userId, operation, input }));
  }
  private async ioTransaction<P, E, T>(actor: FleetActor, sessionHash: string, operationId: string, inputHash: string,
    prepare: (tx: TransactionSql) => Promise<{ kind: "replay"; replay: T } | { kind: "snapshot"; snapshot: P }>, external: (snapshot: P) => Promise<E>,
    finish: (tx: TransactionSql, member: { role: string; email: string }, snapshot: P, observed: E) => Promise<T>): Promise<T> {
    const leaseId = randomUUID();
    const start = await this.transaction(actor, sessionHash, "organization.sso.manage", async tx => {
      const prepared = await prepare(tx);
      if (prepared.kind === "replay") return prepared;
      // Client operation ids are UUIDs. The server-only callback namespace is
      // text and cannot collide with a UUID receipt (nor be supplied by a body).
      if (!operationId.startsWith("sso-complete:")) {
        const [receipt] = await tx`select 1 from fleet_mutation_receipts where organization_id=${actor.organizationId} and operation_id=${operationId}`;
        if (receipt) throw new FleetError("idempotency_conflict", 409);
      }
      const reservations = postgresReservations(tx, actor), previous = await reservations.reservation(operationId);
      if (previous) {
        if (previous.inputHash !== inputHash) throw new FleetError("idempotency_conflict", 409);
        reservationConflict(previous);
      }
      await reservations.putReservation(operationId, { inputHash, leaseId, expiresAt: new Date(Date.now() + 120000).toISOString(), completed: false });
      return prepared;
    }, operationId);
    if (start.kind === "replay") return start.replay;
    const observed = await external(start.snapshot);
    return this.transaction(actor, sessionHash, "organization.sso.manage", async (tx, member) => {
      const reservations = postgresReservations(tx, actor);
      assertReservation(await reservations.reservation(operationId), leaseId, inputHash);
      const result = await finish(tx, member, start.snapshot, observed);
      assertReservation(await reservations.reservation(operationId), leaseId, inputHash);
      await reservations.finishReservation(operationId);
      return result;
    }, operationId);
  }
  private async secretConfig(actor: FleetActor, sessionHash: string, row: SsoRow, config: OidcConfig) {
    const clientSecret = await this.vault.read({ organizationId: this.base.organizationId,
      credentialId: row.credential_id, version: row.credential_version });
    // A stalled Vault read must not carry an already revoked secret into IdP I/O.
    await this.transaction(actor, sessionHash, "organization.sso.manage", async tx => {
      await this.config(tx, await this.row(tx, actor, row.id, row.revision));
    });
    return { ...config, clientSecret };
  }
  private async audit(tx: TransactionSql, actor: FleetActor, action: string, id: string, operationId: string) {
    await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
      values(${actor.organizationId},'user',${actor.userId},'fleet',${id},${action},${operationId},'{}'::jsonb)`;
  }
  private async row(tx: TransactionSql, actor: FleetActor, id: string, revision?: number) {
    const [row] = await tx<SsoRow[]>`select * from fleet_sso_connections where organization_id=${actor.organizationId} and id=${id}`;
    if (!row) throw new FleetError("not_found", 404);
    if (revision !== undefined && revision !== row.revision) throw new FleetError("version_conflict", 409);
    return row;
  }
  private async config(tx: TransactionSql, row: SsoRow): Promise<OidcConfig> {
    const [credential] = await tx`select * from fleet_credentials where organization_id=${this.base.organizationId} and id=${row.credential_id}`;
    const binding = credential ? decode<{ issuer: string; clientId: string } | null>(credential.binding_json) : null;
    if (!credential || credential.status !== "active" || credential.kind !== "oidc_client_secret" ||
        credential.secret_version !== row.credential_version || binding?.issuer !== row.issuer || binding.clientId !== row.client_id) {
      throw new FleetError("sso_credential_changed", 409);
    }
    const config = ssoConfigSchema.parse(decode(row.config_json));
    return { ...this.base, issuer: row.issuer, clientId: row.client_id,
      clientSecret: "",
      generation: `${row.id}:${row.revision}:${row.credential_version}`, admissionGroups: config.admissionGroups,
      networkPolicy: { allowPrivate: config.allowPrivateNetwork } };
  }
  async state(actor: FleetActor, sessionHash: string): Promise<SsoState> {
    return this.transaction(actor, sessionHash, "organization.sso.read", async tx => {
      const rows = await tx<SsoRow[]>`select * from fleet_sso_connections where organization_id=${actor.organizationId} order by created_at,id`;
      return { connections: rows.map(publicConnection), source: rows.some(row => row.status === "active") ? "database" : "bootstrap" };
    });
  }
  async save(actor: FleetActor, sessionHash: string, body: unknown) {
    const input = parseFleet(ssoWriteSchema, body), inputHash = this.inputHash(actor, "sso.save", input);
    return this.transaction(actor, sessionHash, "organization.sso.manage", async tx => {
      const [receipt] = await tx`select * from fleet_mutation_receipts where organization_id=${actor.organizationId} and operation_id=${input.operationId}`;
      if (receipt) { if (!this.matchesHash(receipt.input_hash, actor, "sso.save", input)) throw new FleetError("idempotency_conflict", 409); return decode<SsoConnection>(receipt.result_json); }
      if (await postgresReservations(tx, actor).reservation(input.operationId)) throw new FleetError("idempotency_conflict", 409);
      const [existing] = await tx<SsoRow[]>`select * from fleet_sso_connections where organization_id=${actor.organizationId} and id=${input.id}`;
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      if (existing?.status === "active") throw new FleetError("active_sso_immutable", 409);
      const [credential] = await tx`select * from fleet_credentials where organization_id=${actor.organizationId} and id=${input.credentialId}`;
      const binding = credential ? decode<{ issuer: string; clientId: string } | null>(credential.binding_json) : null;
      if (!credential || credential.status !== "active" || credential.kind !== "oidc_client_secret" || binding?.issuer !== input.issuer || binding.clientId !== input.clientId) {
        throw new FleetError("sso_credential_binding_required");
      }
      const config = JSON.stringify({ label: input.label, allowPrivateNetwork: input.allowPrivateNetwork, admissionGroups: input.admissionGroups });
      const [row] = await tx<SsoRow[]>`insert into fleet_sso_connections(organization_id,id,revision,status,issuer,client_id,credential_id,credential_version,config_json)
        values(${actor.organizationId},${input.id},${input.expectedRevision + 1},'draft',${input.issuer},${input.clientId},${input.credentialId},${credential.secret_version},${config}::jsonb)
        on conflict(organization_id,id) do update set revision=excluded.revision,status='draft',issuer=excluded.issuer,client_id=excluded.client_id,
          credential_id=excluded.credential_id,credential_version=excluded.credential_version,config_json=excluded.config_json,
          tested_at=null,tested_by=null,tested_session_hash=null,tested_subject=null,tested_email=null,tested_groups=null,updated_at=now() returning *`;
      const result = publicConnection(row!);
      await tx`insert into fleet_mutation_receipts(organization_id,operation_id,input_hash,result_json) values(${actor.organizationId},${input.operationId},${inputHash},${JSON.stringify(result)}::jsonb)`;
      await this.audit(tx, actor, "fleet.sso.saved", input.id, input.operationId);
      return result;
    }, input.operationId);
  }
  async beginTest(actor: FleetActor, sessionHash: string, body: unknown) {
    const input = parseFleet(revisionActionSchema, body), inputHash = this.inputHash(actor, "sso.test", input);
    return this.ioTransaction(actor, sessionHash, input.operationId, inputHash, async tx => {
      const row = await this.row(tx, actor, input.id, input.expectedRevision);
      if (row.status === "active" || row.status === "retired") throw new FleetError("sso_draft_required", 409);
      const config = await this.config(tx, row);
      const [previous] = await tx`select * from fleet_sso_challenges where organization_id=${actor.organizationId} and id=${input.operationId}`;
      if (previous) {
        if (!this.matchesHash(previous.input_hash, actor, "sso.test", input) || previous.session_hash !== sessionHash || previous.actor_id !== actor.userId) throw new FleetError("idempotency_conflict", 409);
        if (previous.consumed_at || new Date(previous.expires_at).getTime() <= Date.now()) throw new FleetError("sso_test_expired", 409);
        return { kind: "replay", replay: { url: previous.authorization_url as string, cookie: previous.transaction_ciphertext as string } };
      }
      return { kind: "snapshot", snapshot: { row, config } };
    }, async ({ row, config: metadata }) => {
      const config = await this.secretConfig(actor, sessionHash, row, metadata);
      const { transaction, url } = await this.driver.begin("/projects", config, SSO_TEST_CALLBACK);
      const cookie = await sealOidcTransaction(transaction, config);
      return { transaction, url, cookie };
    }, async (tx, _member, { row }, { transaction, url, cookie }) => {
      const current = await this.row(tx, actor, row.id, row.revision);
      await this.config(tx, current);
      await tx`insert into fleet_sso_challenges(organization_id,id,connection_id,connection_revision,credential_version,actor_id,session_hash,state_hash,input_hash,
        transaction_ciphertext,authorization_url,expires_at) values(${actor.organizationId},${input.operationId},${row.id},${row.revision},${row.credential_version},
        ${actor.userId},${sessionHash},${hash(transaction.state)},${inputHash},${cookie},${url.toString()},clock_timestamp()+interval '5 minutes')`;
      await this.audit(tx, actor, "fleet.sso.test.started", row.id, input.operationId);
      return { url: url.toString(), cookie };
    });
  }
  async completeTest(actor: FleetActor, sessionHash: string, callback: URL, cookie: string) {
    if (callback.origin !== this.base.origin || callback.pathname !== SSO_TEST_CALLBACK || !callback.searchParams.get("state")) throw new FleetError("sso_callback_invalid");
    const operationId = `sso-complete:${hash(callback.searchParams.get("state")!)}`;
    const inputHash = this.inputHash(actor, "sso.complete", { sessionHash, callback: callback.toString(), cookie });
    return this.ioTransaction(actor, sessionHash, operationId, inputHash, async tx => {
      const [challenge] = await tx`select * from fleet_sso_challenges where organization_id=${actor.organizationId} and state_hash=${hash(callback.searchParams.get("state")!)}`;
      if (!challenge || challenge.actor_id !== actor.userId || challenge.session_hash !== sessionHash || challenge.consumed_at ||
        new Date(challenge.expires_at).getTime() <= Date.now() || challenge.transaction_ciphertext !== cookie) throw new FleetError("sso_test_expired", 409);
      const row = await this.row(tx, actor, challenge.connection_id, challenge.connection_revision);
      const config = await this.config(tx, row);
      return { kind: "snapshot", snapshot: { challenge, row, config } };
    }, async ({ row, config: metadata }) => {
      const config = await this.secretConfig(actor, sessionHash, row, metadata);
      const transaction = await openOidcTransaction(cookie, config);
      return this.driver.complete(callback, transaction, config, SSO_TEST_CALLBACK);
    }, async (tx, member, { challenge, row }, identity) => {
      const current = await this.row(tx, actor, row.id, row.revision);
      const config = await this.config(tx, current);
      const [live] = await tx`select 1 from fleet_sso_challenges where organization_id=${actor.organizationId}
        and id=${challenge.id} and consumed_at is null and expires_at>clock_timestamp()`;
      if (!live) throw new FleetError("sso_test_expired", 409);
      this.validateIdentity(identity, member, config);
      await this.checkIdentityOwner(tx, actor, identity);
      await tx`update fleet_sso_challenges set consumed_at=now() where organization_id=${actor.organizationId} and id=${challenge.id}`;
      const [tested] = await tx<SsoRow[]>`update fleet_sso_connections set status='tested',revision=revision+1,tested_at=now(),tested_by=${actor.userId},
        tested_session_hash=${sessionHash},tested_subject=${identity.subject},tested_email=${identity.email.toLowerCase()},tested_groups=${JSON.stringify(identity.groups ?? [])}::jsonb,updated_at=now()
        where organization_id=${actor.organizationId} and id=${row.id} returning *`;
      await this.audit(tx, actor, "fleet.sso.test.completed", row.id, challenge.id);
      return publicConnection(tested!);
    });
  }
  private validateIdentity(identity: OidcVerifiedIdentity, member: { role: string; email: string }, config: OidcConfig) {
    if (identity.issuer !== config.issuer || !identity.subject || identity.emailVerified !== true || identity.email.toLowerCase() !== member.email ||
      !admissionGroupsAllow(config.admissionGroups ?? [], identity.groups ?? [])) throw new FleetError("sso_admin_identity_mismatch", 403);
  }
  private async checkIdentityOwner(tx: TransactionSql, actor: FleetActor, identity: Pick<OidcVerifiedIdentity, "issuer" | "subject">) {
    const [existing] = await tx`select user_id from auth_identities where provider=${oidcProvider(identity.issuer)} and provider_user_id=${identity.subject}`;
    if (existing && existing.user_id !== actor.userId) throw new FleetError("sso_identity_owned_elsewhere", 409);
  }
  async activate(actor: FleetActor, sessionHash: string, body: unknown) {
    const input = parseFleet(ssoActivateSchema, body), inputHash = this.inputHash(actor, "sso.activate", input);
    return this.ioTransaction(actor, sessionHash, input.operationId, inputHash, async tx => {
      const [receipt] = await tx`select * from fleet_mutation_receipts where organization_id=${actor.organizationId} and operation_id=${input.operationId}`;
      if (receipt) { if (!this.matchesHash(receipt.input_hash, actor, "sso.activate", input)) throw new FleetError("idempotency_conflict", 409); return { kind: "replay", replay: decode<SsoConnection>(receipt.result_json) }; }
      const row = await this.row(tx, actor, input.id, input.expectedRevision);
      return { kind: "snapshot", snapshot: { row, config: await this.config(tx, row) } };
    }, async ({ row, config }) => { await this.secretConfig(actor, sessionHash, row, config); },
    async (tx, member, snapshot) => {
      const row = await this.row(tx, actor, snapshot.row.id, snapshot.row.revision);
      const config = await this.config(tx, row);
      const groups = decode<string[]>(row.tested_groups ?? []);
      if (row.status !== "tested" || !row.tested_at || Date.now()-new Date(row.tested_at).getTime() > 300000 ||
        row.tested_by !== actor.userId || row.tested_session_hash !== sessionHash || !row.tested_subject || row.tested_email !== member.email ||
        !admissionGroupsAllow(config.admissionGroups ?? [], groups)) throw new FleetError("fresh_sso_login_required", 409);
      await this.checkIdentityOwner(tx, actor, { issuer: row.issuer, subject: row.tested_subject });
      const [identity] = await tx`insert into auth_identities(provider,provider_user_id,user_id,email)
        values(${oidcProvider(row.issuer)},${row.tested_subject},${actor.userId},${member.email})
        on conflict(provider,provider_user_id) do update set email=excluded.email where auth_identities.user_id=excluded.user_id returning id`;
      if (!identity) throw new FleetError("sso_identity_owned_elsewhere", 409);
      await tx`update fleet_sso_connections set status='retired',revision=revision+1,updated_at=now() where organization_id=${actor.organizationId} and status='active'`;
      const [active] = await tx<SsoRow[]>`update fleet_sso_connections set status='active',revision=revision+1,updated_at=now() where organization_id=${actor.organizationId} and id=${row.id} returning *`;
      // Preserve only the validated admin session under the new identity. Other
      // sessions are explicitly revoked, including same-issuer client changes.
      await tx`update console_browser_sessions set revoked_at=now() where organization_id=${actor.organizationId} and token_hash<>${sessionHash} and revoked_at is null`;
      await tx`update console_browser_sessions set auth_identity_id=${identity.id},oidc_groups=${JSON.stringify(groups)}::jsonb
        where organization_id=${actor.organizationId} and token_hash=${sessionHash} and user_id=${actor.userId}`;
      const result = publicConnection(active!);
      await tx`insert into fleet_mutation_receipts(organization_id,operation_id,input_hash,result_json) values(${actor.organizationId},${input.operationId},${inputHash},${JSON.stringify(result)}::jsonb)`;
      await this.audit(tx, actor, "fleet.sso.activated", row.id, input.operationId);
      return result;
    });
  }
}

/** Reads selection from DB on each request. No catch/fallback on DB or Vault
 * failure. includeSecret=false is only for session checks/readiness metadata. */
export async function loadManagedOidc(sql: Sql, vault: SecretVault, base: BaseConfig, includeSecret: boolean): Promise<OidcConfig | null> {
  const [row] = await sql<(SsoRow & { secret_status: string | null; secret_kind: string | null; secret_version: number | null; binding_json: unknown })[]>`
    select c.*,k.status secret_status,k.kind secret_kind,k.secret_version,k.binding_json from fleet_sso_connections c
    left join fleet_credentials k on k.organization_id=c.organization_id and k.id=c.credential_id
    where c.organization_id=${base.organizationId} and c.status='active'`;
  if (!row) return null;
  const binding = decode<{ issuer: string; clientId: string } | null>(row.binding_json as string | null);
  if (row.secret_status !== "active" || row.secret_kind !== "oidc_client_secret" || row.secret_version !== row.credential_version || binding?.issuer !== row.issuer || binding.clientId !== row.client_id) throw new FleetError("sso_credential_changed", 503);
  const config = ssoConfigSchema.parse(decode(row.config_json));
  let clientSecret = "";
  if (includeSecret) {
    clientSecret = await vault.read({ organizationId: base.organizationId, credentialId: row.credential_id, version: row.credential_version });
    const [current] = await sql`select 1 from fleet_sso_connections c join fleet_credentials k on k.organization_id=c.organization_id and k.id=c.credential_id
      where c.organization_id=${base.organizationId} and c.id=${row.id} and c.revision=${row.revision} and c.status='active'
      and k.status='active' and k.kind='oidc_client_secret' and k.secret_version=${row.credential_version}`;
    if (!current) throw new FleetError("sso_credential_changed", 503);
  }
  return { ...base, issuer: row.issuer, clientId: row.client_id,
    clientSecret,
    generation: `${row.id}:${row.revision}:${row.credential_version}`, admissionGroups: config.admissionGroups, networkPolicy: { allowPrivate: config.allowPrivateNetwork } };
}
