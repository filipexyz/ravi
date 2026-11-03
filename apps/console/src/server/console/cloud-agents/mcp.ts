// Ravi tools for cloud runs (D7): one Console-managed MCP bridge per project
// ("Cloud agents"), one internal OAuth client per such bridge, and a run token
// per run minted without the consent screen. Anthropic holds the token in the
// session vault and refreshes it at the Worker; the Console revokes the whole
// rotation chain when the run ends.
//
// The Console MCP (`src/server/mcp/console-tools.ts`) asks `resolveCloudRunCaller`
// whether a call comes from a cloud run; a run's writes then need a matching
// approved `cloud_agent_approvals` row instead of the `rmc1` confirmation.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import { generateOpaqueToken, sha256Hex } from "@/server/mcp/crypto";
import { createBridge } from "@/server/mcp/write";

import type { CloudSecretCodec } from "./crypto";
import { cloudError } from "./errors";
import { CLOUD_ACTIVE_RUN_STATUSES } from "./types";

export const CLOUD_BRIDGE_KIND = "cloud_agents";
export const CLOUD_BRIDGE_NAME = "Cloud agents";
export const CLOUD_OAUTH_CLIENT_NAME = "ravi-cloud-agents";
export const CLOUD_RUN_SCOPES = ["mcp.bridge.connect", "mcp.console.tools.read", "mcp.console.tools.write"] as const;
export const CLOUD_RAVI_MCP_SERVER = "ravi";
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

/**
 * The MCP tool name of a registry id, as the MCP Worker lists it
 * (`workers/mcp/src/console-mode.ts`): underscores doubled, dots to underscores.
 */
export function mcpToolName(operationId: string) {
  return operationId.replaceAll("_", "__").replaceAll(".", "_");
}

export type CloudBridge = { id: string; token: string; consoleUrl: string };

/** The project's cloud bridge, created on first use; its token is kept encrypted in the bridge metadata. */
export async function ensureCloudBridge(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  codec: CloudSecretCodec;
  mcpBaseUrl: string;
}): Promise<CloudBridge> {
  const existing = await db
    .select({ id: schema.mcpBridges.id, metadata: schema.mcpBridges.metadataJson })
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.organizationId, input.organizationId),
        eq(schema.mcpBridges.projectId, input.projectId),
        eq(schema.mcpBridges.status, "active"),
        sql`${schema.mcpBridges.metadataJson} ->> 'kind' = ${CLOUD_BRIDGE_KIND}`,
      ),
    )
    .orderBy(schema.mcpBridges.createdAt)
    .limit(1);
  const found = existing[0];
  if (found && typeof found.metadata.bridgeTokenEncrypted === "string") {
    const token = input.codec.decrypt(found.metadata.bridgeTokenEncrypted, {
      organizationId: input.organizationId,
      purpose: "bridge_token",
      recordId: found.id,
    });
    return { id: found.id, token, consoleUrl: consoleUrl(input.mcpBaseUrl, token) };
  }

  const created = await createBridge({
    organizationId: input.organizationId,
    projectId: input.projectId,
    createdByUserId: input.userId,
    name: CLOUD_BRIDGE_NAME,
    description: "Ravi tools for cloud agent runs. Managed by the Console; revoking it stops the Ravi tools of every cloud run in this project.",
    allowedCapabilityClasses: ["read", "write"],
    baseUrl: input.mcpBaseUrl,
  });
  const bridgeTokenEncrypted = input.codec.encrypt(created.bridgeToken, {
    organizationId: input.organizationId,
    purpose: "bridge_token",
    recordId: created.bridge.id,
  });
  await db
    .update(schema.mcpBridges)
    .set({ metadataJson: { kind: CLOUD_BRIDGE_KIND, bridgeTokenEncrypted }, updatedAt: new Date() })
    .where(eq(schema.mcpBridges.id, created.bridge.id));
  return { id: created.bridge.id, token: created.bridgeToken, consoleUrl: consoleUrl(input.mcpBaseUrl, created.bridgeToken) };
}

