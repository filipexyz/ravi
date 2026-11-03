import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

export type McpBridgeListItem = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: string;
  allowedCapabilityClasses: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  calls24h: number;
  costEstimate24hUsd: string;
};

export type McpBridgeDetail = McpBridgeListItem & {
  sessionRef: string;
  channelId: string;
  cachedTools: Record<string, unknown> | null;
  cachedToolsAt: string | null;
  clients: McpOAuthClientSummary[];
  recentEvents: McpBridgeEventSummary[];
  usage: McpBridgeUsageSummary[];
};

export type McpOAuthClientSummary = {
  id: string;
  clientId: string;
  clientName: string;
  softwareId: string | null;
  softwareVersion: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export type McpBridgeEventSummary = {
  id: string;
  eventType: string;
  toolName: string | null;
  model: string | null;
  durationMs: number;
  statusClass: string;
  requestId: string;
  oauthClientId: string | null;
  occurredAt: string;
};

export type McpBridgeUsageSummary = {
  day: string;
  callsTotal: number;
  callsOk: number;
  callsError: number;
  tokensInputTotal: number;
  tokensOutputTotal: number;
  costEstimateTotalUsd: string;
  uniqueClients: number;
  daemonOfflineCount: number;
};

export async function listBridges(input: {
  organizationId: string;
  projectId: string;
}): Promise<McpBridgeListItem[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      bridge: schema.mcpBridges,
      calls24h: sql<number>`coalesce(count(${schema.mcpBridgeEvents.id}), 0)::int`,
      costEstimate24hUsd: sql<string>`coalesce(sum(${schema.mcpBridgeEvents.costEstimateUsd}), 0)::text`,
    })
    .from(schema.mcpBridges)
    .leftJoin(
      schema.mcpBridgeEvents,
      and(
        eq(schema.mcpBridgeEvents.bridgeId, schema.mcpBridges.id),
        gte(schema.mcpBridgeEvents.occurredAt, since),
      ),
    )
    .where(
      and(
        eq(schema.mcpBridges.organizationId, input.organizationId),
        eq(schema.mcpBridges.projectId, input.projectId),
      ),
    )
    .groupBy(schema.mcpBridges.id)
    .orderBy(desc(schema.mcpBridges.updatedAt));

  return rows.map(({ bridge, calls24h, costEstimate24hUsd }) =>
    bridgeToListItem(bridge, calls24h, costEstimate24hUsd),
  );
}

export async function getBridge(input: {
  organizationId: string;
  projectId?: string;
  bridgeId: string;
}): Promise<McpBridgeDetail | null> {
  const [bridge] = await db
    .select()
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.id, input.bridgeId),
        eq(schema.mcpBridges.organizationId, input.organizationId),
        ...(input.projectId ? [eq(schema.mcpBridges.projectId, input.projectId)] : []),
      ),
    )
    .limit(1);

  if (!bridge) return null;

  const [clients, events, usage, listItem] = await Promise.all([
    listBridgeOAuthClients({ organizationId: input.organizationId, bridgeId: bridge.id }),
    listBridgeEvents({ organizationId: input.organizationId, bridgeId: bridge.id, limit: 50 }),
    listBridgeUsage({ organizationId: input.organizationId, bridgeId: bridge.id, days: 30 }),
    listBridges({ organizationId: input.organizationId, projectId: bridge.projectId }).then(
      (items) => items.find((item) => item.id === bridge.id) ?? bridgeToListItem(bridge, 0, "0"),
    ),
  ]);

  return {
    ...listItem,
    sessionRef: bridge.sessionRef,
    channelId: bridge.channelId,
    cachedTools: bridge.cachedToolsJson ?? null,
    cachedToolsAt: bridge.cachedToolsAt?.toISOString() ?? null,
    clients,
    recentEvents: events,
    usage,
  };
}

export async function listBridgeOAuthClients(input: {
  organizationId: string;
  bridgeId: string;
}): Promise<McpOAuthClientSummary[]> {
  const rows = await db
    .select()
    .from(schema.mcpOAuthClients)
    .where(
      and(
        eq(schema.mcpOAuthClients.organizationId, input.organizationId),
        eq(schema.mcpOAuthClients.bridgeId, input.bridgeId),
      ),
    )
    .orderBy(desc(schema.mcpOAuthClients.createdAt));

  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    softwareId: row.softwareId,
    softwareVersion: row.softwareVersion,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function listBridgeEvents(input: {
  organizationId: string;
  bridgeId: string;
  limit?: number;
}): Promise<McpBridgeEventSummary[]> {
  const rows = await db
    .select()
    .from(schema.mcpBridgeEvents)
    .where(
      and(
        eq(schema.mcpBridgeEvents.organizationId, input.organizationId),
        eq(schema.mcpBridgeEvents.bridgeId, input.bridgeId),
      ),
    )
    .orderBy(desc(schema.mcpBridgeEvents.occurredAt))
    .limit(input.limit ?? 50);

  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    toolName: row.toolName,
    model: row.model,
    durationMs: row.durationMs,
    statusClass: row.statusClass,
    requestId: row.requestId,
    oauthClientId: row.oauthClientId,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

export async function listBridgeUsage(input: {
  organizationId: string;
  bridgeId: string;
  days?: number;
}): Promise<McpBridgeUsageSummary[]> {
  const since = new Date(Date.now() - (input.days ?? 30) * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(schema.mcpBridgeUsage)
    .where(
      and(
        eq(schema.mcpBridgeUsage.organizationId, input.organizationId),
        eq(schema.mcpBridgeUsage.bridgeId, input.bridgeId),
        gte(schema.mcpBridgeUsage.day, since.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(desc(schema.mcpBridgeUsage.day));

  return rows.map((row) => ({
    day: row.day,
    callsTotal: row.callsTotal,
    callsOk: row.callsOk,
    callsError: row.callsError,
    tokensInputTotal: row.tokensInputTotal,
    tokensOutputTotal: row.tokensOutputTotal,
    costEstimateTotalUsd: row.costEstimateTotalUsd,
    uniqueClients: row.uniqueClients,
    daemonOfflineCount: row.daemonOfflineCount,
  }));
}

function bridgeToListItem(
  bridge: typeof schema.mcpBridges.$inferSelect,
  calls24h: number,
  costEstimate24hUsd: string,
): McpBridgeListItem {
  return {
    id: bridge.id,
    projectId: bridge.projectId,
    name: bridge.name,
    description: bridge.description,
    status: bridge.status,
    allowedCapabilityClasses: bridge.allowedCapabilityClassesJson,
    createdAt: bridge.createdAt.toISOString(),
    updatedAt: bridge.updatedAt.toISOString(),
    lastUsedAt: bridge.lastUsedAt?.toISOString() ?? null,
    expiresAt: bridge.expiresAt?.toISOString() ?? null,
    calls24h,
    costEstimate24hUsd,
  };
}
