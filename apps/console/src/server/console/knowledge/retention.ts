import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { listMarkedRoutes, type MarkedRoute } from "./marks";
import { deleteKnowledgeSourceContent } from "./producer";
import { purgedProposalBody } from "./proposal-body";

// The Console's retention rows (CONTRACT §14), run by the tick. Runs keep
// their raw query 30 days and live 13 months; sources past `retain_until`
// (meeting transcripts, by project months) lose their content; archived
// document versions go after 90 days unless a route mark pins them; pending
// proposals expire, and proposal bodies are purged (an expired proposal at
// once, a gap or transcript 30 days after it closed); finished jobs go after 90
// days. Every step is bounded so one tick never runs away.

const DAY_MS = 24 * 3600 * 1000;
const QUERY_TEXT_DAYS = 30;
const RUN_MONTHS = 13;
const ARCHIVED_DOCUMENT_DAYS = 90;
const FINISHED_JOB_DAYS = 90;
const CLOSED_PROPOSAL_BODY_DAYS = 30;
const SOURCES_PER_TICK = 100;
const DOCUMENTS_PER_TICK = 500;
const ROWS_PER_TICK = 5000;

export type KnowledgeRetentionResult = {
  queryTexts: number;
  runs: number;
  meetingSources: number;
  archivedDocuments: number;
  proposalsExpired: number;
  proposalBodies: number;
  jobs: number;
};

export type KnowledgeRetentionCutoffs = {
  queryText: Date;
  runs: Date;
  archivedDocuments: Date;
  finishedJobs: Date;
  closedProposalBodies: Date;
};

/** Rows older than each cutoff go: query text 30 days, runs 13 calendar months, archived documents and finished jobs 90 days. */
export function knowledgeRetentionCutoffs(now: Date): KnowledgeRetentionCutoffs {
  const runs = new Date(now);
  runs.setUTCMonth(runs.getUTCMonth() - RUN_MONTHS);
  return {
    queryText: new Date(now.getTime() - QUERY_TEXT_DAYS * DAY_MS),
    runs,
    archivedDocuments: new Date(now.getTime() - ARCHIVED_DOCUMENT_DAYS * DAY_MS),
    finishedJobs: new Date(now.getTime() - FINISHED_JOB_DAYS * DAY_MS),
    closedProposalBodies: new Date(now.getTime() - CLOSED_PROPOSAL_BODY_DAYS * DAY_MS),
  };
}

/** Archived documents no mark pins, in any state: a suspended mark still points at its approved version. */
export function unpinnedArchivedDocuments(archived: Array<{ id: string }>, marked: Array<Pick<MarkedRoute, "mark">>): string[] {
  const pinned = new Set(marked.map((route) => route.mark.approvedDocumentId));
  return archived.filter((document) => !pinned.has(document.id)).map((document) => document.id);
}

