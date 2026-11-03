import { and, desc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/server/db";

const DEFAULT_CANDIDATE_LIMIT = 8;
const MAX_CANDIDATE_LIMIT = 50;
const DEFAULT_SCAN_LIMIT = 500;
const MAX_SCAN_LIMIT = 2000;

export type KnowledgeIndexSearchInput = {
  organizationId: string;
  projectId: string;
  query: string;
  limit?: number;
  scanLimit?: number;
  sourceIds?: string[];
};

export type KnowledgeIndexCandidateRow = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  projectId: string;
  permissionSnapshotId: string;
  permissionSnapshotHash: string;
  permissionPolicy: Record<string, unknown>;
  sourceTitle: string;
  documentTitle: string;
  sensitivity: string;
  text: string;
  textHash: string;
  tokenCount: number | null;
  location: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type KnowledgeIndexCandidate = KnowledgeIndexCandidateRow & {
  rank: number;
  score: number;
};

export type KnowledgeIndexAdapter = {
  searchCandidates(input: KnowledgeIndexSearchInput): Promise<KnowledgeIndexCandidate[]>;
};

export function createDbLexicalKnowledgeIndexAdapter(
  database: Pick<typeof db, "select"> = db,
): KnowledgeIndexAdapter {
  return {
    async searchCandidates(input) {
      const query = normalizeSearchText(input.query);
      if (!query) return [];

      const sourceIds = normalizeSourceIds(input.sourceIds);
      const filters = [
        eq(schema.knowledgeChunks.organizationId, input.organizationId),
        eq(schema.knowledgeChunks.projectId, input.projectId),
        eq(schema.knowledgeChunks.status, "active"),
        eq(schema.knowledgeSources.status, "active"),
        eq(schema.knowledgeDocuments.status, "chunked"),
      ];
      if (sourceIds.length > 0) filters.push(inArray(schema.knowledgeChunks.sourceId, sourceIds));

      const rows = await database
        .select({
          chunkId: schema.knowledgeChunks.id,
          documentId: schema.knowledgeChunks.documentId,
          sourceId: schema.knowledgeChunks.sourceId,
          projectId: schema.knowledgeChunks.projectId,
          permissionSnapshotId: schema.knowledgeChunks.permissionSnapshotId,
          permissionSnapshotHash: schema.knowledgePermissionSnapshots.snapshotHash,
          permissionPolicy: schema.knowledgePermissionSnapshots.policyJson,
          sourceTitle: schema.knowledgeSources.title,
          documentTitle: schema.knowledgeDocuments.title,
          sensitivity: schema.knowledgeSources.sensitivity,
          text: schema.knowledgeChunks.text,
          textHash: schema.knowledgeChunks.textHash,
          tokenCount: schema.knowledgeChunks.tokenCount,
          location: schema.knowledgeChunks.locationJson,
          metadata: schema.knowledgeChunks.safeMetadataJson,
          updatedAt: schema.knowledgeChunks.updatedAt,
        })
        .from(schema.knowledgeChunks)
        .innerJoin(schema.knowledgeSources, eq(schema.knowledgeChunks.sourceId, schema.knowledgeSources.id))
        .innerJoin(schema.knowledgeDocuments, eq(schema.knowledgeChunks.documentId, schema.knowledgeDocuments.id))
        .innerJoin(
          schema.knowledgePermissionSnapshots,
          eq(schema.knowledgeChunks.permissionSnapshotId, schema.knowledgePermissionSnapshots.id),
        )
        .where(and(...filters))
        .orderBy(desc(schema.knowledgeChunks.updatedAt))
        .limit(clampPositiveInteger(input.scanLimit, DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT));

      return rankKnowledgeCandidates(
        rows.map((row) => ({
          chunkId: row.chunkId,
          documentId: row.documentId,
          sourceId: row.sourceId,
          projectId: row.projectId ?? input.projectId,
          permissionSnapshotId: row.permissionSnapshotId,
          permissionSnapshotHash: row.permissionSnapshotHash,
          permissionPolicy: record(row.permissionPolicy),
          sourceTitle: row.sourceTitle,
          documentTitle: row.documentTitle,
          sensitivity: row.sensitivity,
          text: row.text,
          textHash: row.textHash,
          tokenCount: row.tokenCount,
          location: record(row.location),
          metadata: record(row.metadata),
        })),
        input.query,
        { limit: input.limit },
      );
    },
  };
}

export function rankKnowledgeCandidates(
  rows: KnowledgeIndexCandidateRow[],
  query: string,
  options: { limit?: number } = {},
): KnowledgeIndexCandidate[] {
  const limit = clampPositiveInteger(options.limit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT);
  return rows
    .map((row) => ({
      row,
      score: scoreKnowledgeCandidateText(query, row.text),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.row.chunkId.localeCompare(right.row.chunkId);
    })
    .slice(0, limit)
    .map((candidate, index) => ({
      ...candidate.row,
      rank: index + 1,
      score: candidate.score,
    }));
}

export function scoreKnowledgeCandidateText(query: string, text: string): number {
  const queryTokens = uniqueTokens(query);
  if (queryTokens.length === 0) return 0;

  const textTokens = tokens(text);
  if (textTokens.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of textTokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  let matched = 0;
  let frequencyScore = 0;
  for (const token of queryTokens) {
    const count = counts.get(token) ?? 0;
    if (count > 0) matched += 1;
    frequencyScore += Math.min(count, 4);
  }
  if (matched === 0) return 0;

  const normalizedQuery = normalizeSearchText(query);
  const normalizedText = normalizeSearchText(text);
  const phraseScore = normalizedQuery && normalizedText.includes(normalizedQuery) ? 8 + queryTokens.length : 0;
  const coverageScore = (matched / queryTokens.length) * 5;
  const densityScore = frequencyScore / Math.max(1, Math.sqrt(textTokens.length));

  return roundScore(phraseScore + coverageScore + densityScore);
}

export function uniqueTokens(value: string): string[] {
  return [...new Set(tokens(value))];
}

function tokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeSourceIds(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function clampPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
