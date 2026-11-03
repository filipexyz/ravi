import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { createHmac } from "node:crypto";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { KnowledgeQuery } from "./query";
import { foldKnowledgeText } from "./text";
import {
  knowledgeKindForOriginKey,
  originKeyPrefixForKind,
  type KnowledgeDbExecutor,
  type KnowledgeSourceKind,
  type KnowledgeTrustTier,
} from "./types";

export type { KnowledgeSourceKind, KnowledgeTrustTier } from "./types";

// Postgres full-text retrieval. Search returns ids and scores only; callers
// then reload the full rows under the same prefilter (canonical reload), so a
// chunk revoked or moved out of scope between the two calls drops out.

const MAX_CANDIDATE_POOL = 80;
const MIN_HMAC_KEY_CHARS = 32;
const ADAPTER = "pg_fts_v1";
const READABLE_DOCUMENT_STATUSES = ["chunked", "indexed"] as const;
const PINNED_DOCUMENT_STATUSES = ["chunked", "indexed", "archived"] as const;

export type KnowledgeSearchScope = {
  organizationId: string;
  /** Projects whose chunks may be returned. */
  projectIds: readonly string[];
  /** Chunks with project_id IS NULL. */
  includeOrgLevel: boolean;
  /** Pinned marks: only these documents (archived allowed). */
  documentIds?: readonly string[];
};

export type KnowledgeSearchFilters = {
  kinds?: readonly KnowledgeSourceKind[];
  /** Documents/chunks recorded at or after. */
  since?: Date | null;
  /** Folded substring of a speaker. */
  who?: string | null;
  projectId?: string | null;
  sourceIds?: readonly string[];
};

export type KnowledgeCandidate = { chunkId: string; score: number; pass: "and" | "or" };

export type KnowledgeChunkRow = {
  chunkId: string;
  organizationId: string;
  projectId: string | null;
  sourceId: string;
  documentId: string;
  kind: KnowledgeSourceKind;
  sourceType: string;
  originKey: string | null;
  sourceTitle: string;
  documentTitle: string;
  documentVersion: number;
  trust: KnowledgeTrustTier;
  text: string;
  textHash: string;
  ordinal: number;
  stableKey: string | null;
  charStart: number | null;
  charEnd: number | null;
  location: JsonRecord;
  metadata: JsonRecord;
  recordedAt: Date;
  sourceRef: JsonRecord;
  /** The source's sensitivity (the project-scoped response still reports it). */
  sensitivity?: string;
};

export type KnowledgeRunInput = {
  organizationId: string;
  projectId: string | null;
  audience: "operator" | "page_viewer" | "contacts";
  status: "completed" | "denied" | "failed";
  actorType: "cli" | "user" | "system" | "anonymous";
  actorId: string | null;
  callerJson: JsonRecord;
  localInstallationId: string | null;
  turnKey: string | null;
  queryText: string | null;
  normalizedQuery: string | null;
  mode: "and" | "or" | null;
  candidateCount: number;
  withheld: Record<string, number>;
  deniedReason: string | null;
  citations: ReadonlyArray<{ rank: number; score: number; row: KnowledgeChunkRow }>;
  durationMs: number;
  requestId: string;
  surface: "cli" | "page_chat" | "console_ui" | "mirror";
  /** Optional facts for `prefilter_json` (never the filter values themselves, except kinds and since). */
  prefilter?: { kinds?: readonly KnowledgeSourceKind[]; since?: Date | null; who?: string | null; projectCount?: number };
};

const chunks = schema.knowledgeChunks;
const documents = schema.knowledgeDocuments;
const sources = schema.knowledgeSources;

const recordedAtSql = sql`coalesce(CASE WHEN (${chunks.locationJson}->>'recordedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (${chunks.locationJson}->>'recordedAt')::timestamptz END, ${documents.createdAt})`;

