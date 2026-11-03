import postgres, { type Sql } from "postgres";

import { sha256Hex } from "./crypto";
import type { HyperdriveBinding } from "./env";

export interface McpDb {
  sql: Sql;
  close(): Promise<void>;
}

export type BridgeRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  status: "active" | "paused" | "revoked";
  allowedCapabilityClassesJson: string[];
  rateLimitOverridesJson: Record<string, unknown> | null;
  cachedToolsJson: Record<string, unknown> | null;
  expiresAt: Date | null;
};

export type OAuthClientRecord = {
  id: string;
  bridgeId: string;
  organizationId: string;
  projectId: string;
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  softwareId: string | null;
  softwareVersion: string | null;
  redirectUrisJson: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
};

export type OAuthAuthorizationRecord = {
  id: string;
  bridgeId: string;
  oauthClientId: string;
  organizationId: string;
  projectId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopesJson: string[];
  redirectUri: string;
  subjectUserId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type OAuthTokenRecord = {
  id: string;
  bridgeId: string;
  oauthClientId: string;
  organizationId: string;
  projectId: string;
  subjectUserId: string;
  accessTokenHash?: string;
  refreshTokenHash: string;
  scopesJson: string[];
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt: Date;
  revokedAt: Date | null;
};

export type OAuthAccessTokenRecord = {
  id: string;
  bridgeId: string;
  oauthClientId: string;
  organizationId: string;
  projectId: string;
  subjectUserId: string;
  scopesJson: string[];
  accessTokenExpiresAt: Date;
  revokedAt: Date | null;
  clientId: string;
  clientName: string;
  softwareId: string | null;
  softwareVersion: string | null;
};

export type McpBridgeEventType =
  | "connect"
  | "disconnect"
  | "initialize"
  | "tools_list"
  | "tools_call"
  | "resources_read"
  | "prompts_get"
  | "error"
  | "daemon_offline"
  | "rate_limited";

export type McpBridgeEventStatusClass =
  | "ok"
  | "client_error"
  | "server_error"
  | "upstream_unavailable";

export function openMcpDb(hyperdrive: HyperdriveBinding): McpDb {
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

export async function findBridgeByToken(db: McpDb, token: string): Promise<BridgeRecord | null> {
  const tokenHash = await sha256Hex(token);
  const rows = await db.sql<BridgeRecord[]>`
    select
      id,
      organization_id as "organizationId",
      project_id as "projectId",
      name,
      status,
      allowed_capability_classes_json as "allowedCapabilityClassesJson",
      rate_limit_overrides_json as "rateLimitOverridesJson",
      cached_tools_json as "cachedToolsJson",
      expires_at as "expiresAt"
    from mcp_bridges
    where (bridge_token_hash = ${tokenHash} or previous_bridge_token_hash = ${tokenHash})
      and status = 'active'
      and (expires_at is null or expires_at > now())
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findClientByClientId(
  db: McpDb,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const rows = await db.sql<OAuthClientRecord[]>`
    select
      id,
      bridge_id as "bridgeId",
      organization_id as "organizationId",
      project_id as "projectId",
      client_id as "clientId",
      client_secret_hash as "clientSecretHash",
      client_name as "clientName",
      software_id as "softwareId",
      software_version as "softwareVersion",
      redirect_uris_json as "redirectUrisJson",
      token_endpoint_auth_method as "tokenEndpointAuthMethod"
    from mcp_oauth_clients
    where client_id = ${clientId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function createOAuthClient(input: {
  db: McpDb;
  bridge: BridgeRecord;
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  softwareId?: string | null;
  softwareVersion?: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
}) {
  const rows = await input.db.sql<OAuthClientRecord[]>`
    insert into mcp_oauth_clients (
      organization_id,
      project_id,
      bridge_id,
      client_id,
      client_secret_hash,
      client_name,
      software_id,
      software_version,
      redirect_uris_json,
      grant_types_json,
      token_endpoint_auth_method
    )
    values (
      ${input.bridge.organizationId},
      ${input.bridge.projectId},
      ${input.bridge.id},
      ${input.clientId},
      ${input.clientSecretHash},
      ${input.clientName},
      ${input.softwareId ?? null},
      ${input.softwareVersion ?? null},
      ${input.db.sql.json(input.redirectUris)},
      ${input.db.sql.json(input.grantTypes)},
      ${input.tokenEndpointAuthMethod}
    )
    returning
      id,
      bridge_id as "bridgeId",
      organization_id as "organizationId",
      project_id as "projectId",
      client_id as "clientId",
      client_secret_hash as "clientSecretHash",
      client_name as "clientName",
      software_id as "softwareId",
      software_version as "softwareVersion",
      redirect_uris_json as "redirectUrisJson",
      token_endpoint_auth_method as "tokenEndpointAuthMethod"
  `;
  return rows[0]!;
}

export async function findAuthorizationByCodeHash(db: McpDb, codeHash: string) {
  const rows = await db.sql<OAuthAuthorizationRecord[]>`
    select
      id,
      bridge_id as "bridgeId",
      oauth_client_id as "oauthClientId",
      organization_id as "organizationId",
      project_id as "projectId",
      code_challenge as "codeChallenge",
      code_challenge_method as "codeChallengeMethod",
      scopes_json as "scopesJson",
      redirect_uri as "redirectUri",
      subject_user_id as "subjectUserId",
      expires_at as "expiresAt",
      consumed_at as "consumedAt"
    from mcp_oauth_authorizations
    where code_hash = ${codeHash}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function consumeAuthorization(db: McpDb, authorizationId: string) {
  await db.sql`
    update mcp_oauth_authorizations
    set consumed_at = now()
    where id = ${authorizationId}
  `;
}

export async function createOAuthToken(input: {
  db: McpDb;
  authorization: OAuthAuthorizationRecord;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  rotatedFromTokenId?: string | null;
}) {
  await input.db.sql`
    insert into mcp_oauth_tokens (
      organization_id,
      project_id,
      bridge_id,
      oauth_client_id,
      subject_user_id,
      access_token_hash,
      refresh_token_hash,
      access_token_expires_at,
      refresh_token_expires_at,
      scopes_json,
      rotated_from_token_id
    )
    values (
      ${input.authorization.organizationId},
      ${input.authorization.projectId},
      ${input.authorization.bridgeId},
      ${input.authorization.oauthClientId},
      ${input.authorization.subjectUserId},
      ${input.accessTokenHash},
      ${input.refreshTokenHash},
      ${input.accessTokenExpiresAt},
      ${input.refreshTokenExpiresAt},
      ${input.db.sql.json(input.authorization.scopesJson)},
      ${input.rotatedFromTokenId ?? null}
    )
  `;
}

/**
 * Refresh-token rotation in one statement: revokes the parent only while it is
 * not revoked, and inserts the child only when that revoke happened, so a
 * refresh token is used once and a concurrent chain revoke never leaves a
 * live child. With `capToParent` the child keeps the parent's refresh expiry
 * when that is sooner. Returns false when the parent was already revoked.
 */
export async function rotateOAuthToken(input: {
  db: McpDb;
  parentTokenId: string;
  scopesJson: string[];
  accessTokenHash: string;
  refreshTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  capToParent: boolean;
}) {
  const rows = await input.db.sql<{ id: string }[]>`
    with parent as (
      update mcp_oauth_tokens
      set revoked_at = now(), updated_at = now()
      where id = ${input.parentTokenId} and revoked_at is null
      returning *
    )
    insert into mcp_oauth_tokens (
      organization_id,
      project_id,
      bridge_id,
      oauth_client_id,
      subject_user_id,
      access_token_hash,
      refresh_token_hash,
      access_token_expires_at,
      refresh_token_expires_at,
      scopes_json,
      rotated_from_token_id
    )
    select
      parent.organization_id,
      parent.project_id,
      parent.bridge_id,
      parent.oauth_client_id,
      parent.subject_user_id,
      ${input.accessTokenHash},
      ${input.refreshTokenHash},
      case when ${input.capToParent} then least(${input.accessTokenExpiresAt}::timestamptz, parent.refresh_token_expires_at) else ${input.accessTokenExpiresAt}::timestamptz end,
      case when ${input.capToParent} then least(${input.refreshTokenExpiresAt}::timestamptz, parent.refresh_token_expires_at) else ${input.refreshTokenExpiresAt}::timestamptz end,
      ${input.db.sql.json(input.scopesJson)},
      parent.id
    from parent
    returning id
  `;
  return rows.length > 0;
}

export async function findRefreshToken(db: McpDb, refreshTokenHash: string) {
  const rows = await db.sql<OAuthTokenRecord[]>`
    select
      id,
      bridge_id as "bridgeId",
      oauth_client_id as "oauthClientId",
      organization_id as "organizationId",
      project_id as "projectId",
      subject_user_id as "subjectUserId",
      refresh_token_hash as "refreshTokenHash",
      scopes_json as "scopesJson",
      refresh_token_expires_at as "refreshTokenExpiresAt",
      revoked_at as "revokedAt"
    from mcp_oauth_tokens
    where refresh_token_hash = ${refreshTokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findAccessTokenByHash(db: McpDb, accessTokenHash: string) {
  const rows = await db.sql<OAuthAccessTokenRecord[]>`
    select
      token.id,
      token.bridge_id as "bridgeId",
      token.oauth_client_id as "oauthClientId",
      token.organization_id as "organizationId",
      token.project_id as "projectId",
      token.subject_user_id as "subjectUserId",
      token.scopes_json as "scopesJson",
      token.access_token_expires_at as "accessTokenExpiresAt",
      token.revoked_at as "revokedAt",
      client.client_id as "clientId",
      client.client_name as "clientName",
      client.software_id as "softwareId",
      client.software_version as "softwareVersion"
    from mcp_oauth_tokens token
    join mcp_oauth_clients client on client.id = token.oauth_client_id
    where token.access_token_hash = ${accessTokenHash}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function markOAuthAccessTokenUsed(db: McpDb, token: OAuthAccessTokenRecord) {
  await db.sql`
    update mcp_oauth_tokens
    set last_used_at = now(), updated_at = now()
    where id = ${token.id}
  `;
  await db.sql`
    update mcp_oauth_clients
    set last_used_at = now()
    where id = ${token.oauthClientId}
  `;
}

export async function revokeTokenByHash(db: McpDb, tokenHash: string) {
  await db.sql`
    update mcp_oauth_tokens
    set revoked_at = now(), updated_at = now()
    where access_token_hash = ${tokenHash}
       or refresh_token_hash = ${tokenHash}
  `;
}

export async function revokeTokenById(db: McpDb, tokenId: string) {
  await db.sql`
    update mcp_oauth_tokens
    set revoked_at = now(), updated_at = now()
    where id = ${tokenId}
  `;
}

export async function updateBridgeLastUsed(db: McpDb, bridgeId: string) {
  await db.sql`
    update mcp_bridges
    set last_used_at = now(), updated_at = now()
    where id = ${bridgeId}
  `;
}

export async function insertBridgeEvent(
  db: McpDb,
  input: {
    bridge: Pick<BridgeRecord, "id" | "organizationId" | "projectId">;
    eventType: McpBridgeEventType;
    durationMs: number;
    statusClass: McpBridgeEventStatusClass;
    requestId: string;
    oauthClientId?: string | null;
    clientUserAgent?: string | null;
    toolName?: string | null;
    model?: string | null;
    tokensInput?: number | null;
    tokensOutput?: number | null;
    costEstimateUsd?: string | null;
  },
) {
  await db.sql`
    insert into mcp_bridge_events (
      bridge_id,
      organization_id,
      project_id,
      event_type,
      tool_name,
      model,
      tokens_input,
      tokens_output,
      cost_estimate_usd,
      duration_ms,
      status_class,
      request_id,
      oauth_client_id,
      client_user_agent
    )
    values (
      ${input.bridge.id},
      ${input.bridge.organizationId},
      ${input.bridge.projectId},
      ${input.eventType},
      ${input.toolName ?? null},
      ${input.model ?? null},
      ${input.tokensInput ?? null},
      ${input.tokensOutput ?? null},
      ${input.costEstimateUsd ?? null},
      ${input.durationMs},
      ${input.statusClass},
      ${input.requestId},
      ${input.oauthClientId ?? null},
      ${input.clientUserAgent ?? null}
    )
  `;
}

export async function aggregateUsage(db: McpDb, day: string) {
  await db.sql`
    insert into mcp_bridge_usage (
      bridge_id,
      organization_id,
      project_id,
      day,
      calls_total,
      calls_ok,
      calls_error,
      tokens_input_total,
      tokens_output_total,
      cost_estimate_total_usd,
      unique_clients,
      daemon_offline_count,
      created_at,
      updated_at
    )
    select
      bridge_id,
      organization_id,
      project_id,
      ${day}::date,
      count(*)::int,
      count(*) filter (where status_class = 'ok')::int,
      count(*) filter (where status_class <> 'ok')::int,
      coalesce(sum(tokens_input), 0)::bigint,
      coalesce(sum(tokens_output), 0)::bigint,
      coalesce(sum(cost_estimate_usd), 0)::numeric(12, 6),
      count(distinct oauth_client_id)::int,
      count(*) filter (where event_type = 'daemon_offline')::int,
      now(),
      now()
    from mcp_bridge_events
    where occurred_at >= ${day}::date
      and occurred_at < (${day}::date + interval '1 day')
    group by bridge_id, organization_id, project_id
    on conflict (bridge_id, day) do update set
      calls_total = excluded.calls_total,
      calls_ok = excluded.calls_ok,
      calls_error = excluded.calls_error,
      tokens_input_total = excluded.tokens_input_total,
      tokens_output_total = excluded.tokens_output_total,
      cost_estimate_total_usd = excluded.cost_estimate_total_usd,
      unique_clients = excluded.unique_clients,
      daemon_offline_count = excluded.daemon_offline_count,
      updated_at = now()
  `;
}