export async function runKnowledgeRetention(
  input: { requestId: string; now?: () => Date; outOfBudget?: () => boolean },
  deps: { listMarkedRoutes?: typeof listMarkedRoutes; deleteSourceContent?: typeof deleteKnowledgeSourceContent } = {},
): Promise<KnowledgeRetentionResult> {
  const now = (input.now ?? (() => new Date()))();
  const cutoffs = knowledgeRetentionCutoffs(now);
  const outOfBudget = input.outOfBudget ?? (() => false);
  const result: KnowledgeRetentionResult = {
    queryTexts: 0,
    runs: 0,
    meetingSources: 0,
    archivedDocuments: 0,
    proposalsExpired: 0,
    proposalBodies: 0,
    jobs: 0,
  };
  const runs = schema.knowledgeRetrievalRuns;

  // Raw query text, and its normalized form, which still reads as the query: 30 days.
  result.queryTexts = await updateBatch(
    sql`UPDATE ${runs} SET query_text = NULL, normalized_query = NULL WHERE id IN (
      SELECT id FROM ${runs} WHERE (query_text IS NOT NULL OR normalized_query IS NOT NULL)
        AND created_at < ${cutoffs.queryText.toISOString()}::timestamptz LIMIT ${ROWS_PER_TICK}
    ) RETURNING id`,
  );
  if (outOfBudget()) return result;

  // Runs: 13 months; citations cascade.
  result.runs = await updateBatch(
    sql`DELETE FROM ${runs} WHERE id IN (
      SELECT id FROM ${runs} WHERE created_at < ${cutoffs.runs.toISOString()}::timestamptz LIMIT ${ROWS_PER_TICK}
    ) RETURNING id`,
  );
  if (outOfBudget()) return result;

  // Sources past retain_until (meeting transcripts, approved transcripts): content deleted, source kept as `deleted`.
  const expired = await db
    .select({ id: schema.knowledgeSources.id, organizationId: schema.knowledgeSources.organizationId })
    .from(schema.knowledgeSources)
    .where(
      and(
        isNotNull(schema.knowledgeSources.retainUntil),
        lt(schema.knowledgeSources.retainUntil, now),
        ne(schema.knowledgeSources.status, "deleted"),
      ),
    )
    .orderBy(asc(schema.knowledgeSources.retainUntil))
    .limit(SOURCES_PER_TICK);
  const deleteSourceContent = deps.deleteSourceContent ?? deleteKnowledgeSourceContent;
  for (const source of expired) {
    if (outOfBudget()) return result;
    await deleteSourceContent({
      organizationId: source.organizationId,
      sourceId: source.id,
      actor: { type: "system", id: null },
      reason: "retention",
      requestId: input.requestId,
    });
    result.meetingSources += 1;
  }
  if (outOfBudget()) return result;

  // Archived versions after 90 days, unless a mark (in any state) pins them.
  const archived = await db
    .select({ id: schema.knowledgeDocuments.id, organizationId: schema.knowledgeDocuments.organizationId })
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.status, "archived"),
        lt(schema.knowledgeDocuments.updatedAt, cutoffs.archivedDocuments),
      ),
    )
    .orderBy(asc(schema.knowledgeDocuments.updatedAt))
    .limit(DOCUMENTS_PER_TICK);
  if (archived.length) {
    const marked: MarkedRoute[] = [];
    const list = deps.listMarkedRoutes ?? listMarkedRoutes;
    for (const organizationId of new Set(archived.map((document) => document.organizationId))) {
      marked.push(...(await list({ organizationId, state: "any" })));
    }
    const doomed = unpinnedArchivedDocuments(archived, marked);
    if (doomed.length) {
      // Chunks and snapshots cascade from their document; citations keep their rows with null ids.
      const deleted = await db
        .delete(schema.knowledgeDocuments)
        .where(and(inArray(schema.knowledgeDocuments.id, doomed), eq(schema.knowledgeDocuments.status, "archived")))
        .returning({ id: schema.knowledgeDocuments.id });
      result.archivedDocuments = deleted.length;
    }
  }
  if (outOfBudget()) return result;

  // Pending proposals past their expiry: nobody decided them, so their bodies go with them.
  const expiredProposals = await db
    .update(schema.knowledgeProposals)
    .set({ status: "expired", ...purgedProposalBody(), updatedAt: now })
    .where(and(eq(schema.knowledgeProposals.status, "pending"), lt(schema.knowledgeProposals.expiresAt, now)))
    .returning({ id: schema.knowledgeProposals.id });
  result.proposalsExpired = expiredProposals.length;
  if (outOfBudget()) return result;

  // Gap and transcript bodies 30 days after they closed (a contact's words; a whole meeting).
  const proposals = schema.knowledgeProposals;
  const purgedBodies = await db
    .update(proposals)
    .set({ ...purgedProposalBody(), updatedAt: now })
    .where(
      and(
        inArray(proposals.kind, ["gap", "transcript"]),
        ne(proposals.status, "pending"),
        isNotNull(proposals.body),
        sql`coalesce(${proposals.decidedAt}, ${proposals.updatedAt}) < ${cutoffs.closedProposalBodies.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: proposals.id });
  result.proposalBodies = purgedBodies.length;
  if (outOfBudget()) return result;

  // Finished jobs after 90 days.
  const jobs = schema.knowledgeIngestionJobs;
  result.jobs = await updateBatch(
    sql`DELETE FROM ${jobs} WHERE id IN (
      SELECT id FROM ${jobs} WHERE status IN ('completed', 'canceled')
        AND coalesce(finished_at, updated_at) < ${cutoffs.finishedJobs.toISOString()}::timestamptz LIMIT ${ROWS_PER_TICK}
    ) RETURNING id`,
  );
  return result;
}

async function updateBatch(statement: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(statement);
  if (Array.isArray(result)) return result.length;
  const count = (result as { count?: unknown; rowCount?: unknown }).count ?? (result as { rowCount?: unknown }).rowCount;
  return typeof count === "number" ? count : 0;
}