export async function searchKnowledgeCandidates(
  input: { scope: KnowledgeSearchScope; query: KnowledgeQuery; filters?: KnowledgeSearchFilters; limit: number },
  database: typeof db = db,
): Promise<{ candidates: KnowledgeCandidate[]; mode: "and" | "or" }> {
  const limit = Math.max(1, Math.floor(input.limit));
  const pool = Math.min(limit * 4, MAX_CANDIDATE_POOL);
  const base = knowledgePrefilter(input.scope, input.filters);

  const andHits = await runPass(database, {
    where: base,
    match: sql`(${chunks.searchVector} @@ to_tsquery('simple', ${input.query.simpleAnd}) OR ${chunks.searchVectorStem} @@ to_tsquery('portuguese', ${input.query.stemAnd}))`,
    simple: input.query.simpleAnd,
    stem: input.query.stemAnd,
    limit: pool,
  });
  const candidates: KnowledgeCandidate[] = andHits.map((hit) => ({ ...hit, pass: "and" as const }));
  if (candidates.length >= limit) return { candidates, mode: "and" };

  const seen = candidates.map((candidate) => candidate.chunkId);
  const orHits = await runPass(database, {
    where: seen.length > 0 ? and(base, notInArray(chunks.id, seen)) : base,
    match: sql`(${chunks.searchVector} @@ to_tsquery('simple', ${input.query.simpleOr}) OR ${chunks.searchVectorStem} @@ to_tsquery('portuguese', ${input.query.stemOr}))`,
    simple: input.query.simpleOr,
    stem: input.query.stemOr,
    limit: Math.max(0, pool - candidates.length),
  });
  for (const hit of orHits) candidates.push({ ...hit, pass: "or" });
  return { candidates, mode: andHits.length > 0 ? "and" : "or" };
}

/** Full rows for these ids under the full prefilter, in input order; misses are dropped. */
export async function reloadKnowledgeChunks(
  input: { scope: KnowledgeSearchScope; chunkIds: readonly string[]; filters?: KnowledgeSearchFilters },
  database: typeof db = db,
): Promise<KnowledgeChunkRow[]> {
  const ids = [...new Set(input.chunkIds)].filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await selectChunkRows(database, and(knowledgePrefilter(input.scope, input.filters), inArray(chunks.id, ids)));
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  return input.chunkIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    byId.delete(id);
    return [row];
  });
}

/** The chunk and up to `around` neighbours each side in its document, ordinal order; null when the chunk is not visible. */
export async function readKnowledgeChunkNeighbours(
  input: { scope: KnowledgeSearchScope; chunkId: string; around: number },
  database: typeof db = db,
): Promise<KnowledgeChunkRow[] | null> {
  const [focus] = await reloadKnowledgeChunks({ scope: input.scope, chunkIds: [input.chunkId] }, database);
  if (!focus) return null;
  const around = Math.max(0, Math.min(Math.floor(input.around), 20));
  if (around === 0) return [focus];
  const rows = await selectChunkRows(
    database,
    and(
      knowledgePrefilter(input.scope),
      eq(chunks.documentId, focus.documentId),
      sql`${chunks.chunkOrdinal} BETWEEN ${focus.ordinal - around} AND ${focus.ordinal + around}`,
    ),
    [asc(chunks.chunkOrdinal)],
  );
  return rows.length > 0 ? rows : [focus];
}

/**
 * Records a run and its citations. Runs and citations hold no text: the query
 * text is kept raw only until the 30-day purge, the hash is an HMAC, and each
 * citation keeps ids, rank, score and the chunk's text hash (`excerpt` null).
 */
