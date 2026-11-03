import postgres, { type Sql } from "postgres";

import type { HyperdriveBinding } from "./env";

export type JsonRecord = Record<string, unknown>;

export interface ChannelsDb {
  sql: Sql;
  close(): Promise<void>;
}

export function openChannelsDb(hyperdrive: HyperdriveBinding): ChannelsDb {
  const sql = postgres(hyperdrive.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
    onnotice: () => {},
    debug: false,
  });
  return {
    sql,
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

export interface MembershipRecord {
  role: string;
  status: string;
}

export async function findActiveMembership(
  db: ChannelsDb,
  input: { organizationId: string; userId: string },
): Promise<MembershipRecord | null> {
  const rows = await db.sql<MembershipRecord[]>`
    select role, status
    from organization_memberships
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and status = 'active'
    limit 1
  `;
  return rows[0] ?? null;
}

export interface ChannelHostRecord {
  id: string;
  provider: "omni";
  displayName: string;
  environment: "production" | "staging" | "development";
  region: string | null;
  tenantMode: "shared" | "dedicated";
  controlBaseUrlRef: string;
  status: "active" | "degraded" | "disabled";
  capacityJson: JsonRecord;
  healthJson: JsonRecord;
  lastHealthAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function ensureDefaultOmniHost(db: ChannelsDb): Promise<ChannelHostRecord> {
  const existing = await db.sql<ChannelHostRecord[]>`
    select
      id, provider, display_name as "displayName", environment, region,
      tenant_mode as "tenantMode", control_base_url_ref as "controlBaseUrlRef",
      status, capacity_json as "capacityJson", health_json as "healthJson",
      last_health_at as "lastHealthAt", created_at as "createdAt",
      updated_at as "updatedAt"
    from channel_hosts
    where provider = 'omni'
      and status in ('active', 'degraded')
    order by created_at asc
    limit 1
  `;
  if (existing[0]) return existing[0];

  const inserted = await db.sql<ChannelHostRecord[]>`
    insert into channel_hosts (
      provider, display_name, environment, tenant_mode, control_base_url_ref, status
    ) values (
      'omni', 'Omni Primary', 'production', 'shared', 'env:RAVI_CHANNELS_OMNI_BASE_URL', 'active'
    )
    returning
      id, provider, display_name as "displayName", environment, region,
      tenant_mode as "tenantMode", control_base_url_ref as "controlBaseUrlRef",
      status, capacity_json as "capacityJson", health_json as "healthJson",
      last_health_at as "lastHealthAt", created_at as "createdAt",
      updated_at as "updatedAt"
  `;
  return inserted[0]!;
}

export async function updateChannelHostHealth(
  db: ChannelsDb,
  input: {
    id: string;
    status: "active" | "degraded";
    health: JsonRecord;
  },
): Promise<ChannelHostRecord> {
  const rows = await db.sql<ChannelHostRecord[]>`
    update channel_hosts set
      status = ${input.status},
      health_json = ${db.sql.json(input.health as never)},
      last_health_at = now(),
      updated_at = now()
    where id = ${input.id}
    returning
      id, provider, display_name as "displayName", environment, region,
      tenant_mode as "tenantMode", control_base_url_ref as "controlBaseUrlRef",
      status, capacity_json as "capacityJson", health_json as "healthJson",
      last_health_at as "lastHealthAt", created_at as "createdAt",
      updated_at as "updatedAt"
  `;
  return rows[0]!;
}

export interface ChannelInstanceRecord {
  id: string;
  organizationId: string;
  hostId: string;
  channel: "whatsapp";
  provider: "omni";
  externalInstanceId: string;
  externalInstanceName: string;
  displayName: string;
  phoneE164: string | null;
  phoneDisplay: string | null;
  status: ChannelInstanceStatus;
  connectionState: string | null;
  createdByUserId: string | null;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastHealthAt: Date | null;
  deletedAt: Date | null;
  metadataJson: JsonRecord;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelInstanceStatus =
  | "provisioning"
  | "qr_pending"
  | "connected"
  | "disconnected"
  | "degraded"
  | "disabled"
  | "deleting"
  | "deleted";

export async function listChannelInstances(
  db: ChannelsDb,
  organizationId: string,
): Promise<ChannelInstanceRecord[]> {
  return db.sql<ChannelInstanceRecord[]>`
    select
      id, organization_id as "organizationId", host_id as "hostId",
      channel, provider, external_instance_id as "externalInstanceId",
      external_instance_name as "externalInstanceName", display_name as "displayName",
      phone_e164 as "phoneE164", phone_display as "phoneDisplay",
      status, connection_state as "connectionState",
      created_by_user_id as "createdByUserId",
      last_connected_at as "lastConnectedAt",
      last_disconnected_at as "lastDisconnectedAt",
      last_health_at as "lastHealthAt", deleted_at as "deletedAt",
      metadata_json as "metadataJson", created_at as "createdAt", updated_at as "updatedAt"
    from channel_instances
    where organization_id = ${organizationId}
      and deleted_at is null
      and status <> 'deleted'
    order by created_at desc
  `;
}

export async function findChannelInstance(
  db: ChannelsDb,
  input: { id: string; organizationId: string },
): Promise<ChannelInstanceRecord | null> {
  const rows = await db.sql<ChannelInstanceRecord[]>`
    select
      id, organization_id as "organizationId", host_id as "hostId",
      channel, provider, external_instance_id as "externalInstanceId",
      external_instance_name as "externalInstanceName", display_name as "displayName",
      phone_e164 as "phoneE164", phone_display as "phoneDisplay",
      status, connection_state as "connectionState",
      created_by_user_id as "createdByUserId",
      last_connected_at as "lastConnectedAt",
      last_disconnected_at as "lastDisconnectedAt",
      last_health_at as "lastHealthAt", deleted_at as "deletedAt",
      metadata_json as "metadataJson", created_at as "createdAt", updated_at as "updatedAt"
    from channel_instances
    where id = ${input.id}
      and organization_id = ${input.organizationId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function insertPendingChannelInstance(
  db: ChannelsDb,
  input: {
    id: string;
    organizationId: string;
    hostId: string;
    displayName: string;
    externalInstanceName: string;
    createdByUserId: string;
    metadata: JsonRecord;
  },
): Promise<ChannelInstanceRecord> {
  const rows = await db.sql<ChannelInstanceRecord[]>`
    insert into channel_instances (
      id, organization_id, host_id, channel, provider, external_instance_id,
      external_instance_name, display_name, status, created_by_user_id,
      metadata_json
    ) values (
      ${input.id},
      ${input.organizationId},
      ${input.hostId},
      'whatsapp',
      'omni',
      ${`pending:${input.id}`},
      ${input.externalInstanceName},
      ${input.displayName},
      'provisioning',
      ${input.createdByUserId},
      ${db.sql.json(input.metadata as never)}
    )
    returning
      id, organization_id as "organizationId", host_id as "hostId",
      channel, provider, external_instance_id as "externalInstanceId",
      external_instance_name as "externalInstanceName", display_name as "displayName",
      phone_e164 as "phoneE164", phone_display as "phoneDisplay",
      status, connection_state as "connectionState",
      created_by_user_id as "createdByUserId",
      last_connected_at as "lastConnectedAt",
      last_disconnected_at as "lastDisconnectedAt",
      last_health_at as "lastHealthAt", deleted_at as "deletedAt",
      metadata_json as "metadataJson", created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0]!;
}

export async function updateChannelInstanceProvisioned(
  db: ChannelsDb,
  input: {
    id: string;
    organizationId: string;
    externalInstanceId: string;
    status: ChannelInstanceStatus;
    connectionState: string | null;
    phoneE164?: string | null;
    phoneDisplay?: string | null;
    metadata: JsonRecord;
  },
): Promise<ChannelInstanceRecord> {
  const rows = await db.sql<ChannelInstanceRecord[]>`
    update channel_instances set
      external_instance_id = ${input.externalInstanceId},
      status = ${input.status},
      connection_state = ${input.connectionState},
      phone_e164 = coalesce(${input.phoneE164 ?? null}, phone_e164),
      phone_display = coalesce(${input.phoneDisplay ?? null}, phone_display),
      metadata_json = metadata_json || ${db.sql.json(input.metadata as never)}::jsonb,
      last_health_at = now(),
      updated_at = now()
    where id = ${input.id}
      and organization_id = ${input.organizationId}
    returning
      id, organization_id as "organizationId", host_id as "hostId",
      channel, provider, external_instance_id as "externalInstanceId",
      external_instance_name as "externalInstanceName", display_name as "displayName",
      phone_e164 as "phoneE164", phone_display as "phoneDisplay",
      status, connection_state as "connectionState",
      created_by_user_id as "createdByUserId",
      last_connected_at as "lastConnectedAt",
      last_disconnected_at as "lastDisconnectedAt",
      last_health_at as "lastHealthAt", deleted_at as "deletedAt",
      metadata_json as "metadataJson", created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0]!;
}

export async function updateChannelInstanceStatus(
  db: ChannelsDb,
  input: {
    id: string;
    organizationId: string;
    status: ChannelInstanceStatus;
    connectionState?: string | null;
    metadata?: JsonRecord;
  },
): Promise<ChannelInstanceRecord> {
  const rows = await db.sql<ChannelInstanceRecord[]>`
    update channel_instances set
      status = ${input.status},
      connection_state = coalesce(${input.connectionState ?? null}, connection_state),
      metadata_json = metadata_json || ${db.sql.json((input.metadata ?? {}) as never)}::jsonb,
      last_connected_at = case when ${input.status} = 'connected' then now() else last_connected_at end,
      last_disconnected_at = case when ${input.status} = 'disconnected' then now() else last_disconnected_at end,
      deleted_at = case when ${input.status} = 'deleted' then now() else deleted_at end,
      last_health_at = now(),
      updated_at = now()
    where id = ${input.id}
      and organization_id = ${input.organizationId}
    returning
      id, organization_id as "organizationId", host_id as "hostId",
      channel, provider, external_instance_id as "externalInstanceId",
      external_instance_name as "externalInstanceName", display_name as "displayName",
      phone_e164 as "phoneE164", phone_display as "phoneDisplay",
      status, connection_state as "connectionState",
      created_by_user_id as "createdByUserId",
      last_connected_at as "lastConnectedAt",
      last_disconnected_at as "lastDisconnectedAt",
      last_health_at as "lastHealthAt", deleted_at as "deletedAt",
      metadata_json as "metadataJson", created_at as "createdAt", updated_at as "updatedAt"
  `;
  return rows[0]!;
}

export interface ChannelCredentialRecord {
  id: string;
  channelInstanceId: string;
  organizationId: string;
  credentialKind: "omni_instance_api_key";
  keyPrefix: string;
  ciphertext: string;
  nonce: string;
  aadHash: string;
  wrappedDek: string;
  dekKeyVersion: number;
  payloadKeyVersion: number;
  schemaVersion: number;
  status: "active" | "rotated" | "revoked" | "tampered";
  expiresAt: Date | null;
}

export async function findActiveChannelCredential(
  db: ChannelsDb,
  input: { channelInstanceId: string; organizationId: string },
): Promise<ChannelCredentialRecord | null> {
  const rows = await db.sql<ChannelCredentialRecord[]>`
    select
      id, channel_instance_id as "channelInstanceId",
      organization_id as "organizationId", credential_kind as "credentialKind",
      key_prefix as "keyPrefix", ciphertext, nonce, aad_hash as "aadHash",
      wrapped_dek as "wrappedDek", dek_key_version as "dekKeyVersion",
      payload_key_version as "payloadKeyVersion", schema_version as "schemaVersion",
      status, expires_at as "expiresAt"
    from channel_instance_credentials
    where channel_instance_id = ${input.channelInstanceId}
      and organization_id = ${input.organizationId}
      and credential_kind = 'omni_instance_api_key'
      and status = 'active'
    limit 1
  `;
  return rows[0] ?? null;
}

export async function insertChannelCredential(
  db: ChannelsDb,
  input: {
    channelInstanceId: string;
    organizationId: string;
    keyPrefix: string;
    ciphertext: string;
    nonce: string;
    aadHash: string;
    wrappedDek: string;
    dekKeyVersion: number;
    payloadKeyVersion: number;
    expiresAt?: Date | null;
  },
): Promise<void> {
  await db.sql`
    insert into channel_instance_credentials (
      channel_instance_id, organization_id, credential_kind, key_prefix,
      ciphertext, nonce, aad_hash, wrapped_dek,
      dek_key_version, payload_key_version, schema_version,
      expires_at
    ) values (
      ${input.channelInstanceId},
      ${input.organizationId},
      'omni_instance_api_key',
      ${input.keyPrefix},
      ${input.ciphertext},
      ${input.nonce},
      ${input.aadHash},
      ${input.wrappedDek},
      ${input.dekKeyVersion},
      ${input.payloadKeyVersion},
      1,
      ${input.expiresAt ?? null}
    )
  `;
}

export async function markActiveChannelCredentialsRotated(
  db: ChannelsDb,
  input: { channelInstanceId: string; organizationId: string },
): Promise<void> {
  await db.sql`
    update channel_instance_credentials set
      status = 'rotated',
      updated_at = now()
    where channel_instance_id = ${input.channelInstanceId}
      and organization_id = ${input.organizationId}
      and credential_kind = 'omni_instance_api_key'
      and status = 'active'
  `;
}

export async function rotateChannelCredential(
  db: ChannelsDb,
  input: {
    channelInstanceId: string;
    organizationId: string;
    keyPrefix: string;
    ciphertext: string;
    nonce: string;
    aadHash: string;
    wrappedDek: string;
    dekKeyVersion: number;
    payloadKeyVersion: number;
    expiresAt?: Date | null;
  },
): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx`
      update channel_instance_credentials set
        status = 'rotated',
        updated_at = now()
      where channel_instance_id = ${input.channelInstanceId}
        and organization_id = ${input.organizationId}
        and credential_kind = 'omni_instance_api_key'
        and status = 'active'
    `;
    await tx`
      insert into channel_instance_credentials (
        channel_instance_id, organization_id, credential_kind, key_prefix,
        ciphertext, nonce, aad_hash, wrapped_dek,
        dek_key_version, payload_key_version, schema_version,
        expires_at
      ) values (
        ${input.channelInstanceId},
        ${input.organizationId},
        'omni_instance_api_key',
        ${input.keyPrefix},
        ${input.ciphertext},
        ${input.nonce},
        ${input.aadHash},
        ${input.wrappedDek},
        ${input.dekKeyVersion},
        ${input.payloadKeyVersion},
        1,
        ${input.expiresAt ?? null}
      )
    `;
  });
}

export async function markChannelCredentialTampered(
  db: ChannelsDb,
  input: { id: string },
): Promise<void> {
  await db.sql`
    update channel_instance_credentials set
      status = 'tampered',
      updated_at = now()
    where id = ${input.id}
  `;
}

export async function insertChannelEvent(
  db: ChannelsDb,
  input: {
    organizationId: string | null;
    channelInstanceId?: string | null;
    hostId?: string | null;
    eventType: string;
    severity?: "info" | "warning" | "error";
    requestId: string;
    actorType?: "user" | "agent" | "api_key" | "system" | "anonymous" | null;
    actorId?: string | null;
    metadata?: JsonRecord;
  },
): Promise<void> {
  await db.sql`
    insert into channel_instance_events (
      organization_id, channel_instance_id, host_id, event_type, severity,
      request_id, actor_type, actor_id, safe_metadata_json
    ) values (
      ${input.organizationId},
      ${input.channelInstanceId ?? null},
      ${input.hostId ?? null},
      ${input.eventType},
      ${input.severity ?? "info"},
      ${input.requestId},
      ${input.actorType ?? null},
      ${input.actorId ?? null},
      ${db.sql.json((input.metadata ?? {}) as never)}
    )
  `;
}

export async function insertAuditEvent(
  db: ChannelsDb,
  input: {
    organizationId: string | null;
    actorType: "user" | "agent" | "api_key" | "system" | "anonymous";
    actorId: string | null;
    targetType: string;
    targetId: string | null;
    action: string;
    requestId: string;
    metadata?: JsonRecord;
  },
): Promise<void> {
  await db.sql`
    insert into audit_events (
      organization_id, actor_type, actor_id, target_type, target_id,
      action, request_id, metadata_json
    ) values (
      ${input.organizationId},
      ${input.actorType},
      ${input.actorId},
      ${input.targetType},
      ${input.targetId},
      ${input.action},
      ${input.requestId},
      ${db.sql.json((input.metadata ?? {}) as never)}
    )
  `;
}

export interface IdempotencyRecord {
  id: string;
  requestHash: string;
  status: "started" | "completed" | "failed";
  responseJson: JsonRecord | null;
}

export async function findIdempotencyRecord(
  db: ChannelsDb,
  input: { organizationId: string; idempotencyKey: string; operation: string },
): Promise<IdempotencyRecord | null> {
  const rows = await db.sql<IdempotencyRecord[]>`
    select id, request_hash as "requestHash", status, response_json as "responseJson"
    from channel_operation_idempotency
    where organization_id = ${input.organizationId}
      and idempotency_key = ${input.idempotencyKey}
      and operation = ${input.operation}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function startIdempotencyRecord(
  db: ChannelsDb,
  input: { organizationId: string; idempotencyKey: string; operation: string; requestHash: string },
): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    insert into channel_operation_idempotency (
      organization_id, idempotency_key, operation, request_hash, status,
      expires_at
    ) values (
      ${input.organizationId},
      ${input.idempotencyKey},
      ${input.operation},
      ${input.requestHash},
      'started',
      now() + interval '24 hours'
    )
    on conflict (organization_id, idempotency_key, operation) do nothing
    returning id
  `;
  return Boolean(rows[0]);
}

export async function completeIdempotencyRecord(
  db: ChannelsDb,
  input: {
    organizationId: string;
    idempotencyKey: string;
    operation: string;
    channelInstanceId?: string | null;
    response: JsonRecord;
  },
): Promise<void> {
  await db.sql`
    update channel_operation_idempotency set
      status = 'completed',
      channel_instance_id = ${input.channelInstanceId ?? null},
      response_json = ${db.sql.json(input.response as never)},
      updated_at = now()
    where organization_id = ${input.organizationId}
      and idempotency_key = ${input.idempotencyKey}
      and operation = ${input.operation}
  `;
}

export async function failIdempotencyRecord(
  db: ChannelsDb,
  input: { organizationId: string; idempotencyKey: string; operation: string },
): Promise<void> {
  await db.sql`
    update channel_operation_idempotency set
      status = 'failed',
      updated_at = now()
    where organization_id = ${input.organizationId}
      and idempotency_key = ${input.idempotencyKey}
      and operation = ${input.operation}
  `;
}
