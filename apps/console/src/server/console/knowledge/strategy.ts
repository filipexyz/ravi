import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

const INDEX_KEY = "fts-v1";
const STRATEGY_KEY = "lexical-v1";
const STRATEGY_PROJECT_SCOPE = "*";

/**
 * The org's `fts-v1` index row and `lexical-v1` strategy row, created lazily.
 * `createdNow` is true only for the call that created the strategy: the org
 * never searched before, so the caller starts the first-search backfill.
 */
export async function ensureKnowledgeStrategy(
  organizationId: string,
  database: typeof db = db,
): Promise<{ indexId: string; strategyId: string; createdNow: boolean }> {
  const [existing] = await database
    .select({ strategyId: schema.knowledgeRetrievalStrategies.id, indexId: schema.knowledgeRetrievalStrategies.indexId })
    .from(schema.knowledgeRetrievalStrategies)
    .where(
      and(
        eq(schema.knowledgeRetrievalStrategies.organizationId, organizationId),
        eq(schema.knowledgeRetrievalStrategies.projectScope, STRATEGY_PROJECT_SCOPE),
        eq(schema.knowledgeRetrievalStrategies.key, STRATEGY_KEY),
      ),
    )
    .limit(1);
  if (existing?.indexId) return { indexId: existing.indexId, strategyId: existing.strategyId, createdNow: false };

  const [index] = await database
    .insert(schema.knowledgeIndexes)
    .values({
      organizationId,
      key: INDEX_KEY,
      label: "Postgres full text v1",
      backend: "postgres_fts",
    })
    .onConflictDoUpdate({
      target: [schema.knowledgeIndexes.organizationId, schema.knowledgeIndexes.key],
      set: { updatedAt: sql`${schema.knowledgeIndexes.updatedAt}` },
    })
    .returning({ id: schema.knowledgeIndexes.id });
  if (!index) throw new Error("Failed to ensure the knowledge index.");

  const [created] = await database
    .insert(schema.knowledgeRetrievalStrategies)
    .values({
      organizationId,
      projectScope: STRATEGY_PROJECT_SCOPE,
      indexId: index.id,
      key: STRATEGY_KEY,
      label: "Lexical v1",
      pipelineJson: { builder: "knowledge-query-v1", passes: ["and", "or"], configs: ["simple", "portuguese"] },
    })
    .onConflictDoNothing()
    .returning({ id: schema.knowledgeRetrievalStrategies.id });
  if (created) return { indexId: index.id, strategyId: created.id, createdNow: true };

  // A concurrent first search created it, or an older row lacked its index.
  const [row] = await database
    .update(schema.knowledgeRetrievalStrategies)
    .set({ indexId: index.id, updatedAt: new Date() })
    .where(
      and(
        eq(schema.knowledgeRetrievalStrategies.organizationId, organizationId),
        eq(schema.knowledgeRetrievalStrategies.projectScope, STRATEGY_PROJECT_SCOPE),
        eq(schema.knowledgeRetrievalStrategies.key, STRATEGY_KEY),
      ),
    )
    .returning({ id: schema.knowledgeRetrievalStrategies.id });
  if (!row) throw new Error("Failed to ensure the knowledge retrieval strategy.");
  return { indexId: index.id, strategyId: row.id, createdNow: false };
}