export async function writeKnowledgeRun(
  input: KnowledgeRunInput,
  executor: KnowledgeDbExecutor = db,
): Promise<{ runId: string }> {
  const [strategy] = await executor
    .select({ id: schema.knowledgeRetrievalStrategies.id })
    .from(schema.knowledgeRetrievalStrategies)
    .where(
      and(
        eq(schema.knowledgeRetrievalStrategies.organizationId, input.organizationId),
        eq(schema.knowledgeRetrievalStrategies.projectScope, "*"),
        eq(schema.knowledgeRetrievalStrategies.key, "lexical-v1"),
      ),
    )
    .limit(1);

  const citations = input.status === "completed" ? input.citations : [];
  const withheldCount = Object.values(input.withheld).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  const [run] = await executor
    .insert(schema.knowledgeRetrievalRuns)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      strategyId: strategy?.id ?? null,
      actorType: input.actorType,
      actorId: input.actorId,
      status: input.status,
      queryText: input.queryText,
      queryHash: knowledgeQueryHash(input.normalizedQuery),
      normalizedQuery: input.normalizedQuery,
      audience: input.audience,
      callerJson: input.callerJson,
      deniedJson: { count: withheldCount, reasons: input.withheld },
      localInstallationId: input.localInstallationId,
      turnKey: input.turnKey,
      requestedScopeJson: { schemaVersion: 1, surface: input.surface },
      prefilterJson: {
        adapter: ADAPTER,
        mode: input.mode,
        kinds: input.prefilter?.kinds ? [...input.prefilter.kinds] : null,
        since: input.prefilter?.since ? input.prefilter.since.toISOString() : null,
        who: Boolean(input.prefilter?.who),
        projectCount: input.prefilter?.projectCount ?? null,
      },
      postfilterJson: { schemaVersion: 1, returnedChunkCount: citations.length, withheld: withheldCount },
      candidateCount: input.candidateCount,
      returnedChunkCount: citations.length,
      deniedReason: input.deniedReason,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      safeMetadataJson: { schemaVersion: 1, surface: input.surface, requestId: input.requestId },
    })
    .returning({ id: schema.knowledgeRetrievalRuns.id });
  if (!run) throw new Error("Failed to record the knowledge retrieval run.");

  if (citations.length > 0) {
    await executor.insert(schema.knowledgeCitations).values(
      citations.map((citation) => ({
        organizationId: input.organizationId,
        projectId: citation.row.projectId,
        retrievalRunId: run.id,
        sourceId: citation.row.sourceId,
        documentId: citation.row.documentId,
        chunkId: citation.row.chunkId,
        rank: citation.rank,
        score: Number.isFinite(citation.score) ? citation.score.toFixed(6) : null,
        excerpt: null,
        textHash: citation.row.textHash,
        documentVersion: citation.row.documentVersion,
        charStart: citation.row.charStart,
        charEnd: citation.row.charEnd,
        trustTier: citation.row.trust,
        citationJson: {
          kind: citation.row.kind,
          sourceTitle: citation.row.sourceTitle,
          documentTitle: citation.row.documentTitle,
          location: citation.row.location,
        },
      })),
    );
  }
  return { runId: run.id };
}

let warnedMissingHmacKey = false;

/** HMAC-SHA256 of the normalized query with RAVI_KNOWLEDGE_QUERY_HMAC_KEY, hex; null without a key. */
export function knowledgeQueryHash(
  normalizedQuery: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!normalizedQuery) return null;
  const key = env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY?.trim();
  if (!key || key.length < MIN_HMAC_KEY_CHARS) {
    if (!warnedMissingHmacKey) {
      warnedMissingHmacKey = true;
      console.warn("[knowledge] RAVI_KNOWLEDGE_QUERY_HMAC_KEY is unset or shorter than 32 chars; query_hash is null.");
    }
    return null;
  }
  return createHmac("sha256", key).update(normalizedQuery).digest("hex");
}

