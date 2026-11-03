// Reads the Console screens need beside the contract routes: the project's
// Library agents a person can deploy, and the HEARTBEAT.md a schedule without
// a prompt runs.

import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { assertCloudAgentsEnabled, type CloudContext, requireCloudProject } from "./access";
import { deployedAgentFiles, loadAgentForCaller } from "./deploy";

export type CloudLibraryAgent = {
  itemId: string;
  slug: string;
  name: string;
  description: string;
  /** `org`, or the slug of the project that owns it. */
  scope: string;
  version: number;
  /** The cloud agent deployed from it in this project, if any. */
  deployed: { agentId: string; version: number | null } | null;
};

const HEARTBEAT_MAX_CHARS = 20_000;

/** Published Library agents visible in the project (its own and the organization's), newest version each. */
export async function listDeployableLibraryAgents(ctx: CloudContext, projectRef: unknown): Promise<{ agents: CloudLibraryAgent[] }> {
  await assertCloudAgentsEnabled(ctx);
  const project = await requireCloudProject(ctx.workspace, projectRef, "read");
  const rows = await db
    .select({ item: schema.libraryItems, projectSlug: schema.projects.slug })
    .from(schema.libraryItems)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.libraryItems.projectId))
    .where(
      and(
        eq(schema.libraryItems.organizationId, ctx.workspace.organization.id),
        eq(schema.libraryItems.kind, "agent"),
        isNull(schema.libraryItems.archivedAt),
        isNotNull(schema.libraryItems.currentVersionNumber),
        or(isNull(schema.libraryItems.projectId), eq(schema.libraryItems.projectId, project.id)),
      ),
    )
    .orderBy(asc(schema.libraryItems.name));
  const deployed = await db
    .select({ id: schema.cloudAgents.id, itemId: schema.cloudAgents.libraryItemId, version: schema.cloudAgents.libraryVersionNumber })
    .from(schema.cloudAgents)
    .where(and(eq(schema.cloudAgents.projectId, project.id), ne(schema.cloudAgents.status, "archived")));
  const byItem = new Map(deployed.map((row) => [row.itemId, row]));
  return {
    agents: rows.map(({ item, projectSlug }) => {
      const agent = byItem.get(item.id);
      return {
        itemId: item.id,
        slug: item.slug,
        name: item.name,
        description: item.description,
        scope: projectSlug ?? "org",
        version: item.currentVersionNumber ?? 0,
        deployed: agent ? { agentId: agent.id, version: agent.version } : null,
      };
    }),
  };
}

/** The deployed version's HEARTBEAT.md, or null when the agent has none. */
export async function getCloudAgentHeartbeat(ctx: CloudContext, agentId: string): Promise<{ heartbeat: string | null }> {
  await assertCloudAgentsEnabled(ctx);
  const row = await loadAgentForCaller(ctx, agentId, "read");
  const files = await deployedAgentFiles(row);
  const heartbeat = files.find((file) => file.path === "HEARTBEAT.md")?.content.trim();
  return { heartbeat: heartbeat ? heartbeat.slice(0, HEARTBEAT_MAX_CHARS) : null };
}