/** The internal public OAuth client the vault refreshes with: refresh grant only, no redirect. */
export async function ensureCloudOAuthClient(input: { organizationId: string; projectId: string; bridgeId: string }) {
  const clientId = `${CLOUD_OAUTH_CLIENT_NAME}.${input.bridgeId}`;
  await db
    .insert(schema.mcpOAuthClients)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      bridgeId: input.bridgeId,
      clientId,
      clientName: CLOUD_OAUTH_CLIENT_NAME,
      softwareId: CLOUD_OAUTH_CLIENT_NAME,
      redirectUrisJson: [],
      grantTypesJson: ["refresh_token"],
      tokenEndpointAuthMethod: "none",
    })
    .onConflictDoNothing();
  const [client] = await db
    .select({ id: schema.mcpOAuthClients.id, clientId: schema.mcpOAuthClients.clientId, bridgeId: schema.mcpOAuthClients.bridgeId })
    .from(schema.mcpOAuthClients)
    .where(eq(schema.mcpOAuthClients.clientId, clientId))
    .limit(1);
  if (!client || client.bridgeId !== input.bridgeId) throw cloudError("provider_error", "The cloud agents MCP client could not be prepared.");
  return client;
}

export type CloudRunToken = {
  tokenId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  clientId: string;
  tokenEndpoint: string;
};

/** Mints a run token for `subjectUserId` on the project's cloud bridge (D6, D7). */
export async function mintCloudRunToken(input: {
  organizationId: string;
  projectId: string;
  bridgeId: string;
  subjectUserId: string;
  runId: string;
  hardEndAt: Date;
  now: Date;
  mcpBaseUrl: string;
}): Promise<CloudRunToken> {
  const client = await ensureCloudOAuthClient(input);
  const accessToken = `mcp_at_${generateOpaqueToken(32)}`;
  const refreshToken = `mcp_rt_${generateOpaqueToken(32)}`;
  const accessTokenExpiresAt = new Date(Math.min(input.now.getTime() + ACCESS_TOKEN_TTL_MS, input.hardEndAt.getTime()));
  const [token] = await db
    .insert(schema.mcpOAuthTokens)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      bridgeId: input.bridgeId,
      oauthClientId: client.id,
      subjectUserId: input.subjectUserId,
      accessTokenHash: sha256Hex(accessToken),
      refreshTokenHash: sha256Hex(refreshToken),
      accessTokenExpiresAt,
      refreshTokenExpiresAt: input.hardEndAt,
      scopesJson: [...CLOUD_RUN_SCOPES],
      deviceLabel: `cloud-run:${input.runId}`,
    })
    .returning({ id: schema.mcpOAuthTokens.id });
  if (!token) throw cloudError("provider_error", "The run token could not be minted.");
  return {
    tokenId: token.id,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    clientId: client.clientId,
    tokenEndpoint: `${input.mcpBaseUrl}/oauth/mcp/token`,
  };
}

/** Revokes a run token and every token the Worker rotated from it. */
export async function revokeCloudRunTokenChain(rootTokenId: string | null, now: Date) {
  if (!rootTokenId) return;
  await db.execute(sql`
    with recursive chain(id) as (
      select id from mcp_oauth_tokens where id = ${rootTokenId}::uuid
      union all
      select token.id from mcp_oauth_tokens token join chain on token.rotated_from_token_id = chain.id
    )
    update mcp_oauth_tokens set revoked_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
    where id in (select id from chain) and revoked_at is null
  `);
}

export type CloudRunCaller = {
  bridgeId: string;
  /** The bridge's project: the only project a run token works in. */
  project: { id: string; slug: string };
  /** The runs this call may belong to; one when the Worker sent the token id. */
  runs: { id: string; writes: "ask" | "auto" }[];
};

/**
 * Null when the bridge is not a cloud bridge. Otherwise the active runs the
 * call belongs to: the run whose token chain holds `tokenId`, or (an older
 * Worker sends no token id) the caller's active runs in the bridge's project.
 */
