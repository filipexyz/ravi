import { eq } from "drizzle-orm";
import { z } from "zod";

import type {
  KnowledgeRetrievalCitationSummary,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalRunSummary,
} from "@/features/console/types";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { assertProjectAccess, findAccessibleProjectRecord } from "../project-access";
import { buildKnowledgeQuery } from "./query";
import {
  reloadKnowledgeChunks,
  searchKnowledgeCandidates,
  writeKnowledgeRun,
  type KnowledgeChunkRow,
} from "./retrieval-core";
import { scheduleKnowledgeBackfill } from "./schedule";
import { ensureKnowledgeStrategy } from "./strategy";
import { neutralizeKnowledgeText } from "./text";

const MAX_RETRIEVAL_BODY_BYTES = 32 * 1024;
const MAX_QUERY_LENGTH = 2000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const SOURCE = "console.knowledge.retrieval";

type KnowledgeWorkspace = {
  mode: import("@/lib/auth/session").ConsoleAuthState["mode"];
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

export type RetrieveKnowledgeInput = {
  limit: number;
  metadata: Record<string, unknown>;
  query: string;
  sourceIds: string[];
  strategyKey: string;
};

const retrievalBodySchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  sourceIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  strategyKey: z.string().trim().min(1).max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function retrieveKnowledge({
  body,
  deps = {},
  projectRef,
  requestId,
  surface = "console_ui",
  workspace,
}: {
  body: unknown;
  /** Defaults to `scheduleKnowledgeBackfill` (runs after the response). */
  deps?: { scheduleBackfill?: (input: { organizationId: string; requestId: string }) => void };
  projectRef: string;
  requestId: string;
  surface?: "cli" | "console_ui";
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeRetrievalResult> {
  const parsed = parseRetrieveKnowledgeBody(body);
  const project = await findAccessibleProjectRecord(workspace, projectRef, "read");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  await assertProjectAccess(workspace, project.id, "read");

  const query = buildKnowledgeQuery(parsed.query);
  if (!query) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { query: "query has no searchable terms" },
    });
  }

  const started = Date.now();
  const scope = { organizationId: workspace.organization.id, projectIds: [project.id], includeOrgLevel: false };
  const filters = { sourceIds: parsed.sourceIds };
  // The organization's first search, through this project route as through the org route, starts the backfill.
  const strategy = await ensureKnowledgeStrategy(workspace.organization.id);
  if (strategy.createdNow) {
    (deps.scheduleBackfill ?? scheduleKnowledgeBackfill)({ organizationId: workspace.organization.id, requestId });
  }
  const { candidates, mode } = await searchKnowledgeCandidates({ scope, query, filters, limit: parsed.limit });
  const rows = await reloadKnowledgeChunks({ scope, filters, chunkIds: candidates.map((candidate) => candidate.chunkId) });
  const scores = new Map(candidates.map((candidate) => [candidate.chunkId, candidate.score]));
  const returned = rows.slice(0, parsed.limit).map((row, index) => ({ rank: index + 1, score: scores.get(row.chunkId) ?? 0, row }));
  const revoked = Math.max(0, candidates.length - rows.length);

  const { runId } = await writeKnowledgeRun({
    organizationId: workspace.organization.id,
    projectId: project.id,
    audience: "operator",
    status: "completed",
    actorType: actorTypeForWorkspace(workspace),
    actorId: workspace.user.id,
    callerJson: { surface, source: SOURCE },
    localInstallationId: null,
    turnKey: null,
    queryText: parsed.query,
    normalizedQuery: query.normalized,
    mode,
    candidateCount: candidates.length,
    withheld: revoked > 0 ? { revoked } : {},
    deniedReason: null,
    citations: returned,
    durationMs: Date.now() - started,
    requestId,
    surface,
    prefilter: { projectCount: 1 },
  });
  const [run] = await db
    .select()
    .from(schema.knowledgeRetrievalRuns)
    .where(eq(schema.knowledgeRetrievalRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Failed to load knowledge retrieval run.");

  return {
    run: retrievalRunSummaryFromRecord(run),
    citations: returned.map((citation) => citationSummaryFromRow(runId, citation)),
  };
}

export function parseRetrieveKnowledgeBody(body: unknown): RetrieveKnowledgeInput {
  const approxBytes = JSON.stringify(body ?? {}).length;
  if (approxBytes > MAX_RETRIEVAL_BODY_BYTES) {
    throw new ConsoleApiError(413, { error: "payload_too_large" });
  }

  const result = retrievalBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: firstFieldErrors(result.error.flatten().fieldErrors),
    });
  }

  return {
    query: result.data.query,
    limit: result.data.limit ?? DEFAULT_LIMIT,
    sourceIds: [...new Set(result.data.sourceIds ?? [])],
    strategyKey: result.data.strategyKey ?? "default",
    metadata: result.data.metadata ?? {},
  };
}

export function buildKnowledgeExcerpt(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function citationSummaryFromRow(
  runId: string,
  citation: { rank: number; score: number; row: KnowledgeChunkRow },
): KnowledgeRetrievalCitationSummary {
  return {
    runId,
    rank: citation.rank,
    score: citation.score,
    sourceId: citation.row.sourceId,
    documentId: citation.row.documentId,
    chunkId: citation.row.chunkId,
    sourceTitle: citation.row.sourceTitle,
    documentTitle: citation.row.documentTitle,
    sensitivity: citation.row.sensitivity ?? "standard",
    excerpt: buildKnowledgeExcerpt(neutralizeKnowledgeText(citation.row.text)),
    location: citation.row.location,
    metadata: citation.row.metadata,
    textHash: citation.row.textHash,
  };
}

function retrievalRunSummaryFromRecord(
  run: typeof schema.knowledgeRetrievalRuns.$inferSelect,
): KnowledgeRetrievalRunSummary {
  return {
    id: run.id,
    projectId: run.projectId ?? "",
    status: run.status,
    queryHash: run.queryHash,
    candidateCount: run.candidateCount,
    returnedChunkCount: run.returnedChunkCount,
    deniedReason: run.deniedReason,
    durationMs: run.durationMs,
    createdAt: dateMs(run.createdAt),
  };
}

function actorTypeForWorkspace(workspace: KnowledgeWorkspace) {
  return workspace.mode === "anonymous" ? "anonymous" : "user";
}

function firstFieldErrors(errors: Record<string, string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors)
      .map(([field, messages]) => [field, messages?.[0] ?? "Invalid value"] as const)
      .filter(([, message]) => Boolean(message)),
  );
}

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}
