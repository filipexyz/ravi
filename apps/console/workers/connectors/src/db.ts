/**
 * Postgres access for the `ravi-connectors` Worker.
 *
 * Uses postgres.js over a Hyperdrive connection string. Hyperdrive pools
 * TLS connections on the edge so cold isolates don't open fresh DB
 * connections every time.
 *
 * Direct TCP `connect()` to Postgres bypassing Hyperdrive is forbidden
 * per `console/connectors/SPEC.md`. This module is the only Postgres
 * surface in the Worker; query helpers MUST live here so audit and
 * timing are consistent.
 */

import postgres, { type Sql, type TransactionSql } from "postgres";

import type { HyperdriveBinding } from "./env";

export interface ConnectorsDb {
  sql: Sql;
  close(): Promise<void>;
  /** Set on the handle `withTransaction` passes in. */
  inTransaction?: boolean;
}

/**
 * Open a postgres.js client against the Hyperdrive binding. Caller is
 * responsible for `close()` (typically via `ctx.waitUntil(db.close())`
 * at the end of the request handler).
 */
export function openConnectorsDb(hyperdrive: HyperdriveBinding): ConnectorsDb {
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

/**
 * Run `fn` inside one transaction. The helpers in this module accept the
 * transaction handle like any other `ConnectorsDb`; called with a
 * transaction handle, `fn` runs in a savepoint of it.
 */
export async function withTransaction<T>(
  db: ConnectorsDb,
  fn: (tx: ConnectorsDb) => Promise<T>,
): Promise<T> {
  const scoped = (tx: unknown) => fn({ sql: tx as Sql, close: async () => {}, inTransaction: true });
  if (db.inTransaction) {
    return (await (db.sql as unknown as TransactionSql).savepoint(scoped)) as T;
  }
  return (await db.sql.begin(scoped)) as T;
}

/**
 * Serialize the decisions that depend on who else holds an account: the
 * provider revoke (which kills the account's grant for every connection)
 * and the connect upsert. Takes the person's lock, then the account's;
 * every caller takes them in that order. Transaction scoped.
 */
export async function lockConnectorAccount(
  db: ConnectorsDb,
  input: { provider: string; userId: string | null; sub: string | null },
): Promise<void> {
  if (input.userId) {
    await db.sql`
      select pg_advisory_xact_lock(hashtext('ravi-connectors:user'), hashtext(${`${input.provider}:${input.userId}`}))
    `;
  }
  if (input.sub) {
    await db.sql`
      select pg_advisory_xact_lock(hashtext('ravi-connectors:account'), hashtext(${`${input.provider}:${input.sub}`}))
    `;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

// --------------------------------------------------------------------------
// CLI session lookup
// --------------------------------------------------------------------------

export interface CliSessionRecord {
  id: string;
  userId: string;
  organizationId: string;
  membershipId: string;
  localInstallationId: string;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * The active CLI session `sessionId` of (organization, user) together with
 * its local installation, which must be active too. Used when the Console
 * forwards a CLI-originated connect start over HMAC.
 */
export async function findActiveCliSessionForUser(
  db: ConnectorsDb,
  input: { sessionId: string; organizationId: string; userId: string },
): Promise<{ id: string; localInstallationId: string } | null> {
  const rows = await db.sql<{ id: string; localInstallationId: string }[]>`
    select cs.id as "id", cs.local_installation_id as "localInstallationId"
    from cli_sessions cs
    join local_installations li
      on li.id = cs.local_installation_id
      and li.organization_id = cs.organization_id
      and li.status = 'active'
      and li.revoked_at is null
    where cs.id = ${input.sessionId}
      and cs.organization_id = ${input.organizationId}
      and cs.user_id = ${input.userId}
      and cs.status = 'active'
      and cs.revoked_at is null
      and cs.expires_at > now()
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findInstallationName(
  db: ConnectorsDb,
  input: { localInstallationId: string | null; cliSessionId: string | null },
): Promise<string | null> {
  if (!input.localInstallationId && !input.cliSessionId) return null;
  const rows = await db.sql<{ name: string }[]>`
    select li.name as "name"
    from local_installations li
    where li.id = coalesce(
      ${input.localInstallationId}::uuid,
      (select cs.local_installation_id from cli_sessions cs where cs.id = ${input.cliSessionId}::uuid)
    )
    limit 1
  `;
  return rows[0]?.name ?? null;
}

// --------------------------------------------------------------------------
// Organization membership + connector policy
// --------------------------------------------------------------------------

export async function isActiveOrganizationMember(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  const rows = await db.sql<{ ok: number }[]>`
    select 1 as "ok"
    from organization_memberships om
    join organizations o on o.id = om.organization_id and o.status = 'active'
    join users u on u.id = om.user_id and u.status = 'active'
    where om.organization_id = ${input.organizationId}
      and om.user_id = ${input.userId}
      and om.status = 'active'
    limit 1
  `;
  return rows.length > 0;
}

/**
 * The lock a member's removal takes in the Console
 * (`revokeRemovedMemberConnectorAccess`) before it suspends the member's
 * rows. A connect finish holding it either commits first, and the removal
 * then suspends what it stored, or waits for the removal and then reads
 * the membership gone. Advisory, so the Worker needs no write access to
 * memberships; the key must stay the same on both sides.
 */
export async function lockOrganizationMember(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string },
): Promise<void> {
  await db.sql`
    select pg_advisory_xact_lock(hashtext('ravi-connectors:member'), hashtext(${`${input.organizationId}:${input.userId}`}))
  `;
}

export interface ConnectorOrgPolicyRecord {
  organizationId: string;
  provider: string;
  enabled: boolean;
  writesAllowed: boolean;
  sharedAllowed: boolean;
  toolCeilingsJson: Record<string, string>;
}

/** The organization's policy for `provider`; no row means the defaults. */
export async function findOrgConnectorPolicy(
  db: ConnectorsDb,
  input: { organizationId: string; provider: string },
): Promise<ConnectorOrgPolicyRecord> {
  const rows = await db.sql<ConnectorOrgPolicyRecord[]>`
    select
      organization_id as "organizationId", provider, enabled,
      writes_allowed as "writesAllowed",
      shared_allowed as "sharedAllowed",
      tool_ceilings_json as "toolCeilingsJson"
    from connector_org_policies
    where organization_id = ${input.organizationId}
      and provider = ${input.provider}
    limit 1
  `;
  return (
    rows[0] ?? {
      organizationId: input.organizationId,
      provider: input.provider,
      enabled: true,
      writesAllowed: true,
      sharedAllowed: false,
      toolCeilingsJson: {},
    }
  );
}

/**
 * Change the organization's policy for `provider`. Fields left out keep
 * their value (the defaults when there is no row yet); `toolCeilings`
 * replaces the whole map.
 */
export async function upsertOrgConnectorPolicy(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    provider: string;
    enabled?: boolean;
    writesAllowed?: boolean;
    sharedAllowed?: boolean;
    toolCeilings?: Record<string, string>;
    updatedByUserId: string;
  },
): Promise<ConnectorOrgPolicyRecord> {
  const enabled = input.enabled ?? null;
  const writesAllowed = input.writesAllowed ?? null;
  const sharedAllowed = input.sharedAllowed ?? null;
  const toolCeilings = input.toolCeilings ? db.sql.json(input.toolCeilings as never) : null;
  const rows = await db.sql<ConnectorOrgPolicyRecord[]>`
    insert into connector_org_policies (
      organization_id, provider, enabled, writes_allowed, shared_allowed,
      tool_ceilings_json, updated_by_user_id
    ) values (
      ${input.organizationId},
      ${input.provider},
      coalesce(${enabled}::boolean, true),
      coalesce(${writesAllowed}::boolean, true),
      coalesce(${sharedAllowed}::boolean, false),
      coalesce(${toolCeilings}::jsonb, '{}'::jsonb),
      ${input.updatedByUserId}
    )
    on conflict (organization_id, provider) do update set
      enabled = coalesce(${enabled}::boolean, connector_org_policies.enabled),
      writes_allowed = coalesce(${writesAllowed}::boolean, connector_org_policies.writes_allowed),
      shared_allowed = coalesce(${sharedAllowed}::boolean, connector_org_policies.shared_allowed),
      tool_ceilings_json = coalesce(${toolCeilings}::jsonb, connector_org_policies.tool_ceilings_json),
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = now()
    returning
      organization_id as "organizationId", provider, enabled,
      writes_allowed as "writesAllowed",
      shared_allowed as "sharedAllowed",
      tool_ceilings_json as "toolCeilingsJson"
  `;
  return rows[0]!;
}

// --------------------------------------------------------------------------
// Provider connections
// --------------------------------------------------------------------------

/** A row that still holds, or may hold, credentials. */
export const LIVE_CONNECTION_STATUSES = ["active", "degraded", "suspended", "revoke_pending"] as const;
/** Live rows a new connect may update in place (a row being disconnected is never revived). */
export const RECONNECTABLE_CONNECTION_STATUSES = ["active", "degraded", "suspended"] as const;

export function isLiveConnectionStatus(status: string): boolean {
  return (LIVE_CONNECTION_STATUSES as readonly string[]).includes(status);
}

export function isReconnectableConnectionStatus(status: string): boolean {
  return (RECONNECTABLE_CONNECTION_STATUSES as readonly string[]).includes(status);
}

export interface ProviderConnectionRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  userId: string | null;
  provider: string;
  scopeKind: "user" | "organization" | "project";
  externalAccountId: string | null;
  externalAccountLogin: string | null;
  displayName: string;
  status: string;
  scopesJson: string[];
  capabilitiesJson: string[];
  metadataJson: Record<string, unknown>;
  requiresReauth: boolean;
  isDefault: boolean;
  managedByUserId: string | null;
  grantedByUserId: string | null;
  grantedAt: Date;
  lastReauthAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function connectionColumns(sql: Sql) {
  return sql`
    id, organization_id as "organizationId", project_id as "projectId",
    user_id as "userId", provider, scope_kind as "scopeKind",
    external_account_id as "externalAccountId",
    external_account_login as "externalAccountLogin",
    display_name as "displayName", status,
    scopes_json as "scopesJson",
    capabilities_json as "capabilitiesJson",
    metadata_json as "metadataJson",
    requires_reauth as "requiresReauth",
    is_default as "isDefault",
    managed_by_user_id as "managedByUserId",
    granted_by_user_id as "grantedByUserId",
    granted_at as "grantedAt",
    last_reauth_at as "lastReauthAt",
    last_used_at as "lastUsedAt",
    revoked_at as "revokedAt",
    created_at as "createdAt",
    updated_at as "updatedAt"
  `;
}

/** The Google `sub` of a row: `external_account_id`, else `metadata_json.googleSub`. */
export function connectionAccountSub(connection: ProviderConnectionRecord): string | null {
  if (connection.externalAccountId) return connection.externalAccountId;
  const sub = connection.metadataJson?.googleSub;
  return typeof sub === "string" && sub ? sub : null;
}

export async function findProviderConnectionById(
  db: ConnectorsDb,
  id: string,
  organizationId: string,
): Promise<ProviderConnectionRecord | null> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where id = ${id}
      and organization_id = ${organizationId}
    limit 1
  `;
  return rows[0] ?? null;
}

/** The row, locked until the transaction ends (its latest committed version). */
export async function lockProviderConnection(
  db: ConnectorsDb,
  id: string,
  organizationId: string,
): Promise<ProviderConnectionRecord | null> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where id = ${id}
      and organization_id = ${organizationId}
    limit 1
    for update
  `;
  return rows[0] ?? null;
}

/**
 * A person's own connections in one organization, newest default first.
 * GitHub installations (project scoped) never appear. Legacy rows the old
 * Worker still inserts as scope `project` are included until the
 * scheduled handler reclassifies them.
 */
export async function listUserConnections(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; provider?: string | null; includeHistory: boolean },
): Promise<ProviderConnectionRecord[]> {
  const provider = input.provider ?? null;
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and provider <> 'github'
      and scope_kind in ('user', 'project')
      and (${provider}::text is null or provider = ${provider})
      and (${input.includeHistory}::boolean or status in ('active', 'degraded', 'suspended', 'revoke_pending'))
    order by is_default desc, created_at desc
  `;
}

export interface InsertProviderConnectionInput {
  organizationId: string;
  projectId?: string | null;
  userId?: string | null;
  provider: string;
  scopeKind: "user" | "organization" | "project";
  externalAccountId: string | null;
  externalAccountLogin: string | null;
  displayName: string;
  scopes: string[];
  capabilities: string[];
  metadata?: Record<string, unknown>;
  grantedByUserId: string | null;
  managedByUserId?: string | null;
}

export async function insertProviderConnection(
  db: ConnectorsDb,
  input: InsertProviderConnectionInput,
): Promise<ProviderConnectionRecord> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    insert into provider_connections (
      organization_id, project_id, user_id, provider, scope_kind,
      external_account_id, external_account_login, display_name,
      scopes_json, capabilities_json, metadata_json, granted_by_user_id,
      managed_by_user_id, granted_at, last_verified_at
    ) values (
      ${input.organizationId},
      ${input.projectId ?? null},
      ${input.userId ?? null},
      ${input.provider},
      ${input.scopeKind},
      ${input.externalAccountId},
      ${input.externalAccountLogin},
      ${input.displayName},
      ${db.sql.json(input.scopes)},
      ${db.sql.json(input.capabilities)},
      ${db.sql.json((input.metadata ?? {}) as never)},
      ${input.grantedByUserId},
      ${input.managedByUserId ?? null},
      now(),
      now()
    )
    returning ${connectionColumns(db.sql)}
  `;
  return rows[0]!;
}

/**
 * Live rows of (organization, user, provider) that a new connect may
 * update in place because they hold the same account: the row that owns
 * `external_account_id = sub` first, then duplicates that only carry
 * `metadata_json.googleSub`, oldest first.
 */
export async function findReconnectableUserConnectionsForAccount(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; provider: string; sub: string },
): Promise<ProviderConnectionRecord[]> {
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and provider = ${input.provider}
      and scope_kind in ('user', 'project')
      and status in ('active', 'degraded', 'suspended')
      and (external_account_id = ${input.sub} or metadata_json->>'googleSub' = ${input.sub})
    order by (external_account_id is not distinct from ${input.sub}) desc, created_at asc
    for update
  `;
}

/**
 * Live rows of a person for `provider`, in any organization, whose account
 * is not known yet and that may still learn it from a stored id_token.
 */
export async function listUserConnectionsMissingAccount(
  db: ConnectorsDb,
  input: { provider: string; userId: string; excludeId: string | null; limit: number },
): Promise<ProviderConnectionRecord[]> {
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where provider = ${input.provider}
      and user_id = ${input.userId}
      and (${input.excludeId}::uuid is null or id <> ${input.excludeId}::uuid)
      and status in ('active', 'degraded', 'suspended', 'revoke_pending')
      and external_account_id is null
      and coalesce(metadata_json->>'googleSub', '') = ''
      and coalesce(metadata_json->>'identityBackfill', '') <> 'unavailable'
    order by created_at asc
    limit ${input.limit}
  `;
}

/** The live row of (organization, user, provider) holding `external_account_id = sub`, other than `excludeId`. */
export async function findLiveConnectionHoldingAccount(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; provider: string; sub: string; excludeId: string },
): Promise<{ id: string } | null> {
  const rows = await db.sql<{ id: string }[]>`
    select id
    from provider_connections
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and provider = ${input.provider}
      and scope_kind in ('user', 'project')
      and external_account_id = ${input.sub}
      and status not in ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')
      and id <> ${input.excludeId}
    order by created_at asc
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Record the account identity on a row. `externalAccountId` is written
 * only when given (the caller checked the per-person unique index);
 * `metadataPatch` is merged into `metadata_json`.
 */
export async function setConnectionIdentity(
  db: ConnectorsDb,
  input: {
    id: string;
    externalAccountId: string | null;
    email: string | null;
    metadataPatch: Record<string, unknown>;
  },
): Promise<void> {
  await db.sql`
    update provider_connections
    set external_account_id = coalesce(${input.externalAccountId}, external_account_id),
        external_account_login = coalesce(${input.email}, external_account_login),
        metadata_json = metadata_json || ${db.sql.json(input.metadataPatch as never)}::jsonb,
        updated_at = now()
    where id = ${input.id}
  `;
}

/**
 * Bring an existing row back after a successful connect of the same
 * account: active, fresh scopes, reauth cleared, the chosen access mode
 * recorded. A legacy `project` row is reclassified as a personal row on
 * the way (giving up a default another personal row already holds).
 * Only a reconnectable row is updated: a row being or already
 * disconnected is never brought back (`null`).
 */
export async function refreshConnectionAfterConnect(
  db: ConnectorsDb,
  input: {
    id: string;
    scopes: string[];
    email: string | null;
    displayName: string | null;
    accessMode: "full" | "read_only";
  },
): Promise<ProviderConnectionRecord | null> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    update provider_connections pc
    set status = 'active',
        requires_reauth = false,
        last_reauth_at = now(),
        last_verified_at = now(),
        revoked_at = null,
        scopes_json = ${db.sql.json(input.scopes)},
        external_account_login = coalesce(${input.email}, pc.external_account_login),
        display_name = coalesce(${input.displayName}, pc.display_name),
        metadata_json = (
          case
            when pc.scope_kind = 'project' and pc.project_id is not null
              then (pc.metadata_json - 'revokeAttempts' - 'identityBackfill')
                || jsonb_build_object('legacyProjectId', pc.project_id::text)
            else pc.metadata_json - 'revokeAttempts' - 'identityBackfill'
          end
        ) || jsonb_build_object('accessMode', ${input.accessMode}::text),
        is_default = case
          when pc.scope_kind = 'project' and pc.is_default and exists (
            select 1 from provider_connections o
            where o.id <> pc.id
              and o.organization_id = pc.organization_id
              and o.user_id = pc.user_id
              and o.provider = pc.provider
              and o.scope_kind = 'user'
              and o.is_default
          ) then false
          else pc.is_default
        end,
        scope_kind = case when pc.scope_kind = 'project' then 'user'::connector_scope_kind else pc.scope_kind end,
        project_id = case when pc.scope_kind = 'project' then null else pc.project_id end,
        updated_at = now()
    where pc.id = ${input.id}
      and pc.status in ('active', 'degraded', 'suspended')
    returning ${connectionColumns(db.sql)}
  `;
  return rows[0] ?? null;
}

/**
 * Live rows other than `excludeId`, in any organization and of any
 * person, that hold the same Google account. Google's revoke kills the
 * whole grant of that account for the Ravi OAuth client.
 */
export async function countOtherLiveConnectionsForAccount(
  db: ConnectorsDb,
  input: { provider: string; sub: string; excludeId: string },
): Promise<number> {
  const rows = await db.sql<{ count: number }[]>`
    select count(*)::int as "count"
    from provider_connections
    where provider = ${input.provider}
      and id <> ${input.excludeId}
      and status in ('active', 'degraded', 'suspended', 'revoke_pending')
      and (external_account_id = ${input.sub} or metadata_json->>'googleSub' = ${input.sub})
  `;
  return rows[0]?.count ?? 0;
}

/**
 * Live rows other than `excludeId` of the same person for `provider`, in
 * any organization, whose account is unknown, so they may hold `email`'s
 * account: no sub, and no email or the same email.
 */
export async function countOtherLiveConnectionsWithUnknownAccount(
  db: ConnectorsDb,
  input: { provider: string; userId: string; excludeId: string; email: string | null },
): Promise<number> {
  const rows = await db.sql<{ count: number }[]>`
    select count(*)::int as "count"
    from provider_connections
    where provider = ${input.provider}
      and user_id = ${input.userId}
      and id <> ${input.excludeId}
      and status in ('active', 'degraded', 'suspended', 'revoke_pending')
      and external_account_id is null
      and coalesce(metadata_json->>'googleSub', '') = ''
      and (
        ${input.email}::text is null
        or external_account_login is null
        or lower(external_account_login) = lower(${input.email}::text)
      )
  `;
  return rows[0]?.count ?? 0;
}

/** Live rows other than `excludeId` of the same person for `provider`, in any organization. */
export async function countOtherLiveConnectionsForUser(
  db: ConnectorsDb,
  input: { provider: string; userId: string; excludeId: string },
): Promise<number> {
  const rows = await db.sql<{ count: number }[]>`
    select count(*)::int as "count"
    from provider_connections
    where provider = ${input.provider}
      and user_id = ${input.userId}
      and id <> ${input.excludeId}
      and status in ('active', 'degraded', 'suspended', 'revoke_pending')
  `;
  return rows[0]?.count ?? 0;
}

export async function renameConnection(
  db: ConnectorsDb,
  input: { id: string; displayName: string },
): Promise<void> {
  await db.sql`
    update provider_connections
    set display_name = ${input.displayName}, updated_at = now()
    where id = ${input.id}
  `;
}

/**
 * Make `id` the default of (organization, user, provider). Clears the
 * previous default first so the partial unique index never sees two,
 * also on legacy `project` rows that become personal rows when
 * reclassified.
 */
export async function setDefaultConnection(
  db: ConnectorsDb,
  input: { id: string; organizationId: string; userId: string; provider: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.sql`
      update provider_connections
      set is_default = false, updated_at = now()
      where organization_id = ${input.organizationId}
        and user_id = ${input.userId}
        and provider = ${input.provider}
        and scope_kind in ('user', 'project')
        and is_default
        and id <> ${input.id}
    `;
    await tx.sql`
      update provider_connections
      set is_default = true, updated_at = now()
      where id = ${input.id}
    `;
  });
}

/**
 * Provider revoke failed: keep the credentials so a retry can revoke,
 * never use the row for exec again, count the attempt.
 */
export async function markConnectionRevokePending(
  db: ConnectorsDb,
  input: { id: string; origin: "user" | "operator" },
): Promise<number> {
  const rows = await withTransaction(db, async (tx) => {
    await lockConnectionRow(tx, input.id);
    const updated = await tx.sql<{ attempts: number }[]>`
      update provider_connections
      set status = 'revoke_pending',
          is_default = false,
          metadata_json = metadata_json || jsonb_build_object(
            'revokeAttempts', coalesce((metadata_json->>'revokeAttempts')::int, 0) + 1,
            'revokeOrigin', ${input.origin}::text
          ),
          updated_at = now()
      where id = ${input.id}
      returning (metadata_json->>'revokeAttempts')::int as "attempts"
    `;
    await revokeAgentGrantsForConnection(tx, input.id);
    return updated;
  });
  return rows[0]?.attempts ?? 1;
}

/**
 * Crypto-shred and close a row: credentials (and with them the wrapped
 * DEK) deleted, status set, default cleared, agent grants revoked. The
 * row is locked first, so a connect storing new credentials on it either
 * finishes before (and its credentials are shredded too) or finds it
 * closed.
 */
export async function markConnectionRevoked(
  db: ConnectorsDb,
  input: { id: string; status: "revoked_by_user" | "revoked_by_operator" | "revoked_by_provider" },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockConnectionRow(tx, input.id);
    await tx.sql`
      delete from connector_credentials
      where provider_connection_id = ${input.id}
    `;
    await tx.sql`
      update provider_connections
      set status = ${input.status},
          revoked_at = now(),
          is_default = false,
          updated_at = now()
      where id = ${input.id}
    `;
    await revokeAgentGrantsForConnection(tx, input.id);
  });
}

async function lockConnectionRow(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`select id from provider_connections where id = ${id} for update`;
}

async function revokeAgentGrantsForConnection(db: ConnectorsDb, connectionId: string): Promise<void> {
  await db.sql`
    update agent_connector_grants
    set status = 'revoked', revoked_at = now(), updated_at = now()
    where provider_connection_id = ${connectionId}
      and status = 'active'
  `;
}

export async function markConnectionRequiresReauth(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update provider_connections
    set requires_reauth = true, updated_at = now()
    where id = ${id}
  `;
}

// --------------------------------------------------------------------------
// Connector usage (read side; exec writes it)
// --------------------------------------------------------------------------

export interface ConnectorUsageRecord {
  providerConnectionId: string;
  localInstallationId: string | null;
  installationName: string | null;
  agentId: string;
  routineKey: string;
  mode: string;
  conversation: string;
  useCount: number;
  lastUsedAt: Date;
}

export async function listUsageForConnections(
  db: ConnectorsDb,
  connectionIds: string[],
): Promise<ConnectorUsageRecord[]> {
  if (connectionIds.length === 0) return [];
  return db.sql<ConnectorUsageRecord[]>`
    select
      cu.provider_connection_id as "providerConnectionId",
      cu.local_installation_id as "localInstallationId",
      li.name as "installationName",
      cu.agent_id as "agentId",
      cu.routine_key as "routineKey",
      cu.mode as "mode",
      cu.conversation as "conversation",
      cu.use_count as "useCount",
      cu.last_used_at as "lastUsedAt"
    from connector_usage cu
    left join local_installations li on li.id = cu.local_installation_id
    where cu.provider_connection_id in ${db.sql(connectionIds)}
    order by cu.last_used_at desc
  `;
}

/**
 * One more use of a connection by (installation, agent, routine, mode):
 * the count goes up, the capability and conversation are the latest.
 */
export async function recordConnectorUsage(
  db: ConnectorsDb,
  input: {
    providerConnectionId: string;
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    routineKey: string;
    mode: "owner" | "person_asking" | "shared";
    conversation: string;
    capability: string;
  },
): Promise<void> {
  await db.sql`
    insert into connector_usage (
      provider_connection_id, organization_id, local_installation_id,
      agent_id, routine_key, mode, conversation, last_capability,
      use_count, first_used_at, last_used_at
    ) values (
      ${input.providerConnectionId},
      ${input.organizationId},
      ${input.localInstallationId},
      ${input.agentId},
      ${input.routineKey},
      ${input.mode},
      ${input.conversation},
      ${input.capability},
      1, now(), now()
    )
    on conflict (provider_connection_id, local_installation_id, agent_id, routine_key, mode) do update set
      use_count = connector_usage.use_count + 1,
      last_capability = excluded.last_capability,
      conversation = excluded.conversation,
      last_used_at = now()
  `;
}

export async function touchConnectionLastUsed(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update provider_connections
    set last_used_at = now()
    where id = ${id}
  `;
}

// --------------------------------------------------------------------------
// Turn reads (write-after-read)
// --------------------------------------------------------------------------

/** How long a read in a runtime turn makes later writes of that turn need approval. */
export const TURN_READ_TTL_SECONDS = 6 * 60 * 60;

export async function hasRecentTurnRead(
  db: ConnectorsDb,
  input: { localInstallationId: string; turnKeyHash: string },
): Promise<boolean> {
  const rows = await db.sql<{ ok: number }[]>`
    select 1 as "ok"
    from connector_turn_reads
    where local_installation_id = ${input.localInstallationId}
      and turn_key_hash = ${input.turnKeyHash}
      and expires_at > now()
    limit 1
  `;
  return rows.length > 0;
}

export async function recordTurnRead(
  db: ConnectorsDb,
  input: { localInstallationId: string; organizationId: string; turnKeyHash: string },
): Promise<void> {
  await db.sql`
    insert into connector_turn_reads (local_installation_id, turn_key_hash, organization_id, read_at, expires_at)
    values (
      ${input.localInstallationId},
      ${input.turnKeyHash},
      ${input.organizationId},
      now(),
      now() + (${TURN_READ_TTL_SECONDS}::int * interval '1 second')
    )
    on conflict (local_installation_id, turn_key_hash) do update set
      read_at = now(),
      expires_at = excluded.expires_at
  `;
}

// --------------------------------------------------------------------------
// Tool policies (the owner's choice per capability)
// --------------------------------------------------------------------------

export type ToolPolicyValue = "always_allow" | "needs_approval" | "blocked";

export async function listConnectorToolPolicies(
  db: ConnectorsDb,
  providerConnectionId: string,
): Promise<{ capability: string; policy: ToolPolicyValue }[]> {
  return db.sql<{ capability: string; policy: ToolPolicyValue }[]>`
    select capability, policy::text as "policy"
    from connector_tool_policies
    where provider_connection_id = ${providerConnectionId}
  `;
}

export async function findConnectorToolPolicy(
  db: ConnectorsDb,
  input: { providerConnectionId: string; capability: string },
): Promise<ToolPolicyValue | null> {
  const rows = await db.sql<{ policy: ToolPolicyValue }[]>`
    select policy::text as "policy"
    from connector_tool_policies
    where provider_connection_id = ${input.providerConnectionId}
      and capability = ${input.capability}
    limit 1
  `;
  return rows[0]?.policy ?? null;
}

export async function upsertConnectorToolPolicy(
  db: ConnectorsDb,
  input: {
    providerConnectionId: string;
    organizationId: string;
    capability: string;
    policy: ToolPolicyValue;
    updatedByUserId: string;
  },
): Promise<void> {
  await db.sql`
    insert into connector_tool_policies (
      provider_connection_id, organization_id, capability, policy, updated_by_user_id
    ) values (
      ${input.providerConnectionId},
      ${input.organizationId},
      ${input.capability},
      ${input.policy}::connector_tool_policy,
      ${input.updatedByUserId}
    )
    on conflict (provider_connection_id, capability) do update set
      policy = excluded.policy,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = now()
  `;
}

// --------------------------------------------------------------------------
// Action approvals
// --------------------------------------------------------------------------

export type ActionApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface ActionApprovalRecord {
  id: string;
  organizationId: string;
  providerConnectionId: string;
  ownerUserId: string;
  requestedByUserId: string | null;
  localInstallationId: string | null;
  cliSessionId: string | null;
  capability: string;
  capabilityClass: string;
  paramsHash: string;
  previewEncrypted: string | null;
  reason: string;
  execContextJson: Record<string, unknown>;
  status: ActionApprovalStatus;
  expiresAt: Date;
  /** `expires_at` has passed by the database clock. */
  pastExpiry: boolean;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  consumedAt: Date | null;
  createdAt: Date;
  installationName: string | null;
  connectionEmail: string | null;
  connectionScopeKind: string | null;
  connectionManagedByUserId: string | null;
}

function approvalColumns(sql: Sql) {
  return sql`
    a.id, a.organization_id as "organizationId",
    a.provider_connection_id as "providerConnectionId",
    a.owner_user_id as "ownerUserId",
    a.requested_by_user_id as "requestedByUserId",
    a.local_installation_id as "localInstallationId",
    a.cli_session_id as "cliSessionId",
    a.capability, a.capability_class as "capabilityClass",
    a.params_hash as "paramsHash",
    a.preview_encrypted as "previewEncrypted",
    a.reason, a.exec_context_json as "execContextJson",
    a.status::text as "status",
    a.expires_at as "expiresAt",
    (a.expires_at <= now()) as "pastExpiry",
    a.decided_at as "decidedAt",
    a.decided_by_user_id as "decidedByUserId",
    a.consumed_at as "consumedAt",
    a.created_at as "createdAt",
    li.name as "installationName",
    pc.external_account_login as "connectionEmail",
    pc.scope_kind::text as "connectionScopeKind",
    pc.managed_by_user_id as "connectionManagedByUserId"
  `;
}

export interface InsertActionApprovalInput {
  id: string;
  organizationId: string;
  providerConnectionId: string;
  ownerUserId: string;
  requestedByUserId: string;
  localInstallationId: string | null;
  cliSessionId: string | null;
  capability: string;
  capabilityClass: string;
  paramsHash: string;
  previewEncrypted: string | null;
  reason: "policy" | "write_after_read";
  execContext: Record<string, unknown>;
  ttlSeconds: number;
}

export async function insertActionApproval(
  db: ConnectorsDb,
  input: InsertActionApprovalInput,
): Promise<{ id: string; expiresAt: Date }> {
  const rows = await db.sql<{ id: string; expiresAt: Date }[]>`
    insert into connector_action_approvals (
      id, organization_id, provider_connection_id, owner_user_id,
      requested_by_user_id, local_installation_id, cli_session_id,
      capability, capability_class, params_hash, preview_encrypted,
      reason, exec_context_json, status, expires_at
    ) values (
      ${input.id},
      ${input.organizationId},
      ${input.providerConnectionId},
      ${input.ownerUserId},
      ${input.requestedByUserId},
      ${input.localInstallationId},
      ${input.cliSessionId},
      ${input.capability},
      ${input.capabilityClass},
      ${input.paramsHash},
      ${input.previewEncrypted},
      ${input.reason},
      ${db.sql.json(input.execContext as never)},
      'pending',
      now() + (${input.ttlSeconds}::int * interval '1 second')
    )
    returning id, expires_at as "expiresAt"
  `;
  return rows[0]!;
}

/**
 * A still-pending request for exactly this action from the same requester
 * and installation, so a retry without the approval does not ask the
 * owner twice.
 */
export async function findReusablePendingApproval(
  db: ConnectorsDb,
  input: {
    providerConnectionId: string;
    capability: string;
    paramsHash: string;
    ownerUserId: string;
    requestedByUserId: string;
    localInstallationId: string | null;
    reason: string;
  },
): Promise<{ id: string; expiresAt: Date } | null> {
  const rows = await db.sql<{ id: string; expiresAt: Date }[]>`
    select id, expires_at as "expiresAt"
    from connector_action_approvals
    where provider_connection_id = ${input.providerConnectionId}
      and capability = ${input.capability}
      and params_hash = ${input.paramsHash}
      and owner_user_id = ${input.ownerUserId}
      and requested_by_user_id = ${input.requestedByUserId}
      and local_installation_id is not distinct from ${input.localInstallationId}::uuid
      and reason = ${input.reason}
      and status = 'pending'
      and expires_at > now() + interval '1 minute'
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findActionApproval(
  db: ConnectorsDb,
  id: string,
): Promise<ActionApprovalRecord | null> {
  const rows = await db.sql<ActionApprovalRecord[]>`
    select ${approvalColumns(db.sql)}
    from connector_action_approvals a
    left join local_installations li on li.id = a.local_installation_id
    left join provider_connections pc on pc.id = a.provider_connection_id
    where a.id = ${id}
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Use an approval for exactly the action it approved, once: only an
 * approved, unexpired approval of the same connection, capability,
 * parameters, owner and requester becomes `consumed`.
 */
export async function consumeActionApproval(
  db: ConnectorsDb,
  input: {
    id: string;
    providerConnectionId: string;
    capability: string;
    paramsHash: string;
    ownerUserId: string;
    requestedByUserId: string;
  },
): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    update connector_action_approvals
    set status = 'consumed', consumed_at = now(), updated_at = now()
    where id = ${input.id}
      and provider_connection_id = ${input.providerConnectionId}
      and capability = ${input.capability}
      and params_hash = ${input.paramsHash}
      and owner_user_id = ${input.ownerUserId}
      and requested_by_user_id = ${input.requestedByUserId}
      and status = 'approved'
      and expires_at > now()
    returning id
  `;
  return rows.length > 0;
}

/**
 * What waits for the owner: pending and unexpired, newest first. With
 * `includeUnmanaged` (an organization owner or admin) also the requests on
 * organization accounts nobody manages, which every owner and admin decides.
 */
export async function listPendingApprovalsForOwner(
  db: ConnectorsDb,
  input: { organizationId: string; ownerUserId: string; includeUnmanaged?: boolean; limit: number },
): Promise<ActionApprovalRecord[]> {
  const includeUnmanaged = input.includeUnmanaged === true;
  return db.sql<ActionApprovalRecord[]>`
    select ${approvalColumns(db.sql)}
    from connector_action_approvals a
    left join local_installations li on li.id = a.local_installation_id
    left join provider_connections pc on pc.id = a.provider_connection_id
    where a.organization_id = ${input.organizationId}
      and (
        a.owner_user_id = ${input.ownerUserId}
        or (
          ${includeUnmanaged}::boolean
          and pc.scope_kind = 'organization'
          and pc.managed_by_user_id is null
        )
      )
      and a.status = 'pending'
      and a.expires_at > now()
    order by a.created_at desc
    limit ${input.limit}
  `;
}

/**
 * The owner's decision on a pending, unexpired approval. Approving gives
 * the requester `approvedTtlSeconds` to run the action. Returns the new
 * status, or `null` when the approval was not pending (or expired).
 */
export async function decideActionApproval(
  db: ConnectorsDb,
  input: {
    id: string;
    organizationId: string;
    ownerUserId: string;
    /** Who decided: the owner, or an organization owner or admin for an account nobody manages. */
    decidedByUserId: string;
    decision: "approve" | "deny";
    approvedTtlSeconds: number;
  },
): Promise<ActionApprovalStatus | null> {
  const approved = input.decision === "approve";
  const rows = await db.sql<{ status: ActionApprovalStatus }[]>`
    update connector_action_approvals
    set status = ${approved ? "approved" : "denied"}::connector_approval_status,
        decided_at = now(),
        decided_by_user_id = ${input.decidedByUserId},
        expires_at = case
          when ${approved}::boolean then now() + (${input.approvedTtlSeconds}::int * interval '1 second')
          else expires_at
        end,
        updated_at = now()
    where id = ${input.id}
      and organization_id = ${input.organizationId}
      and owner_user_id = ${input.ownerUserId}
      and status = 'pending'
      and expires_at > now()
    returning status::text as "status"
  `;
  return rows[0]?.status ?? null;
}

// --------------------------------------------------------------------------
// Revocation outbox (member removed, installation revoked, org disabled)
// --------------------------------------------------------------------------

export interface RevocationOutboxRecord {
  id: string;
  organizationId: string;
  providerConnectionId: string;
  reason: string;
  attempts: number;
}

/**
 * Take up to `limit` due rows. Each one is leased (its next attempt moved
 * `leaseSeconds` ahead) so an overlapping run skips it; the outcome of
 * the attempt then sets the row's real state.
 */
export async function leaseDueRevocationOutbox(
  db: ConnectorsDb,
  input: { limit: number; leaseSeconds: number; scope?: MaintenanceScope },
): Promise<RevocationOutboxRecord[]> {
  const organizationId = input.scope?.organizationId ?? null;
  return db.sql<RevocationOutboxRecord[]>`
    update connector_revocation_outbox o
    set next_attempt_at = now() + (${input.leaseSeconds}::int * interval '1 second'),
        updated_at = now()
    where o.id in (
      select id
      from connector_revocation_outbox
      where status = 'pending'
        and next_attempt_at <= now()
        and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
      order by next_attempt_at asc
      limit ${input.limit}
      for update skip locked
    )
    returning o.id, o.organization_id as "organizationId",
      o.provider_connection_id as "providerConnectionId",
      o.reason, o.attempts
  `;
}

export async function completeRevocationOutbox(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update connector_revocation_outbox
    set status = 'done', updated_at = now()
    where id = ${id}
  `;
}

/**
 * A failed attempt: counted, its error code kept, the next attempt
 * `backoffSeconds` × attempts away. Returns the attempts so far.
 */
export async function recordRevocationOutboxFailure(
  db: ConnectorsDb,
  input: { id: string; errorCode: string; backoffSeconds: number },
): Promise<number> {
  const rows = await db.sql<{ attempts: number }[]>`
    update connector_revocation_outbox
    set attempts = attempts + 1,
        last_error_code = ${input.errorCode},
        next_attempt_at = now() + ((attempts + 1) * ${input.backoffSeconds}::int * interval '1 second'),
        updated_at = now()
    where id = ${input.id}
    returning attempts
  `;
  return rows[0]?.attempts ?? 0;
}

export async function failRevocationOutbox(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update connector_revocation_outbox
    set status = 'failed', updated_at = now()
    where id = ${id}
  `;
}

// --------------------------------------------------------------------------
// Organization admin views
// --------------------------------------------------------------------------

/** The role of an active member of an active organization, else `null`. */
export async function findActiveMemberRole(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string },
): Promise<string | null> {
  const rows = await db.sql<{ role: string }[]>`
    select om.role::text as "role"
    from organization_memberships om
    join organizations o on o.id = om.organization_id and o.status = 'active'
    join users u on u.id = om.user_id and u.status = 'active'
    where om.organization_id = ${input.organizationId}
      and om.user_id = ${input.userId}
      and om.status = 'active'
    limit 1
  `;
  return rows[0]?.role ?? null;
}

/** An active owner or admin of an active organization. */
export async function isActiveOrganizationAdmin(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  const role = await findActiveMemberRole(db, input);
  return role === "owner" || role === "admin";
}

export interface OrganizationConnectionRecord extends ProviderConnectionRecord {
  memberUserId: string | null;
  memberEmail: string | null;
  memberName: string | null;
}

/**
 * Every connection of the organization except GitHub installations, with
 * the member it belongs to (the manager for organization rows), newest
 * first. Never credentials.
 */
export async function listOrganizationConnections(
  db: ConnectorsDb,
  input: { organizationId: string; provider: string | null; limit: number },
): Promise<OrganizationConnectionRecord[]> {
  return db.sql<OrganizationConnectionRecord[]>`
    select c.*,
      u.id as "memberUserId",
      u.primary_email as "memberEmail",
      u.display_name as "memberName"
    from (
      select ${connectionColumns(db.sql)}
      from provider_connections
      where organization_id = ${input.organizationId}
        and provider <> 'github'
        and (${input.provider}::text is null or provider = ${input.provider})
      order by created_at desc
      limit ${input.limit}
    ) c
    left join users u on u.id = coalesce(c."userId", c."managedByUserId")
    order by c."createdAt" desc
  `;
}

/**
 * The member who decides for an organization account nobody manages: the
 * organization's first owner (by membership date), else its first admin.
 */
export async function findFirstOrganizationOwner(
  db: ConnectorsDb,
  organizationId: string,
): Promise<string | null> {
  const rows = await db.sql<{ userId: string }[]>`
    select om.user_id as "userId"
    from organization_memberships om
    join users u on u.id = om.user_id and u.status = 'active'
    where om.organization_id = ${organizationId}
      and om.status = 'active'
      and om.role in ('owner', 'admin')
    order by (om.role = 'owner') desc, om.created_at asc, om.user_id asc
    limit 1
  `;
  return rows[0]?.userId ?? null;
}

export async function findUserEmail(db: ConnectorsDb, userId: string): Promise<string | null> {
  const rows = await db.sql<{ email: string }[]>`
    select primary_email as "email" from users where id = ${userId} limit 1
  `;
  return rows[0]?.email ?? null;
}

export interface OrganizationAccountRecord extends ProviderConnectionRecord {
  managerEmail: string | null;
}

/**
 * The organization's own accounts (scope organization) with their
 * manager's email, newest first; with `managedByUserId`, only those that
 * member manages.
 */
export async function listOrganizationAccounts(
  db: ConnectorsDb,
  input: { organizationId: string; provider: string | null; includeHistory: boolean; managedByUserId?: string | null },
): Promise<OrganizationAccountRecord[]> {
  const managedBy = input.managedByUserId ?? null;
  return db.sql<OrganizationAccountRecord[]>`
    select c.*, u.primary_email as "managerEmail"
    from (
      select ${connectionColumns(db.sql)}
      from provider_connections
      where organization_id = ${input.organizationId}
        and scope_kind = 'organization'
        and provider <> 'github'
        and (${input.provider}::text is null or provider = ${input.provider})
        and (${input.includeHistory}::boolean or status in ('active', 'degraded', 'suspended', 'revoke_pending'))
        and (${managedBy}::uuid is null or managed_by_user_id = ${managedBy}::uuid)
    ) c
    left join users u on u.id = c."managedByUserId"
    order by c."createdAt" desc
  `;
}

/**
 * Live organization accounts of `organizationId` that a new connect of the
 * same account updates in place: the row holding `external_account_id =
 * sub` first, then duplicates carrying only `metadata_json.googleSub`.
 */
export async function findReconnectableOrgConnectionsForAccount(
  db: ConnectorsDb,
  input: { organizationId: string; provider: string; sub: string },
): Promise<ProviderConnectionRecord[]> {
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where organization_id = ${input.organizationId}
      and provider = ${input.provider}
      and scope_kind = 'organization'
      and status in ('active', 'degraded', 'suspended')
      and (external_account_id = ${input.sub} or metadata_json->>'googleSub' = ${input.sub})
    order by (external_account_id is not distinct from ${input.sub}) desc, created_at asc
    for update
  `;
}

/** The live organization account of `organizationId` holding `external_account_id = sub`, other than `excludeId`. */
export async function findLiveOrgConnectionHoldingAccount(
  db: ConnectorsDb,
  input: { organizationId: string; provider: string; sub: string; excludeId: string },
): Promise<{ id: string } | null> {
  const rows = await db.sql<{ id: string }[]>`
    select id
    from provider_connections
    where organization_id = ${input.organizationId}
      and provider = ${input.provider}
      and scope_kind = 'organization'
      and external_account_id = ${input.sub}
      and status not in ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')
      and id <> ${input.excludeId}
    order by created_at asc
    limit 1
  `;
  return rows[0] ?? null;
}

export interface OrgManagerChange {
  previousManagerUserId: string | null;
  managedByUserId: string;
  /** Requests that were waiting on someone else, now expired. */
  expiredApprovals: number;
  /** Shared grants of the account now given in the new manager's name. */
  movedGrants: number;
}

/**
 * "Change owner": the member who manages an organization account and
 * decides its approvals. Requests still waiting on anyone else are
 * expired (the new manager is asked on the retry), and the account's
 * shared grants are given in the new manager's name from now on: a shared
 * grant belongs to the account, so the previous manager leaving the
 * organization never takes the agents' access with them. Credentials
 * stay as they are: the vault binds organization rows to no user.
 * `null` when the row is no organization account of `organizationId`.
 */
export async function setOrgConnectionManager(
  db: ConnectorsDb,
  input: { id: string; organizationId: string; managedByUserId: string },
): Promise<OrgManagerChange | null> {
  return withTransaction(db, async (tx) => {
    const locked = await tx.sql<{ managedByUserId: string | null }[]>`
      select managed_by_user_id as "managedByUserId"
      from provider_connections
      where id = ${input.id}
        and organization_id = ${input.organizationId}
        and scope_kind = 'organization'
      for update
    `;
    if (!locked[0]) return null;
    await tx.sql`
      update provider_connections
      set managed_by_user_id = ${input.managedByUserId}, updated_at = now()
      where id = ${input.id}
    `;
    const expired = await tx.sql<{ id: string }[]>`
      update connector_action_approvals
      set status = 'expired', updated_at = now()
      where provider_connection_id = ${input.id}
        and status in ('pending', 'approved')
        and owner_user_id <> ${input.managedByUserId}
      returning id
    `;
    // One active shared grant per (installation, agent, provider): moving
    // the granter never meets another active grant of the same slot. The
    // guard keeps the partial unique index safe should one exist anyway.
    const moved = await tx.sql<{ id: string }[]>`
      update agent_connector_grants g
      set granted_by_user_id = ${input.managedByUserId}, updated_at = now()
      where g.provider_connection_id = ${input.id}
        and g.mode = 'shared'
        and g.status = 'active'
        and g.granted_by_user_id <> ${input.managedByUserId}
        and not exists (
          select 1 from agent_connector_grants o
          where o.id <> g.id
            and o.status = 'active'
            and o.mode = 'shared'
            and o.local_installation_id = g.local_installation_id
            and o.agent_id = g.agent_id
            and o.provider = g.provider
            and o.granted_by_user_id = ${input.managedByUserId}
        )
      returning g.id
    `;
    return {
      previousManagerUserId: locked[0].managedByUserId,
      managedByUserId: input.managedByUserId,
      expiredApprovals: expired.length,
      movedGrants: moved.length,
    };
  });
}

/** The default live row of a person for `provider`, else their newest active one. */
export async function findDefaultOrNewestUserConnection(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; provider: string },
): Promise<ProviderConnectionRecord | null> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and provider = ${input.provider}
      and scope_kind in ('user', 'project')
      and (
        (is_default and status in ('active', 'degraded', 'suspended', 'revoke_pending'))
        or status = 'active'
      )
    order by (is_default and status in ('active', 'degraded', 'suspended', 'revoke_pending')) desc, created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

/** A person's connections an agent may be pointed at (connected, not being disconnected). */
export async function listUserSelectableConnections(
  db: ConnectorsDb,
  input: { organizationId: string; userId: string; provider: string },
): Promise<ProviderConnectionRecord[]> {
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and provider = ${input.provider}
      and scope_kind in ('user', 'project')
      and status in ('active', 'degraded', 'suspended')
    order by is_default desc, created_at desc
  `;
}

export async function findActiveInstallation(
  db: ConnectorsDb,
  input: { id: string; organizationId: string },
): Promise<{ id: string; userId: string; name: string } | null> {
  const rows = await db.sql<{ id: string; userId: string; name: string }[]>`
    select id, user_id as "userId", name
    from local_installations
    where id = ${input.id}
      and organization_id = ${input.organizationId}
      and status = 'active'
      and revoked_at is null
    limit 1
  `;
  return rows[0] ?? null;
}

// --------------------------------------------------------------------------
// Actor bindings (`ravi link`: a contact of an installation is a Console user)
// --------------------------------------------------------------------------

/** The active binding of a contact on one installation: who that contact is in the Console. */
export async function findActiveActorBinding(
  db: ConnectorsDb,
  input: { installationId: string; organizationId: string; contactId: string },
): Promise<{ id: string; consoleUserId: string } | null> {
  const rows = await db.sql<{ id: string; consoleUserId: string }[]>`
    select id, console_user_id as "consoleUserId"
    from ravi_actor_bindings
    where installation_id = ${input.installationId}
      and organization_id = ${input.organizationId}
      and contact_id = ${input.contactId}
      and status = 'active'
      and revoked_at is null
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

// --------------------------------------------------------------------------
// Agent grants (phase 3: the person asking; phase 4: shared accounts)
// --------------------------------------------------------------------------

export type AgentGrantMode = "person_asking" | "shared";

export interface AgentGrantRecord {
  id: string;
  organizationId: string;
  localInstallationId: string;
  agentId: string;
  provider: string;
  mode: AgentGrantMode;
  providerConnectionId: string | null;
  grantedByUserId: string;
  conversationsJson: string[];
  status: "active" | "revoked";
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentGrantViewRecord extends AgentGrantRecord {
  installationName: string | null;
  operatorUserId: string | null;
  operatorEmail: string | null;
  connectionEmail: string | null;
}

function agentGrantColumns(sql: Sql) {
  return sql`
    g.id, g.organization_id as "organizationId",
    g.local_installation_id as "localInstallationId",
    g.agent_id as "agentId", g.provider, g.mode::text as "mode",
    g.provider_connection_id as "providerConnectionId",
    g.granted_by_user_id as "grantedByUserId",
    g.conversations_json as "conversationsJson",
    g.status::text as "status",
    g.revoked_at as "revokedAt",
    g.created_at as "createdAt",
    g.updated_at as "updatedAt"
  `;
}

/**
 * The active grant of one agent on one installation for `provider` in
 * `mode`; for `person_asking`, the one the person `grantedByUserId` gave.
 */
export async function findActiveAgentGrant(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    provider: string;
    mode: AgentGrantMode;
    grantedByUserId?: string | null;
  },
): Promise<AgentGrantRecord | null> {
  const grantedBy = input.grantedByUserId ?? null;
  const rows = await db.sql<AgentGrantRecord[]>`
    select ${agentGrantColumns(db.sql)}
    from agent_connector_grants g
    where g.organization_id = ${input.organizationId}
      and g.local_installation_id = ${input.localInstallationId}
      and g.agent_id = ${input.agentId}
      and g.provider = ${input.provider}
      and g.mode = ${input.mode}::connector_agent_grant_mode
      and g.status = 'active'
      and (${grantedBy}::uuid is null or g.granted_by_user_id = ${grantedBy}::uuid)
    order by g.updated_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findAgentGrantById(
  db: ConnectorsDb,
  input: { id: string; organizationId: string },
): Promise<AgentGrantRecord | null> {
  const rows = await db.sql<AgentGrantRecord[]>`
    select ${agentGrantColumns(db.sql)}
    from agent_connector_grants g
    where g.id = ${input.id}
      and g.organization_id = ${input.organizationId}
    limit 1
  `;
  return rows[0] ?? null;
}

/** Serialize the grants of one agent slot: (installation, agent, provider, mode). Transaction scoped. */
async function lockAgentGrantSlot(
  db: ConnectorsDb,
  input: { localInstallationId: string; agentId: string; provider: string; mode: AgentGrantMode },
): Promise<void> {
  await db.sql`
    select pg_advisory_xact_lock(
      hashtext('ravi-connectors:agent-grant'),
      hashtext(${`${input.localInstallationId}:${input.agentId}:${input.provider}:${input.mode}`})
    )
  `;
}

/**
 * The connection a grant is about to point at, locked FOR SHARE until the
 * transaction ends: a concurrent disconnect (which locks the row FOR
 * UPDATE before revoking the row's grants) either finished first, and the
 * row read here is closed, or waits for this grant and revokes it too.
 */
async function lockConnectionForGrant(
  db: ConnectorsDb,
  input: { id: string; organizationId: string },
): Promise<ProviderConnectionRecord | null> {
  const rows = await db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where id = ${input.id}
      and organization_id = ${input.organizationId}
    limit 1
    for share
  `;
  return rows[0] ?? null;
}

export type PersonAskingGrantResult =
  | { kind: "granted"; id: string; created: boolean }
  /** The account chosen is no longer one of the person's connected accounts. */
  | { kind: "connection_unavailable" };

/**
 * The person `grantedByUserId` lets one agent on one installation use
 * their `provider` account when they ask: the account chosen (one of
 * their own connected ones, checked on the locked row), or none for
 * "my default". Updates the active grant they already gave.
 */
export async function upsertPersonAskingGrant(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    provider: string;
    providerConnectionId: string | null;
    grantedByUserId: string;
  },
): Promise<PersonAskingGrantResult> {
  return withTransaction(db, async (tx) => {
    await lockAgentGrantSlot(tx, { ...input, mode: "person_asking" });
    if (input.providerConnectionId) {
      const connection = await lockConnectionForGrant(tx, {
        id: input.providerConnectionId,
        organizationId: input.organizationId,
      });
      if (
        !connection ||
        connection.userId !== input.grantedByUserId ||
        connection.provider !== input.provider ||
        (connection.scopeKind !== "user" && connection.scopeKind !== "project") ||
        !isReconnectableConnectionStatus(connection.status)
      ) {
        return { kind: "connection_unavailable" } as const;
      }
    }
    const rows = await tx.sql<{ id: string; created: boolean }[]>`
      insert into agent_connector_grants (
        organization_id, local_installation_id, agent_id, provider, mode,
        provider_connection_id, granted_by_user_id, conversations_json, status
      ) values (
        ${input.organizationId},
        ${input.localInstallationId},
        ${input.agentId},
        ${input.provider},
        'person_asking',
        ${input.providerConnectionId},
        ${input.grantedByUserId},
        ${tx.sql.json(["dm"])},
        'active'
      )
      on conflict (local_installation_id, agent_id, provider, granted_by_user_id, mode) where status = 'active'
      do update set
        provider_connection_id = excluded.provider_connection_id,
        conversations_json = excluded.conversations_json,
        updated_at = now()
      returning id, (xmax = 0) as "created"
    `;
    return { kind: "granted", ...rows[0]! } as const;
  });
}

export type SharedGrantResult =
  | {
      kind: "granted";
      id: string;
      created: boolean;
      /** The account's manager, or the acting owner or admin when nobody manages it. */
      grantedByUserId: string;
      /** The agent's grants on other organization accounts, revoked by this one. */
      replaced: AgentGrantRecord[];
    }
  /** Not a connected organization account of the organization (any more). */
  | { kind: "connection_unavailable" }
  /** The actor neither manages the account (any more) nor is an owner or admin. */
  | { kind: "forbidden" }
  /** The agent uses another organization account the actor may not take it from. */
  | { kind: "agent_uses_other_account" };

/**
 * Let one agent on one installation use an organization account in the
 * conversations named. An agent uses one organization account per
 * provider: a grant on another account is replaced, but only when the
 * actor may revoke that one too (an owner or admin, or its manager);
 * otherwise nothing changes. The grant on the same account is updated in
 * place. Whether the actor may share the account, and in whose name, is
 * decided on the locked row: the grant is always given in the manager's
 * name (the acting owner or admin when nobody manages it).
 */
export async function upsertSharedAgentGrant(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    provider: string;
    providerConnectionId: string;
    conversations: string[];
    actorUserId: string;
    /** An active owner or admin of the organization. */
    actorIsAdmin: boolean;
  },
): Promise<SharedGrantResult> {
  return withTransaction(db, async (tx) => {
    await lockAgentGrantSlot(tx, { ...input, mode: "shared" });
    const connection = await lockConnectionForGrant(tx, {
      id: input.providerConnectionId,
      organizationId: input.organizationId,
    });
    if (
      !connection ||
      connection.scopeKind !== "organization" ||
      connection.provider !== input.provider ||
      connection.status !== "active"
    ) {
      return { kind: "connection_unavailable" } as const;
    }
    if (!input.actorIsAdmin && connection.managedByUserId !== input.actorUserId) {
      return { kind: "forbidden" } as const;
    }
    const grantedByUserId = connection.managedByUserId ?? input.actorUserId;

    const slot = await tx.sql<(AgentGrantRecord & { connectionManagedByUserId: string | null })[]>`
      select ${agentGrantColumns(tx.sql)}, pc.managed_by_user_id as "connectionManagedByUserId"
      from agent_connector_grants g
      left join provider_connections pc on pc.id = g.provider_connection_id
      where g.local_installation_id = ${input.localInstallationId}
        and g.agent_id = ${input.agentId}
        and g.provider = ${input.provider}
        and g.mode = 'shared'
        and g.status = 'active'
      order by g.updated_at desc
      for update of g
    `;
    const others = slot.filter((grant) => grant.providerConnectionId !== connection.id);
    const mayReplace = (grant: (typeof slot)[number]) =>
      input.actorIsAdmin || !grant.providerConnectionId || grant.connectionManagedByUserId === input.actorUserId;
    if (!others.every(mayReplace)) return { kind: "agent_uses_other_account" } as const;
    const [current, ...duplicates] = slot.filter((grant) => grant.providerConnectionId === connection.id);
    const toRevoke = [...others, ...duplicates];
    if (toRevoke.length > 0) {
      await tx.sql`
        update agent_connector_grants
        set status = 'revoked', revoked_at = now(), updated_at = now()
        where id in ${tx.sql(toRevoke.map((grant) => grant.id))}
      `;
    }
    const replaced: AgentGrantRecord[] = others;

    if (current) {
      await tx.sql`
        update agent_connector_grants
        set granted_by_user_id = ${grantedByUserId},
            conversations_json = ${tx.sql.json(input.conversations)},
            updated_at = now()
        where id = ${current.id}
      `;
      return { kind: "granted", id: current.id, created: false, grantedByUserId, replaced } as const;
    }
    const rows = await tx.sql<{ id: string }[]>`
      insert into agent_connector_grants (
        organization_id, local_installation_id, agent_id, provider, mode,
        provider_connection_id, granted_by_user_id, conversations_json, status
      ) values (
        ${input.organizationId},
        ${input.localInstallationId},
        ${input.agentId},
        ${input.provider},
        'shared',
        ${connection.id},
        ${grantedByUserId},
        ${tx.sql.json(input.conversations)},
        'active'
      )
      returning id
    `;
    return { kind: "granted", id: rows[0]!.id, created: true, grantedByUserId, replaced } as const;
  });
}

/** Revoke an active grant. Returns whether it was active. */
export async function revokeAgentGrant(db: ConnectorsDb, id: string): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    update agent_connector_grants
    set status = 'revoked', revoked_at = now(), updated_at = now()
    where id = ${id}
      and status = 'active'
    returning id
  `;
  return rows.length > 0;
}

/**
 * Active grants with what the Console shows of them: the installation and
 * its operator (the member signed in there), and the connection's email.
 * Filters combine with AND; `connectionIds` matches grants pointing at any
 * of them, and with `includeUnpinnedOf` also grants of that person that
 * point at no connection (they use the person's default).
 */
export async function listAgentGrants(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    mode?: AgentGrantMode | null;
    grantedByUserId?: string | null;
    connectionIds?: string[] | null;
    includeUnpinnedOf?: { userId: string; provider: string } | null;
    managedByUserId?: string | null;
    limit: number;
  },
): Promise<AgentGrantViewRecord[]> {
  const mode = input.mode ?? null;
  const grantedBy = input.grantedByUserId ?? null;
  const connectionIds = input.connectionIds ?? null;
  const unpinnedUser = input.includeUnpinnedOf?.userId ?? null;
  const unpinnedProvider = input.includeUnpinnedOf?.provider ?? null;
  const managedBy = input.managedByUserId ?? null;
  const connectionFilter = connectionIds
    ? connectionIds.length > 0
      ? db.sql`and (
          g.provider_connection_id in ${db.sql(connectionIds)}
          or (
            ${unpinnedUser}::uuid is not null
            and g.provider_connection_id is null
            and g.granted_by_user_id = ${unpinnedUser}::uuid
            and g.provider = ${unpinnedProvider}::text
          )
        )`
      : db.sql`and false`
    : db.sql``;
  return db.sql<AgentGrantViewRecord[]>`
    select ${agentGrantColumns(db.sql)},
      li.name as "installationName",
      li.user_id as "operatorUserId",
      ou.primary_email as "operatorEmail",
      pc.external_account_login as "connectionEmail"
    from agent_connector_grants g
    left join local_installations li on li.id = g.local_installation_id
    left join users ou on ou.id = li.user_id
    left join provider_connections pc on pc.id = g.provider_connection_id
    where g.organization_id = ${input.organizationId}
      and g.status = 'active'
      and (${mode}::text is null or g.mode::text = ${mode}::text)
      and (${grantedBy}::uuid is null or g.granted_by_user_id = ${grantedBy}::uuid)
      and (${managedBy}::uuid is null or pc.managed_by_user_id = ${managedBy}::uuid)
      ${connectionFilter}
    order by g.created_at desc
    limit ${input.limit}
  `;
}

// --------------------------------------------------------------------------
// Consent requests (phase 3: an agent asks a person once)
// --------------------------------------------------------------------------

export type ConsentRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface ConsentRequestRecord {
  id: string;
  organizationId: string;
  localInstallationId: string;
  agentId: string;
  agentDisplayName: string | null;
  provider: string;
  contactId: string;
  bindingId: string;
  consoleUserId: string;
  requestedByUserId: string | null;
  status: ConsentRequestStatus;
  expiresAt: Date;
  /** `expires_at` has passed by the database clock. */
  pastExpiry: boolean;
  decidedAt: Date | null;
  grantId: string | null;
  createdAt: Date;
  installationName: string | null;
  installationActive: boolean;
  operatorName: string | null;
  operatorEmail: string | null;
}

function consentRequestColumns(sql: Sql) {
  return sql`
    r.id, r.organization_id as "organizationId",
    r.local_installation_id as "localInstallationId",
    r.agent_id as "agentId",
    r.agent_display_name as "agentDisplayName",
    r.provider, r.contact_id as "contactId",
    r.binding_id as "bindingId",
    r.console_user_id as "consoleUserId",
    r.requested_by_user_id as "requestedByUserId",
    r.status::text as "status",
    r.expires_at as "expiresAt",
    (r.expires_at <= now()) as "pastExpiry",
    r.decided_at as "decidedAt",
    r.grant_id as "grantId",
    r.created_at as "createdAt",
    li.name as "installationName",
    coalesce(li.status = 'active' and li.revoked_at is null, false) as "installationActive",
    ou.display_name as "operatorName",
    ou.primary_email as "operatorEmail"
  `;
}

/**
 * Ask the person once: the pending request of (installation, agent,
 * provider, person), created or, when one is pending already, given the
 * new token hash (the old link stops working: only hashes are stored, so
 * the old token can never be handed out again) and a fresh expiry.
 */
export async function upsertPendingConsentRequest(
  db: ConnectorsDb,
  input: {
    tokenHash: string;
    organizationId: string;
    localInstallationId: string;
    agentId: string;
    agentDisplayName: string | null;
    provider: string;
    contactId: string;
    bindingId: string;
    consoleUserId: string;
    requestedByUserId: string;
    ttlSeconds: number;
  },
): Promise<{ id: string; expiresAt: Date; created: boolean }> {
  const rows = await db.sql<{ id: string; expiresAt: Date; created: boolean }[]>`
    insert into connector_consent_requests (
      token_hash, organization_id, local_installation_id, agent_id,
      agent_display_name, provider, contact_id, binding_id, console_user_id,
      requested_by_user_id, status, expires_at
    ) values (
      ${input.tokenHash},
      ${input.organizationId},
      ${input.localInstallationId},
      ${input.agentId},
      ${input.agentDisplayName},
      ${input.provider},
      ${input.contactId},
      ${input.bindingId},
      ${input.consoleUserId},
      ${input.requestedByUserId},
      'pending',
      now() + (${input.ttlSeconds}::int * interval '1 second')
    )
    on conflict (local_installation_id, agent_id, provider, console_user_id) where status = 'pending'
    do update set
      token_hash = excluded.token_hash,
      agent_display_name = coalesce(excluded.agent_display_name, connector_consent_requests.agent_display_name),
      contact_id = excluded.contact_id,
      binding_id = excluded.binding_id,
      requested_by_user_id = excluded.requested_by_user_id,
      expires_at = excluded.expires_at,
      updated_at = now()
    returning id, expires_at as "expiresAt", (xmax = 0) as "created"
  `;
  return rows[0]!;
}

export async function findConsentRequestByTokenHash(
  db: ConnectorsDb,
  tokenHash: string,
): Promise<ConsentRequestRecord | null> {
  const rows = await db.sql<ConsentRequestRecord[]>`
    select ${consentRequestColumns(db.sql)}
    from connector_consent_requests r
    left join local_installations li on li.id = r.local_installation_id
    left join users ou on ou.id = coalesce(r.requested_by_user_id, li.user_id)
    where r.token_hash = ${tokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

/** The request, locked until the transaction ends. */
export async function lockConsentRequest(db: ConnectorsDb, id: string): Promise<ConsentRequestRecord | null> {
  const rows = await db.sql<ConsentRequestRecord[]>`
    select ${consentRequestColumns(db.sql)}
    from connector_consent_requests r
    left join local_installations li on li.id = r.local_installation_id
    left join users ou on ou.id = coalesce(r.requested_by_user_id, li.user_id)
    where r.id = ${id}
    for update of r
  `;
  return rows[0] ?? null;
}

export async function settleConsentRequest(
  db: ConnectorsDb,
  input: { id: string; status: "approved" | "denied" | "expired"; grantId: string | null },
): Promise<void> {
  await db.sql`
    update connector_consent_requests
    set status = ${input.status}::connector_consent_request_status,
        decided_at = case when ${input.status} = 'expired' then decided_at else now() end,
        grant_id = coalesce(${input.grantId}::uuid, grant_id),
        updated_at = now()
    where id = ${input.id}
      and status = 'pending'
  `;
}

// --------------------------------------------------------------------------
// Activity (audit read side)
// --------------------------------------------------------------------------

/**
 * What a connection's Recent activity shows: actions run, refused and
 * failed; approvals asked, approved and denied (the run after an approval
 * is its `executed` row, which carries the approval id); tool rules the
 * owner set; and a refresh token Google refused.
 */
export const CONNECTION_ACTIVITY_ACTIONS = [
  "connector.action.executed",
  "connector.action.denied",
  "connector.action.failed",
  "connector.approval.created",
  "connector.approval.approved",
  "connector.approval.denied",
  "connector.tool_policy.set",
  "connector.reauth_required",
] as const;

export interface ConnectionActivityRecord {
  action: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * The newest activity of a connection, as its owner did it (or the system
 * did it for them, or an agent did it for them as the person asking,
 * marked `actingForUserId`): never anything else someone wrote.
 */
export async function listConnectionActivity(
  db: ConnectorsDb,
  input: {
    organizationId: string;
    providerConnectionId: string;
    /** `null`: an organization account, whose activity its manager and admins see whoever did it. */
    ownerUserId: string | null;
    limit: number;
  },
): Promise<ConnectionActivityRecord[]> {
  return db.sql<ConnectionActivityRecord[]>`
    select action, metadata_json as "metadata", created_at as "createdAt"
    from audit_events
    where organization_id = ${input.organizationId}
      and target_type = 'provider_connection'
      and target_id = ${input.providerConnectionId}
      and (
        ${input.ownerUserId}::text is null
        or actor_id = ${input.ownerUserId}::text
        or metadata_json->>'actingForUserId' = ${input.ownerUserId}::text
      )
      and action in ${db.sql([...CONNECTION_ACTIVITY_ACTIONS])}
    order by created_at desc
    limit ${input.limit}
  `;
}

// --------------------------------------------------------------------------
// Connector credentials (encrypted vault)
// --------------------------------------------------------------------------

export interface ConnectorCredentialRecord {
  id: string;
  providerConnectionId: string;
  organizationId: string;
  userId: string | null;
  payloadKind: "access_token" | "refresh_token" | "id_token";
  ciphertext: string;
  nonce: string;
  aadHash: string;
  wrappedDek: string;
  dekKeyVersion: number;
  payloadKeyVersion: number;
  schemaVersion: number;
  expiresAt: Date | null;
  refreshSupported: boolean;
}

export async function findCredentialsByConnection(
  db: ConnectorsDb,
  providerConnectionId: string,
): Promise<ConnectorCredentialRecord[]> {
  return db.sql<ConnectorCredentialRecord[]>`
    select
      id, provider_connection_id as "providerConnectionId",
      organization_id as "organizationId", user_id as "userId",
      payload_kind as "payloadKind", ciphertext, nonce,
      aad_hash as "aadHash", wrapped_dek as "wrappedDek",
      dek_key_version as "dekKeyVersion",
      payload_key_version as "payloadKeyVersion",
      schema_version as "schemaVersion",
      expires_at as "expiresAt",
      refresh_supported as "refreshSupported"
    from connector_credentials
    where provider_connection_id = ${providerConnectionId}
  `;
}

export interface UpsertCredentialInput {
  providerConnectionId: string;
  organizationId: string;
  userId: string | null;
  payloadKind: "access_token" | "refresh_token" | "id_token";
  ciphertext: string;
  nonce: string;
  aadHash: string;
  wrappedDek: string;
  dekKeyVersion: number;
  /** The payload key version bound into the AAD of `ciphertext`. Stored as given. */
  payloadKeyVersion: number;
  expiresAt: Date | null;
  refreshSupported: boolean;
}

/**
 * Insert or update an encrypted credential row for a given connection +
 * payload kind. The unique key on (provider_connection_id, payload_kind)
 * makes this idempotent across OAuth refresh cycles. Every column is
 * stored exactly as encrypted, so the AAD rebuilt from the row on
 * decrypt matches the one used to encrypt.
 */
export async function upsertCredential(
  db: ConnectorsDb,
  input: UpsertCredentialInput,
): Promise<void> {
  await db.sql`
    insert into connector_credentials (
      provider_connection_id, organization_id, user_id, payload_kind,
      ciphertext, nonce, aad_hash, wrapped_dek,
      dek_key_version, payload_key_version, schema_version,
      expires_at, refresh_supported
    ) values (
      ${input.providerConnectionId},
      ${input.organizationId},
      ${input.userId},
      ${input.payloadKind},
      ${input.ciphertext},
      ${input.nonce},
      ${input.aadHash},
      ${input.wrappedDek},
      ${input.dekKeyVersion},
      ${input.payloadKeyVersion},
      1,
      ${input.expiresAt},
      ${input.refreshSupported}
    )
    on conflict (provider_connection_id, payload_kind) do update set
      organization_id = excluded.organization_id,
      user_id = excluded.user_id,
      ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      aad_hash = excluded.aad_hash,
      wrapped_dek = excluded.wrapped_dek,
      dek_key_version = excluded.dek_key_version,
      payload_key_version = excluded.payload_key_version,
      schema_version = excluded.schema_version,
      expires_at = excluded.expires_at,
      refresh_supported = excluded.refresh_supported,
      updated_at = now()
  `;
}

// --------------------------------------------------------------------------
// Pending grants (identity-bound connect flow)
// --------------------------------------------------------------------------

export type PendingGrantStatus = "pending" | "consumed" | "expired" | "rejected";

/**
 * A finish stores its connection within seconds of claiming the grant.
 * A claimed grant still without a connection after this long belongs to
 * a finish that died between the claim and the store.
 */
export const STALE_CLAIM_SECONDS = 120;

export interface ConnectorGrantPendingRecord {
  id: string;
  organizationId: string;
  userId: string;
  projectId: string | null;
  provider: string;
  stateTokenHash: string;
  pkceVerifierEncrypted: string | null;
  requestedScopesJson: string[];
  requestedDisplayName: string | null;
  origin: "cli" | "ui";
  cliSessionId: string | null;
  status: PendingGrantStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  rejectedReason: string | null;
  resultingConnectionId: string | null;
  metadataJson: Record<string, unknown>;
  connectTokenHash: string | null;
  continuedAt: Date | null;
  authorizedAt: Date | null;
  hasCode: boolean;
  resultTokenHash: string | null;
  targetScopeKind: "user" | "organization" | "project";
  reconnectConnectionId: string | null;
  accessMode: "full" | "read_only";
  createdAt: Date;
}

function pendingGrantColumns(sql: Sql) {
  return sql`
    id, organization_id as "organizationId", user_id as "userId",
    project_id as "projectId",
    provider, state_token_hash as "stateTokenHash",
    pkce_verifier_encrypted as "pkceVerifierEncrypted",
    requested_scopes_json as "requestedScopesJson",
    requested_display_name as "requestedDisplayName",
    origin, cli_session_id as "cliSessionId", status,
    expires_at as "expiresAt", consumed_at as "consumedAt",
    rejected_reason as "rejectedReason",
    resulting_connection_id as "resultingConnectionId",
    metadata_json as "metadataJson",
    connect_token_hash as "connectTokenHash",
    continued_at as "continuedAt",
    authorized_at as "authorizedAt",
    (code_encrypted is not null) as "hasCode",
    result_token_hash as "resultTokenHash",
    target_scope_kind as "targetScopeKind",
    reconnect_connection_id as "reconnectConnectionId",
    access_mode as "accessMode",
    created_at as "createdAt"
  `;
}

export interface InsertPendingGrantInput {
  organizationId: string;
  userId: string;
  provider: string;
  stateTokenHash: string;
  connectTokenHash: string;
  requestedScopes: string[];
  requestedDisplayName: string | null;
  origin: "cli" | "ui";
  cliSessionId: string | null;
  targetScopeKind: "user" | "organization";
  reconnectConnectionId: string | null;
  accessMode: "full" | "read_only";
  metadata: Record<string, unknown>;
  ttlSeconds: number;
}

export async function insertPendingGrant(
  db: ConnectorsDb,
  input: InsertPendingGrantInput,
): Promise<ConnectorGrantPendingRecord> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    insert into connector_grants_pending (
      organization_id, user_id, project_id, provider, state_token_hash,
      connect_token_hash, requested_scopes_json, requested_display_name,
      origin, cli_session_id, target_scope_kind, reconnect_connection_id,
      access_mode, metadata_json, expires_at
    ) values (
      ${input.organizationId},
      ${input.userId},
      null,
      ${input.provider},
      ${input.stateTokenHash},
      ${input.connectTokenHash},
      ${db.sql.json(input.requestedScopes)},
      ${input.requestedDisplayName},
      ${input.origin},
      ${input.cliSessionId},
      ${input.targetScopeKind},
      ${input.reconnectConnectionId},
      ${input.accessMode},
      ${db.sql.json(input.metadata as never)},
      now() + (${input.ttlSeconds}::int * interval '1 second')
    )
    returning ${pendingGrantColumns(db.sql)}
  `;
  return rows[0]!;
}

/** The CLI status poll: only the initiator sees its grant. */
export async function findPendingGrantById(
  db: ConnectorsDb,
  id: string,
  userId: string,
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    select ${pendingGrantColumns(db.sql)}
    from connector_grants_pending
    where id = ${id} and user_id = ${userId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findPendingGrant(
  db: ConnectorsDb,
  id: string,
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    select ${pendingGrantColumns(db.sql)}
    from connector_grants_pending
    where id = ${id}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findPendingGrantByConnectTokenHash(
  db: ConnectorsDb,
  connectTokenHash: string,
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    select ${pendingGrantColumns(db.sql)}
    from connector_grants_pending
    where connect_token_hash = ${connectTokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findPendingGrantByStateTokenHash(
  db: ConnectorsDb,
  stateTokenHash: string,
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    select ${pendingGrantColumns(db.sql)}
    from connector_grants_pending
    where state_token_hash = ${stateTokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * "Continue to Google": only once, only for the initiator, only while
 * the grant is pending and unexpired. Replaces the placeholder state hash
 * with the real one and stores the encrypted PKCE verifier.
 */
export async function continuePendingGrant(
  db: ConnectorsDb,
  input: {
    id: string;
    organizationId: string;
    userId: string;
    stateTokenHash: string;
    pkceVerifierEncrypted: string | null;
  },
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    update connector_grants_pending
    set continued_at = now(),
        state_token_hash = ${input.stateTokenHash},
        pkce_verifier_encrypted = ${input.pkceVerifierEncrypted},
        updated_at = now()
    where id = ${input.id}
      and organization_id = ${input.organizationId}
      and user_id = ${input.userId}
      and status = 'pending'
      and continued_at is null
      and expires_at > now()
    returning ${pendingGrantColumns(db.sql)}
  `;
  return rows[0] ?? null;
}

/**
 * Provider callback: store the encrypted authorization code and the
 * result token hash once. A replayed callback finds nothing to update.
 */
export async function authorizePendingGrant(
  db: ConnectorsDb,
  input: { id: string; stateTokenHash: string; codeEncrypted: string; resultTokenHash: string },
): Promise<ConnectorGrantPendingRecord | null> {
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    update connector_grants_pending
    set authorized_at = now(),
        code_encrypted = ${input.codeEncrypted},
        result_token_hash = ${input.resultTokenHash},
        updated_at = now()
    where id = ${input.id}
      and state_token_hash = ${input.stateTokenHash}
      and status = 'pending'
      and continued_at is not null
      and authorized_at is null
      and expires_at > now()
    returning ${pendingGrantColumns(db.sql)}
  `;
  return rows[0] ?? null;
}

/** Reject a pending grant and discard its code. No-op unless still pending. */
export async function rejectPendingGrant(
  db: ConnectorsDb,
  input: { id: string; reason: string },
): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    update connector_grants_pending
    set status = 'rejected',
        rejected_reason = ${input.reason},
        code_encrypted = null,
        updated_at = now()
    where id = ${input.id}
      and status = 'pending'
    returning id
  `;
  return rows.length > 0;
}

/**
 * Claim an authorized grant for the code exchange: status → consumed and
 * the code removed in the same statement. Only the single caller that wins
 * the claim gets the code bundle back.
 */
export async function claimAuthorizedPendingGrant(
  db: ConnectorsDb,
  id: string,
): Promise<{ grant: ConnectorGrantPendingRecord; codeEncrypted: string } | null> {
  const current = await db.sql<{ codeEncrypted: string | null }[]>`
    select code_encrypted as "codeEncrypted"
    from connector_grants_pending
    where id = ${id}
    limit 1
  `;
  const codeEncrypted = current[0]?.codeEncrypted ?? null;
  if (!codeEncrypted) return null;
  const rows = await db.sql<ConnectorGrantPendingRecord[]>`
    update connector_grants_pending
    set status = 'consumed',
        consumed_at = now(),
        code_encrypted = null,
        updated_at = now()
    where id = ${id}
      and status = 'pending'
      and authorized_at is not null
      and code_encrypted = ${codeEncrypted}
      and expires_at > now()
    returning ${pendingGrantColumns(db.sql)}
  `;
  const grant = rows[0];
  if (!grant) return null;
  return { grant, codeEncrypted };
}

/** Claimed, no connection stored, and the finish that claimed it is gone. */
export function isStaleClaim(
  pending: Pick<ConnectorGrantPendingRecord, "status" | "resultingConnectionId" | "consumedAt" | "expiresAt">,
  now = Date.now(),
): boolean {
  if (pending.status !== "consumed" || pending.resultingConnectionId) return false;
  return pending.consumedAt
    ? pending.consumedAt.getTime() <= now - STALE_CLAIM_SECONDS * 1000
    : pending.expiresAt.getTime() <= now;
}

/** A claimed grant whose exchange or store failed. */
export async function failClaimedPendingGrant(
  db: ConnectorsDb,
  input: { id: string; reason: string },
): Promise<void> {
  await db.sql`
    update connector_grants_pending
    set status = 'rejected',
        rejected_reason = ${input.reason},
        code_encrypted = null,
        updated_at = now()
    where id = ${input.id}
      and status = 'consumed'
      and resulting_connection_id is null
  `;
}

export async function completePendingGrant(
  db: ConnectorsDb,
  input: { id: string; connectionId: string; finishResult: Record<string, unknown> },
): Promise<void> {
  // A late finish wins over the scheduler having given up on its claim.
  await db.sql`
    update connector_grants_pending
    set resulting_connection_id = ${input.connectionId},
        status = 'consumed',
        rejected_reason = null,
        metadata_json = metadata_json || jsonb_build_object('finishResult', ${db.sql.json(input.finishResult as never)}::jsonb),
        updated_at = now()
    where id = ${input.id}
  `;
}

export async function expirePendingGrant(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update connector_grants_pending
    set status = 'expired', code_encrypted = null, updated_at = now()
    where id = ${id}
      and status = 'pending'
      and expires_at <= now()
  `;
}

// --------------------------------------------------------------------------
// Scheduled maintenance
// --------------------------------------------------------------------------

/** Restricts maintenance to one organization (operators, tests); empty = everything. */
export interface MaintenanceScope {
  organizationId?: string | null;
}

/**
 * Same data change as migration 0050 for google rows the previous Worker
 * still inserts as scope `project`: personal rows, no project, the old
 * project remembered in metadata. A row whose account another live row of
 * the same person already holds gives up `external_account_id` first
 * (kept as `googleSub` + `duplicateOf`), and a default another row of the
 * same person holds is cleared, so the per-person unique indexes hold.
 * Idempotent.
 */
export async function reclassifyLegacyProjectConnections(
  db: ConnectorsDb,
  scope: MaintenanceScope = {},
): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  return withTransaction(db, async (tx) => {
    // At most one default per (organization, user, provider) once these
    // rows are personal: a personal default wins, else the newest row.
    await tx.sql`
      update provider_connections pc
      set is_default = false, updated_at = now()
      where pc.provider <> 'github'
        and pc.scope_kind = 'project'
        and pc.is_default
        and (${organizationId}::uuid is null or pc.organization_id = ${organizationId}::uuid)
        and exists (
          select 1 from provider_connections o
          where o.id <> pc.id
            and o.organization_id = pc.organization_id
            and o.user_id = pc.user_id
            and o.provider = pc.provider
            and o.is_default
            and (
              o.scope_kind = 'user'
              or (o.scope_kind = 'project' and (o.created_at, o.id) > (pc.created_at, pc.id))
            )
        )
    `;
    await tx.sql`
      with candidates as (
        select id, organization_id, user_id, provider, external_account_id, created_at
        from provider_connections
        where provider <> 'github'
          and scope_kind = 'project'
          and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
          and external_account_id is not null
          and user_id is not null
          and status not in ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')
      ),
      holders as (
        select c.id, (
          select o.id
          from provider_connections o
          where o.id <> c.id
            and o.organization_id = c.organization_id
            and o.user_id = c.user_id
            and o.provider = c.provider
            and o.external_account_id = c.external_account_id
            and o.status not in ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')
            and (
              o.scope_kind = 'user'
              or (o.scope_kind = 'project' and (o.created_at, o.id) < (c.created_at, c.id))
            )
          order by (o.scope_kind = 'user') desc, o.created_at asc
          limit 1
        ) as holder_id
        from candidates c
      )
      update provider_connections pc
      set metadata_json = pc.metadata_json || jsonb_build_object(
            'googleSub', pc.external_account_id,
            'legacyExternalAccountId', pc.external_account_id,
            'duplicateOf', holders.holder_id::text
          ),
          external_account_id = null,
          updated_at = now()
      from holders
      where pc.id = holders.id
        and holders.holder_id is not null
    `;
    const rows = await tx.sql<{ id: string }[]>`
      update provider_connections
      set metadata_json = metadata_json
            || jsonb_build_object('legacyProjectId', project_id::text)
            || case
                 when provider = 'google' and external_account_id is not null
                   then jsonb_build_object('googleSub', external_account_id)
                 else '{}'::jsonb
               end,
          scope_kind = 'user',
          project_id = null,
          updated_at = now()
      where provider <> 'github'
        and scope_kind = 'project'
        and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
      returning id
    `;
    return rows.length;
  });
}

export async function expireStalePendingGrants(db: ConnectorsDb, scope: MaintenanceScope = {}): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  const rows = await db.sql<{ id: string }[]>`
    update connector_grants_pending
    set status = 'expired', code_encrypted = null, updated_at = now()
    where status = 'pending'
      and expires_at <= now()
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    returning id
  `;
  return rows.length;
}

/** See `isStaleClaim`: such grants are rejected as `exchange_failed`. */
export async function failStaleClaimedPendingGrants(db: ConnectorsDb, scope: MaintenanceScope = {}): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  const rows = await db.sql<{ id: string }[]>`
    update connector_grants_pending
    set status = 'rejected',
        rejected_reason = 'exchange_failed',
        code_encrypted = null,
        updated_at = now()
    where status = 'consumed'
      and resulting_connection_id is null
      and (
        consumed_at <= now() - (${STALE_CLAIM_SECONDS}::int * interval '1 second')
        or (consumed_at is null and expires_at <= now())
      )
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    returning id
  `;
  return rows.length;
}

export async function expireStaleApprovals(db: ConnectorsDb, scope: MaintenanceScope = {}): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  const rows = await db.sql<{ id: string }[]>`
    update connector_action_approvals
    set status = 'expired', updated_at = now()
    where status in ('pending', 'approved')
      and expires_at <= now()
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    returning id
  `;
  return rows.length;
}

export async function expireStaleConsentRequests(db: ConnectorsDb, scope: MaintenanceScope = {}): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  const rows = await db.sql<{ id: string }[]>`
    update connector_consent_requests
    set status = 'expired', updated_at = now()
    where status = 'pending'
      and expires_at <= now()
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    returning id
  `;
  return rows.length;
}

export async function deleteExpiredTurnReads(db: ConnectorsDb, scope: MaintenanceScope = {}): Promise<number> {
  const organizationId = scope.organizationId ?? null;
  const rows = await db.sql<{ id: string }[]>`
    delete from connector_turn_reads
    where expires_at <= now()
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    returning turn_key_hash as id
  `;
  return rows.length;
}

export async function listRevokePendingConnections(
  db: ConnectorsDb,
  limit: number,
  scope: MaintenanceScope = {},
): Promise<ProviderConnectionRecord[]> {
  const organizationId = scope.organizationId ?? null;
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where status = 'revoke_pending'
      and (${organizationId}::uuid is null or organization_id = ${organizationId}::uuid)
    order by updated_at asc
    limit ${limit}
  `;
}

/**
 * Live google rows with no account email yet that still hold an id_token
 * to read it from, skipping rows already found to carry no identity.
 */
export async function listIdentityBackfillCandidates(
  db: ConnectorsDb,
  limit: number,
  scope: MaintenanceScope = {},
): Promise<ProviderConnectionRecord[]> {
  const organizationId = scope.organizationId ?? null;
  return db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections pc
    where pc.provider = 'google'
      and (${organizationId}::uuid is null or pc.organization_id = ${organizationId}::uuid)
      and pc.external_account_login is null
      and pc.status in ('active', 'degraded', 'suspended', 'revoke_pending')
      and coalesce(pc.metadata_json->>'identityBackfill', '') <> 'unavailable'
      and exists (
        select 1 from connector_credentials cc
        where cc.provider_connection_id = pc.id
          and cc.payload_kind = 'id_token'
      )
    order by pc.created_at asc
    limit ${limit}
  `;
}

export async function markIdentityBackfillUnavailable(db: ConnectorsDb, id: string): Promise<void> {
  await db.sql`
    update provider_connections
    set metadata_json = metadata_json || jsonb_build_object('identityBackfill', 'unavailable'),
        updated_at = now()
    where id = ${id}
  `;
}

// --------------------------------------------------------------------------
// Step-up challenges
// --------------------------------------------------------------------------

export interface StepupChallengeRecord {
  id: string;
  providerConnectionId: string;
  organizationId: string;
  userId: string;
  capability: string;
  capabilityClass: string;
  factor: "passkey" | "totp" | "sms" | "password" | null;
  status: "issued" | "consumed" | "expired" | "rejected";
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface InsertStepupChallengeInput {
  providerConnectionId: string;
  organizationId: string;
  userId: string;
  capability: string;
  capabilityClass: string;
  tokenHash: string;
  ttlSeconds: number;
}

export async function insertStepupChallenge(
  db: ConnectorsDb,
  input: InsertStepupChallengeInput,
): Promise<StepupChallengeRecord> {
  const rows = await db.sql<StepupChallengeRecord[]>`
    insert into connector_stepup_challenges (
      provider_connection_id, organization_id, user_id,
      capability, capability_class, token_hash, expires_at
    ) values (
      ${input.providerConnectionId},
      ${input.organizationId},
      ${input.userId},
      ${input.capability},
      ${input.capabilityClass},
      ${input.tokenHash},
      now() + (${input.ttlSeconds}::int * interval '1 second')
    )
    returning
      id, provider_connection_id as "providerConnectionId",
      organization_id as "organizationId", user_id as "userId",
      capability, capability_class as "capabilityClass",
      factor, status, token_hash as "tokenHash",
      expires_at as "expiresAt", consumed_at as "consumedAt"
  `;
  return rows[0]!;
}

export async function markStepupIssued(
  db: ConnectorsDb,
  challengeId: string,
  factor: "passkey" | "totp" | "sms" | "password",
): Promise<void> {
  await db.sql`
    update connector_stepup_challenges
    set factor = ${factor}, updated_at = now()
    where id = ${challengeId}
  `;
}

export async function findStepupByTokenHash(
  db: ConnectorsDb,
  tokenHash: string,
): Promise<StepupChallengeRecord | null> {
  const rows = await db.sql<StepupChallengeRecord[]>`
    select
      id, provider_connection_id as "providerConnectionId",
      organization_id as "organizationId", user_id as "userId",
      capability, capability_class as "capabilityClass",
      factor, status, token_hash as "tokenHash",
      expires_at as "expiresAt", consumed_at as "consumedAt"
    from connector_stepup_challenges
    where token_hash = ${tokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function consumeStepupChallenge(
  db: ConnectorsDb,
  challengeId: string,
): Promise<StepupChallengeRecord | null> {
  const rows = await db.sql<StepupChallengeRecord[]>`
    update connector_stepup_challenges
    set status = 'consumed', consumed_at = now(), updated_at = now()
    where id = ${challengeId}
      and status in ('issued')
      and expires_at > now()
    returning
      id, provider_connection_id as "providerConnectionId",
      organization_id as "organizationId", user_id as "userId",
      capability, capability_class as "capabilityClass",
      factor, status, token_hash as "tokenHash",
      expires_at as "expiresAt", consumed_at as "consumedAt"
  `;
  return rows[0] ?? null;
}

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

export interface InsertAuditInput {
  organizationId: string | null;
  projectId?: string | null;
  actorType: "user" | "system" | "api_key" | "cli" | "agent";
  actorId: string | null;
  targetType: string;
  targetId: string | null;
  action: string;
  requestId: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertAuditEvent(
  db: ConnectorsDb,
  input: InsertAuditInput,
): Promise<void> {
  await db.sql`
    insert into audit_events (
      organization_id, project_id, actor_type, actor_id,
      target_type, target_id, action, request_id, metadata_json
    ) values (
      ${input.organizationId},
      ${input.projectId ?? null},
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

// --------------------------------------------------------------------------
// Calendar sync (spec `console/calendar`, "Sync")
// --------------------------------------------------------------------------

export interface CalendarSyncTarget {
  settingsId: string;
  connection: ProviderConnectionRecord;
}

/**
 * Lease up to `limit` connections with calendar sync on, oldest attempt
 * first: `last_synced_at` moves to now as they are taken, so an overlapping
 * run skips them.
 */
export async function leaseCalendarSyncTargets(
  db: ConnectorsDb,
  input: { limit: number; minIntervalSeconds: number; scope?: MaintenanceScope },
): Promise<CalendarSyncTarget[]> {
  const organizationId = input.scope?.organizationId ?? null;
  const picked = await db.sql<{ settingsId: string; connectionId: string }[]>`
    with picked as (
      select s.id
      from calendar_settings s
      join provider_connections c on c.id = s.provider_connection_id
      where s.sync_enabled = true
        and (${organizationId}::uuid is null or s.organization_id = ${organizationId}::uuid)
        and c.scope_kind = 'user'
        and c.revoked_at is null
        and c.status in ('active', 'degraded')
        and (s.last_synced_at is null or s.last_synced_at < now() - make_interval(secs => ${input.minIntervalSeconds}))
      order by s.last_synced_at asc nulls first
      limit ${input.limit}
      for update of s skip locked
    )
    update calendar_settings s
    set last_synced_at = now()
    from picked
    where s.id = picked.id
    returning s.id as "settingsId", s.provider_connection_id as "connectionId"
  `;
  if (picked.length === 0) return [];
  const connections = await db.sql<ProviderConnectionRecord[]>`
    select ${connectionColumns(db.sql)}
    from provider_connections
    where id in ${db.sql(picked.map((row) => row.connectionId))}
  `;
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return picked.flatMap((row) => {
    const connection = byId.get(row.connectionId);
    return connection ? [{ settingsId: row.settingsId, connection }] : [];
  });
}

/** Normalized emails of the organization's active members, to tell external attendees apart. */
export async function listOrganizationMemberEmails(db: ConnectorsDb, organizationId: string): Promise<Set<string>> {
  const rows = await db.sql<{ email: string | null }[]>`
    select lower(u.primary_email) as "email"
    from organization_memberships m
    join users u on u.id = m.user_id
    where m.organization_id = ${organizationId}
      and m.status = 'active'
      and u.status = 'active'
  `;
  return new Set(rows.flatMap((row) => (row.email ? [row.email] : [])));
}

export interface CalendarEventUpsert {
  providerEventId: string;
  icalUid: string | null;
  recurringEventId: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  status: string;
  meetingUrl: string | null;
  meetingCode: string | null;
  organizerEmail: string | null;
  selfResponse: string | null;
  attendees: { email: string; name: string | null; response: string | null; organizer: boolean; self: boolean }[];
  externalAttendees: boolean;
  providerUpdatedAt: Date | null;
}

/**
 * Insert or refresh the events of one connection. A row changes (and its
 * `updated_at` moves, which the local mirror pulls by) only when the
 * provider changed it, it comes back after being removed, or who counts as
 * external changed. Returns how many rows were written.
 */
export async function upsertCalendarEvents(
  db: ConnectorsDb,
  input: { connection: { id: string; organizationId: string; userId: string }; events: CalendarEventUpsert[] },
): Promise<number> {
  let written = 0;
  for (const event of input.events) {
    const rows = await db.sql`
      insert into calendar_events (
        organization_id, user_id, provider_connection_id, provider_calendar_id,
        provider_event_id, ical_uid, recurring_event_id, title, start_at, end_at,
        all_day, status, meeting_url, meeting_code, organizer_email, self_response,
        attendees_json, external_attendees, provider_updated_at
      ) values (
        ${input.connection.organizationId}, ${input.connection.userId}, ${input.connection.id}, 'primary',
        ${event.providerEventId}, ${event.icalUid}, ${event.recurringEventId}, ${event.title},
        ${event.startAt}, ${event.endAt}, ${event.allDay}, ${event.status}, ${event.meetingUrl},
        ${event.meetingCode}, ${event.organizerEmail}, ${event.selfResponse},
        ${db.sql.json(event.attendees as never)}, ${event.externalAttendees}, ${event.providerUpdatedAt}
      )
      on conflict (provider_connection_id, provider_event_id) do update set
        ical_uid = excluded.ical_uid,
        recurring_event_id = excluded.recurring_event_id,
        title = excluded.title,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        all_day = excluded.all_day,
        status = excluded.status,
        meeting_url = excluded.meeting_url,
        meeting_code = excluded.meeting_code,
        organizer_email = excluded.organizer_email,
        self_response = excluded.self_response,
        attendees_json = excluded.attendees_json,
        external_attendees = excluded.external_attendees,
        provider_updated_at = excluded.provider_updated_at,
        deleted_at = null,
        updated_at = now()
      where calendar_events.provider_updated_at is distinct from excluded.provider_updated_at
         or calendar_events.deleted_at is not null
         or calendar_events.external_attendees is distinct from excluded.external_attendees
      returning id
    `;
    written += rows.length;
  }
  return written;
}

/** Events of the window the provider no longer lists are marked removed (kept for the decision history). */
export async function markMissingCalendarEventsDeleted(
  db: ConnectorsDb,
  input: { connectionId: string; timeMin: Date; timeMax: Date; keepProviderEventIds: string[] },
): Promise<number> {
  const keep = input.keepProviderEventIds.length > 0 ? input.keepProviderEventIds : [""];
  const rows = await db.sql`
    update calendar_events
    set deleted_at = now(), updated_at = now()
    where provider_connection_id = ${input.connectionId}
      and deleted_at is null
      and start_at >= ${input.timeMin}
      and start_at <= ${input.timeMax}
      and provider_event_id not in ${db.sql(keep)}
    returning id
  `;
  return rows.length;
}

export async function recordCalendarSyncResult(
  db: ConnectorsDb,
  input: { settingsId: string; error: string | null },
): Promise<void> {
  await db.sql`
    update calendar_settings
    set last_sync_error = ${input.error}, updated_at = now()
    where id = ${input.settingsId}
  `;
}