/** The prefilter shared by search, reload and neighbours, plus the optional filters. */
export function knowledgePrefilter(scope: KnowledgeSearchScope, filters?: KnowledgeSearchFilters): SQL {
  const projectIds = [...new Set(scope.projectIds)].filter(isUuid);
  const projectScope = or(
    projectIds.length > 0 ? inArray(chunks.projectId, projectIds) : sql`false`,
    scope.includeOrgLevel ? isNull(chunks.projectId) : sql`false`,
  );
  const documentIds = scope.documentIds ? [...new Set(scope.documentIds)].filter(isUuid) : null;
  const documentScope = documentIds
    ? documentIds.length > 0
      ? and(inArray(documents.id, documentIds), inArray(documents.status, [...PINNED_DOCUMENT_STATUSES]))
      : sql`false`
    : inArray(documents.status, [...READABLE_DOCUMENT_STATUSES]);

  const conditions: Array<SQL | undefined> = [
    eq(chunks.organizationId, scope.organizationId),
    projectScope,
    eq(chunks.status, "active"),
    eq(sources.status, "active"),
    documentScope,
  ];

  if (filters?.kinds && filters.kinds.length > 0) {
    const kinds = [...new Set(filters.kinds)];
    conditions.push(
      or(
        ...kinds.map((kind) => {
          const prefix = originKeyPrefixForKind(kind);
          return prefix ? sql`${sources.originKey} LIKE ${`${prefix}%`}` : isNull(sources.originKey);
        }),
      ),
    );
  }
  if (filters?.since) conditions.push(sql`${recordedAtSql} >= ${filters.since.toISOString()}::timestamptz`);
  const who = filters?.who ? foldKnowledgeText(filters.who) : "";
  if (who) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${chunks.safeMetadataJson}->'speakersFolded') = 'array' THEN ${chunks.safeMetadataJson}->'speakersFolded' ELSE '[]'::jsonb END) AS speaker(name) WHERE speaker.name LIKE ${`%${who}%`})`,
    );
  }
  if (filters?.projectId) conditions.push(eq(chunks.projectId, filters.projectId));
  if (filters?.sourceIds && filters.sourceIds.length > 0) {
    const sourceIds = [...new Set(filters.sourceIds)].filter(isUuid);
    conditions.push(sourceIds.length > 0 ? inArray(chunks.sourceId, sourceIds) : sql`false`);
  }
  return and(...conditions) ?? sql`false`;
}

async function runPass(
  database: typeof db,
  input: { where: SQL | undefined; match: SQL; simple: string; stem: string; limit: number },
): Promise<Array<{ chunkId: string; score: number }>> {
  if (input.limit <= 0) return [];
  const score = sql<number>`(coalesce(ts_rank_cd(${chunks.searchVector}, to_tsquery('simple', ${input.simple})), 0) + 0.5 * coalesce(ts_rank_cd(${chunks.searchVectorStem}, to_tsquery('portuguese', ${input.stem})), 0) + 0.15 * exp(-greatest(extract(epoch from (now() - ${recordedAtSql})), 0) / 86400.0 / 90.0) + CASE WHEN ${chunks.trustTier} = 'approved' THEN 0.05 ELSE 0 END)::float8`;
  const rows = await database
    .select({ chunkId: chunks.id, score })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .innerJoin(sources, eq(chunks.sourceId, sources.id))
    .where(and(input.where, input.match))
    .orderBy(desc(score), desc(documents.createdAt), asc(chunks.chunkOrdinal))
    .limit(input.limit);
  return rows.map((row) => ({ chunkId: row.chunkId, score: roundScore(Number(row.score)) }));
}

async function selectChunkRows(database: typeof db, where: SQL | undefined, orderBy: SQL[] = []): Promise<KnowledgeChunkRow[]> {
  const query = database
    .select({
      chunkId: chunks.id,
      organizationId: chunks.organizationId,
      projectId: chunks.projectId,
      sourceId: chunks.sourceId,
      documentId: chunks.documentId,
      sourceType: sources.sourceType,
      originKey: sources.originKey,
      sourceTitle: sources.title,
      sensitivity: sources.sensitivity,
      sourceRef: sources.sourceRefJson,
      documentTitle: documents.title,
      documentVersion: documents.versionNumber,
      trust: chunks.trustTier,
      text: chunks.text,
      textHash: chunks.textHash,
      ordinal: chunks.chunkOrdinal,
      stableKey: chunks.stableKey,
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
      location: chunks.locationJson,
      metadata: chunks.safeMetadataJson,
      recordedAt: sql<string>`${recordedAtSql}`,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .innerJoin(sources, eq(chunks.sourceId, sources.id))
    .where(where);
  const rows = orderBy.length > 0 ? await query.orderBy(...orderBy) : await query;
  return rows.map((row) => ({
    chunkId: row.chunkId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    sourceId: row.sourceId,
    documentId: row.documentId,
    kind: knowledgeKindForOriginKey(row.originKey),
    sourceType: row.sourceType,
    originKey: row.originKey,
    sourceTitle: row.sourceTitle,
    documentTitle: row.documentTitle,
    documentVersion: row.documentVersion,
    trust: row.trust,
    text: row.text,
    textHash: row.textHash,
    ordinal: row.ordinal,
    stableKey: row.stableKey,
    charStart: row.charStart,
    charEnd: row.charEnd,
    location: record(row.location),
    metadata: record(row.metadata),
    recordedAt: toDate(row.recordedAt),
    sourceRef: record(row.sourceRef),
    sensitivity: row.sensitivity,
  }));
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function roundScore(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
