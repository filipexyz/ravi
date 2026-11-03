import type { Sql, TransactionSql } from "postgres";
import { type Credential, type FleetActor, type FleetStore, type FleetTransaction,
  type Installation, type MutationReceipt } from "./contract";
import { withFleetAuthorization } from "./authorization";
import { postgresReservations } from "./io-reservation";

const iso = (value: string | Date) => new Date(value).toISOString();
type CredentialRow = { id: string; label: string; kind: Credential["kind"]; revision: number; secret_version: number;
  binding_json: Credential["binding"] | string;
  status: Credential["status"]; created_at: Date; updated_at: Date };
type InstallationRow = { id: string; label: string; hostname: string; port: number; username: string; host_fingerprint: string;
  credential_id: string; revision: number; status: Installation["status"]; tested_credential_revision: number | null;
  tested_at: Date | null; cli_version: string | null; failure_code: string | null; created_at: Date; updated_at: Date };
function credential(row: CredentialRow): Credential {
  return { id: row.id, label: row.label, kind: row.kind, revision: row.revision, secretVersion: row.secret_version,
    binding: typeof row.binding_json === "string" ? JSON.parse(row.binding_json) : row.binding_json,
    status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function installation(row: InstallationRow): Installation {
  return { id: row.id, label: row.label, hostname: row.hostname, port: row.port, username: row.username,
    hostFingerprint: row.host_fingerprint, credentialId: row.credential_id, revision: row.revision, status: row.status,
    testedCredentialRevision: row.tested_credential_revision, testedAt: row.tested_at ? iso(row.tested_at) : null,
    cliVersion: row.cli_version, failureCode: row.failure_code, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export function transactionView(sql: TransactionSql, actor: FleetActor): FleetTransaction {
  const org = actor.organizationId;
  return {
    ...postgresReservations(sql, actor),
    async credential(id) {
      const rows = await sql<CredentialRow[]>`select * from fleet_credentials where organization_id=${org} and id=${id}`;
      return rows[0] ? credential(rows[0]) : null;
    },
    async credentials() { return (await sql<CredentialRow[]>`select * from fleet_credentials where organization_id=${org} order by created_at,id`).map(credential); },
    async putCredential(value) {
      await sql`insert into fleet_credentials (organization_id,id,label,kind,binding_json,revision,secret_version,status,created_at,updated_at)
        values (${org},${value.id},${value.label},${value.kind},${JSON.stringify(value.binding)}::jsonb,${value.revision},${value.secretVersion},${value.status},${value.createdAt},${value.updatedAt})
        on conflict (organization_id,id) do update set label=excluded.label,revision=excluded.revision,
          secret_version=excluded.secret_version,status=excluded.status,updated_at=excluded.updated_at`;
      await sql`update fleet_sso_connections set status='draft',revision=revision+1,tested_at=null,tested_by=null,
        tested_session_hash=null,tested_subject=null,tested_email=null,tested_groups=null,updated_at=now()
        where organization_id=${org} and credential_id=${value.id} and status in ('draft','tested')`;
    },
    async installation(id) {
      const rows = await sql<InstallationRow[]>`select * from fleet_installations where organization_id=${org} and id=${id}`;
      return rows[0] ? installation(rows[0]) : null;
    },
    async installations() { return (await sql<InstallationRow[]>`select * from fleet_installations where organization_id=${org} order by created_at,id`).map(installation); },
    async putInstallation(value) {
      await sql`insert into fleet_installations (organization_id,id,label,hostname,port,username,host_fingerprint,credential_id,
          revision,status,tested_credential_revision,tested_at,cli_version,failure_code,created_at,updated_at)
        values (${org},${value.id},${value.label},${value.hostname},${value.port},${value.username},${value.hostFingerprint},${value.credentialId},
          ${value.revision},${value.status},${value.testedCredentialRevision},${value.testedAt},${value.cliVersion},${value.failureCode},${value.createdAt},${value.updatedAt})
        on conflict (organization_id,id) do update set label=excluded.label,hostname=excluded.hostname,port=excluded.port,
          username=excluded.username,host_fingerprint=excluded.host_fingerprint,credential_id=excluded.credential_id,
          revision=excluded.revision,status=excluded.status,tested_credential_revision=excluded.tested_credential_revision,
          tested_at=excluded.tested_at,cli_version=excluded.cli_version,failure_code=excluded.failure_code,updated_at=excluded.updated_at`;
    },
    async credentialInActiveSso(id) {
      return (await sql`select id from fleet_sso_connections where organization_id=${org} and credential_id=${id} and status='active' limit 1`).length > 0;
    },
    async receipt(id) {
      const [row] = await sql`select input_hash,result_json from fleet_mutation_receipts where organization_id=${org} and operation_id=${id}`;
      return row ? { inputHash: row.input_hash, result: typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json } as MutationReceipt : null;
    },
    async putReceipt(id, value) {
      await sql`insert into fleet_mutation_receipts (organization_id,operation_id,input_hash,result_json)
        values (${org},${id},${value.inputHash},${JSON.stringify(value.result)}::jsonb)`;
    },
    async audit(action, targetId, metadata) {
      await sql`insert into audit_events (organization_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
        values (${org},'user',${actor.userId},'fleet',${targetId},${action},${String(metadata.operationId ?? "")},${JSON.stringify(metadata)}::jsonb)`;
    },
  };
}
export function postgresFleetStore(sql: Sql): FleetStore {
  return { async transaction(actor, actions, run, requestId) {
    return withFleetAuthorization(sql, actor.organizationId, actor, actions,
      tx => run(transactionView(tx, actor)), requestId);
  } };
}
