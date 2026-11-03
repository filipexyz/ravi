import { and, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import {
  generateBridgeChannelId,
  generateBridgeSessionRef,
  generateOpaqueToken,
  generateBridgeToken,
  sha256Hex,
} from "./crypto";

const ALLOWED_CAPABILITY_CLASSES = new Set(["read", "write", "destructive"]);

export type CreateBridgeResult = {
  bridge: typeof schema.mcpBridges.$inferSelect;
  bridgeToken: string;
  bridgeUrl: string;
};

export async function createBridge(input: {
  organizationId: string;
  projectId: string;
  createdByUserId: string;
  name: string;
  description?: string | null;
  allowedCapabilityClasses?: string[];
  baseUrl?: string;
}): Promise<CreateBridgeResult> {
  const bridgeToken = generateBridgeToken();
  const bridgeUrl = `${(input.baseUrl ?? process.env.RAVI_MCP_BASE_URL ?? "https://mcp.ravi.so").replace(
    /\/$/,
    "",
  )}/${bridgeToken}/mcp`;
  const now = new Date();
  const allowedCapabilityClasses = normalizeCapabilityClasses(input.allowedCapabilityClasses);
  const [bridge] = await db
    .insert(schema.mcpBridges)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      sessionRef: generateBridgeSessionRef(),
      channelId: generateBridgeChannelId(),
      name: input.name,
      description: input.description ?? null,
      bridgeTokenHash: sha256Hex(bridgeToken),
      allowedCapabilityClassesJson: allowedCapabilityClasses,
      lastUrlRotationAt: now,
    })
    .returning();

  if (!bridge) throw new Error("mcp_bridge_create_failed");
  return { bridge, bridgeToken, bridgeUrl };
}

export async function revokeBridge(input: {
  organizationId: string;
  bridgeId: string;
  userId?: string;
}) {
  const now = new Date();
  const [bridge] = await db
    .update(schema.mcpBridges)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(schema.mcpBridges.organizationId, input.organizationId),
        eq(schema.mcpBridges.id, input.bridgeId),
      ),
    )
    .returning();

  if (!bridge) return null;

  await db
    .update(schema.mcpOAuthTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.mcpOAuthTokens.organizationId, input.organizationId),
        eq(schema.mcpOAuthTokens.bridgeId, input.bridgeId),
        sql`${schema.mcpOAuthTokens.revokedAt} is null`,
      ),
    );

  return bridge;
}

export async function revokeOAuthToken(input: {
  organizationId: string;
  bridgeId: string;
  tokenId: string;
}) {
  const now = new Date();
  const [token] = await db
    .update(schema.mcpOAuthTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.mcpOAuthTokens.organizationId, input.organizationId),
        eq(schema.mcpOAuthTokens.bridgeId, input.bridgeId),
        eq(schema.mcpOAuthTokens.id, input.tokenId),
      ),
    )
    .returning();
  return token ?? null;
}

export async function rotateBridgeUrl(input: {
  organizationId: string;
  bridgeId: string;
  overlapPrevious?: boolean;
  baseUrl?: string;
}) {
  const token = generateBridgeToken();
  const now = new Date();
  const [existing] = await db
    .select()
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.organizationId, input.organizationId),
        eq(schema.mcpBridges.id, input.bridgeId),
      ),
    )
    .limit(1);
  // A cloud agents bridge keeps its token encrypted for its deployed agents; it is
  // managed by cloud agents only (`src/server/console/cloud-agents/mcp.ts`).
  if (!existing || existing.metadataJson?.kind === "cloud_agents") return null;

  const [bridge] = await db
    .update(schema.mcpBridges)
    .set({
      bridgeTokenHash: sha256Hex(token),
      previousBridgeTokenHash: input.overlapPrevious ? existing.bridgeTokenHash : null,
      lastUrlRotationAt: now,
      updatedAt: now,
    })
    .where(eq(schema.mcpBridges.id, existing.id))
    .returning();

  if (!bridge) return null;
  const bridgeUrl = `${(input.baseUrl ?? process.env.RAVI_MCP_BASE_URL ?? "https://mcp.ravi.so").replace(
    /\/$/,
    "",
  )}/${token}/mcp`;
  return { bridge, bridgeToken: token, bridgeUrl };
}

export async function ingestBridgeEvents(input: {
  events: Array<{
    bridgeId: string;
    organizationId: string;
    projectId: string;
    eventType: typeof schema.mcpBridgeEvents.$inferInsert.eventType;
    toolName?: string | null;
    model?: string | null;
    tokensInput?: number | null;
    tokensOutput?: number | null;
    costEstimateUsd?: string | null;
    durationMs: number;
    statusClass: typeof schema.mcpBridgeEvents.$inferInsert.statusClass;
    requestId: string;
    oauthClientId?: string | null;
    clientUserAgent?: string | null;
    occurredAt?: Date;
  }>;
}) {
  if (input.events.length === 0) return { inserted: 0 };
  await db.insert(schema.mcpBridgeEvents).values(
    input.events.map((event) => ({
      ...event,
      toolName: event.toolName ?? null,
      model: event.model ?? null,
      tokensInput: event.tokensInput ?? null,
      tokensOutput: event.tokensOutput ?? null,
      costEstimateUsd: event.costEstimateUsd ?? null,
      oauthClientId: event.oauthClientId ?? null,
      clientUserAgent: event.clientUserAgent ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    })),
  );
  return { inserted: input.events.length };
}

export async function createOAuthAuthorization(input: {
  organizationId: string;
  projectId: string;
  bridgeId: string;
  oauthClientId: string;
  subjectUserId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
  redirectUri: string;
  state?: string | null;
}) {
  const code = `mcp_code_${generateOpaqueToken(32)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const [authorization] = await db
    .insert(schema.mcpOAuthAuthorizations)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      bridgeId: input.bridgeId,
      oauthClientId: input.oauthClientId,
      subjectUserId: input.subjectUserId,
      codeHash: sha256Hex(code),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scopesJson: input.scopes,
      redirectUri: input.redirectUri,
      state: input.state ?? null,
      createdAt: now,
      expiresAt,
    })
    .returning();

  if (!authorization) throw new Error("mcp_oauth_authorization_create_failed");
  return { authorization, code };
}

export async function aggregateBridgeUsage(input: { day?: string } = {}) {
  const day =
    input.day ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await db.execute(sql`
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
  `);

  return { day };
}

export async function revokeTokensForBridge(input: {
  organizationId: string;
  bridgeId: string;
}) {
  const now = new Date();
  await db
    .update(schema.mcpOAuthTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.mcpOAuthTokens.organizationId, input.organizationId),
        eq(schema.mcpOAuthTokens.bridgeId, input.bridgeId),
        sql`${schema.mcpOAuthTokens.revokedAt} is null`,
      ),
    );
  return { revoked: true };
}

export async function validateBridgeOwnership(input: {
  organizationId: string;
  projectId: string;
  bridgeIds: string[];
}) {
  if (input.bridgeIds.length === 0) return [];
  return db
    .select({ id: schema.mcpBridges.id })
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.organizationId, input.organizationId),
        eq(schema.mcpBridges.projectId, input.projectId),
        inArray(schema.mcpBridges.id, input.bridgeIds),
      ),
    );
}

function normalizeCapabilityClasses(input: string[] | undefined) {
  const classes = input?.length ? input : ["read"];
  const normalized = classes.filter((value, index) => {
    return ALLOWED_CAPABILITY_CLASSES.has(value) && classes.indexOf(value) === index;
  });
  return normalized.length > 0 ? normalized : ["read"];
}