export async function resolveCloudRunCaller(caller: {
  organizationId: string;
  userId: string;
  bridgeId: string;
  tokenId?: string | null;
}): Promise<CloudRunCaller | null> {
  const [bridge] = await db
    .select({
      id: schema.mcpBridges.id,
      projectId: schema.mcpBridges.projectId,
      projectSlug: schema.projects.slug,
      metadata: schema.mcpBridges.metadataJson,
    })
    .from(schema.mcpBridges)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.mcpBridges.projectId))
    .where(and(eq(schema.mcpBridges.id, caller.bridgeId), eq(schema.mcpBridges.organizationId, caller.organizationId)))
    .limit(1);
  if (!bridge || bridge.metadata.kind !== CLOUD_BRIDGE_KIND) return null;

  const active = and(
    eq(schema.cloudAgentRuns.organizationId, caller.organizationId),
    eq(schema.cloudAgentRuns.actorUserId, caller.userId),
    eq(schema.cloudAgentRuns.projectId, bridge.projectId),
    inArray(schema.cloudAgentRuns.status, [...CLOUD_ACTIVE_RUN_STATUSES]),
  );
  const select = () =>
    db
      .select({ id: schema.cloudAgentRuns.id, config: schema.cloudAgents.configJson })
      .from(schema.cloudAgentRuns)
      .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentRuns.agentId));

  let rows: { id: string; config: Record<string, unknown> }[] = [];
  const rootId = caller.tokenId && UUID.test(caller.tokenId) ? await rootTokenId(caller.tokenId) : null;
  if (rootId) rows = await select().where(and(active, eq(schema.cloudAgentRuns.mcpTokenId, rootId)));
  if (!caller.tokenId) rows = await select().where(active);
  return {
    bridgeId: bridge.id,
    project: { id: bridge.projectId, slug: bridge.projectSlug },
    runs: rows.map((row) => ({ id: row.id, writes: row.config.writes === "auto" ? "auto" : "ask" })),
  };
}

/**
 * Consumes one approved, unconsumed approval of `runIds` for this tool and
 * input, atomically. Returns its id, or null when none matches.
 */
export async function consumeCloudApproval(input: { runIds: readonly string[]; toolNames: readonly string[]; inputHash: string; now: Date }) {
  if (input.runIds.length === 0 || input.toolNames.length === 0) return null;
  const result = await db.execute<{ id: string; run_id: string }>(sql`
    update cloud_agent_approvals set consumed_at = ${input.now.toISOString()}::timestamptz, updated_at = ${input.now.toISOString()}::timestamptz
    where id = (
      select id from cloud_agent_approvals
      where run_id in (${sql.join(input.runIds.map((id) => sql`${id}::uuid`), sql`, `)})
        and status = 'approved'
        and consumed_at is null
        and server_name = ${CLOUD_RAVI_MCP_SERVER}
        and tool_name in (${sql.join(input.toolNames.map((name) => sql`${name}`), sql`, `)})
        and input_hash = ${input.inputHash}
      order by decided_at
      limit 1
      for update skip locked
    )
    returning id, run_id
  `);
  const row = [...result][0];
  return row ? { id: row.id, runId: row.run_id } : null;
}

async function rootTokenId(tokenId: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    with recursive up(id, parent, depth) as (
      select id, rotated_from_token_id, 0 from mcp_oauth_tokens where id = ${tokenId}::uuid
      union all
      select token.id, token.rotated_from_token_id, up.depth + 1
      from mcp_oauth_tokens token join up on token.id = up.parent
      where up.depth < 2000
    )
    select id from up where parent is null limit 1
  `);
  return [...result][0]?.id ?? null;
}

/** The Console-mode URL of a bridge; the bridge token is the path secret. */
export function consoleUrl(mcpBaseUrl: string, bridgeToken: string) {
  return `${mcpBaseUrl}/${bridgeToken}/console/mcp`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
