import { after } from "next/server";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { CliApiError, cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { usageEventTypes, usageMetricKeys } from "@/server/console/billing/usage-metering";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { listAccessibleProjectRecords, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { parseConsoleRole } from "@/server/console/workspace";
import { isRateLimited } from "@/server/security/rate-limit";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { startKnowledgeBackfill } from "./backfill";
import { KNOWLEDGE_EXEC_CONTEXT_HEADER, resolveKnowledgeOperator, type KnowledgeBindingLookup, type KnowledgeOperatorCaller } from "./caller";
import { knowledgeConflictMessage } from "./cli-api";
import type { KnowledgeF2HandlerInput, KnowledgeF2HandlerResult } from "./f2-cli";
import { callSeconds, formatCallClock, knowledgeResultUrl } from "./links";
import { buildKnowledgeQuery } from "./query";
import {
  knowledgePrefilter,
  readKnowledgeChunkNeighbours,
  reloadKnowledgeChunks,
  searchKnowledgeCandidates,
  writeKnowledgeRun,
  type KnowledgeChunkRow,
  type KnowledgeSearchFilters,
  type KnowledgeSearchScope,
} from "./retrieval-core";
import { ensureKnowledgeStrategy } from "./strategy";
import { neutralizeKnowledgeText, sanitizeSpeakerName } from "./text";
import { knowledgeKindForOriginKey } from "./types";
import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "./usage";

// Org-level Knowledge CLI routes (`/api/cli/knowledge/*`, CONTRACT §5.3).
// Every call runs, in order: the scope check, the role-based feature gate,
// caller resolution (operator only, §4.2) and, for search and read, the
// per-installation rate limit. Scope is recomputed on every request from
// live project access; every ref goes through the full prefilter again, and a
// missing or hidden ref answers the same 404.

export const KNOWLEDGE_READ_SCOPE = "console.knowledge.read";
export const KNOWLEDGE_WRITE_SCOPE = "console.knowledge.write";
export const KNOWLEDGE_ORG_MAX_BODY_BYTES = 256 * 1024;
export const KNOWLEDGE_PROPOSALS_MAX_BODY_BYTES = Math.floor(2.5 * 1024 * 1024);
export const KNOWLEDGE_CLI_RATE_LIMIT = 60;

const RATE_WINDOW_MS = 60_000;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_READ_AROUND = 5;
const DEFAULT_RUNS_LIMIT = 10;
const MAX_RUNS_LIMIT = 50;
const DEFAULT_SOURCES_LIMIT = 50;
const MAX_SOURCES_LIMIT = 100;
const MAX_BASE_VIEW_COMMANDS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KC_REF = /^kc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const VIEW_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const KINDS = ["meeting", "transcript", "page", "note", "manual"] as const;

type OrgRoute =
  | "search"
  | "read"
  | "runs"
  | "run"
  | "sources"
  | "proposals.create"
  | "proposals.get"
  | "digest"
  | "mirror"
  | "marks";

type F2Route = Extract<OrgRoute, "proposals.create" | "proposals.get" | "digest" | "mirror" | "marks">;
type F2Handler = (input: KnowledgeF2HandlerInput) => Promise<KnowledgeF2HandlerResult>;

export type KnowledgeOrgCliInput = {
  method: "GET" | "POST";
  auth: CliAuthContext;
  segments: string[];
  searchParams: URLSearchParams;
  body: unknown;
  headers: Headers;
  requestId: string;
  requestUrl: string;
};

export type KnowledgeOrgCliDeps = {
  featureAccess?: typeof getConsoleFeatureAccessForOrganizationRole;
  findBinding?: KnowledgeBindingLookup;
  /** Records the denied run of a refused caller (defaults to `writeKnowledgeRun`). */
  writeDeniedRun?: typeof writeKnowledgeRun;
  listProjects?: (workspace: ProjectAccessWorkspace) => Promise<ProjectRef[]>;
  rateLimited?: (key: string) => boolean;
  startBackfill?: typeof startKnowledgeBackfill;
  /** Runs work after the response (`after()` from next/server; a detached promise outside a request). */
  schedule?: (task: () => Promise<unknown>) => void;
  recordUsage?: typeof recordKnowledgeUsage;
  f2?: Partial<Record<F2Route, F2Handler>>;
};

type ProjectRef = { id: string; slug: string; name: string };
type OrgContext = {
  input: KnowledgeOrgCliInput;
  caller: KnowledgeOperatorCaller;
  deps: KnowledgeOrgCliDeps;
  origin: string;
};

// F2 handlers (K-C4) and the backfill (K-C3) load on first use, so a route
// that never reaches them does not load the publish and proposal modules.
const DEFAULT_F2: Record<F2Route, F2Handler> = {
  "proposals.create": async (input) => (await import("./f2-cli")).handleKnowledgeProposalCreate(input),
  "proposals.get": async (input) => (await import("./f2-cli")).handleKnowledgeProposalGet(input),
  digest: async (input) => (await import("./f2-cli")).handleKnowledgeDigest(input),
  mirror: async (input) => (await import("./f2-cli")).handleKnowledgeMirror(input),
  marks: async (input) => (await import("./f2-cli")).handleKnowledgeMarks(input),
};

const defaultStartBackfill: typeof startKnowledgeBackfill = async (input) =>
  (await import("./backfill")).startKnowledgeBackfill(input);

/** The whole route: auth, body, dispatch and the error envelope, all with `cache-control: no-store`. */
export async function respondKnowledgeOrgCli(
  request: Request,
  segments: string[],
  method: "GET" | "POST",
  deps: KnowledgeOrgCliDeps & { authenticate?: typeof authenticateCliRequest } = {},
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const auth = await (deps.authenticate ?? authenticateCliRequest)(request, requestId, { actor: "executor" });
    const route = classifyRoute(method, segments);
    const maxBytes = route === "proposals.create" ? KNOWLEDGE_PROPOSALS_MAX_BODY_BYTES : KNOWLEDGE_ORG_MAX_BODY_BYTES;
    const body =
      method === "GET" || request.headers.get("content-length") === "0"
        ? {}
        : await readJsonBody(request, requestId, { maxBytes });
    const result = await handleKnowledgeOrgCli(
      {
        method,
        auth,
        segments,
        searchParams: new URL(request.url).searchParams,
        body,
        headers: request.headers,
        requestId,
        requestUrl: request.url,
      },
      deps,
    );
    return cliSuccess(result.payload, { status: result.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error instanceof ConsoleApiError ? knowledgeOrgCliError(error) : error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}

export async function handleKnowledgeOrgCli(
  input: KnowledgeOrgCliInput,
  deps: KnowledgeOrgCliDeps = {},
): Promise<{ status: number; payload: unknown }> {
  const route = classifyRoute(input.method, input.segments);
  const scope = route === "proposals.create" || route === "mirror" ? KNOWLEDGE_WRITE_SCOPE : KNOWLEDGE_READ_SCOPE;
  if (!input.auth.scopes.includes(scope)) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Run \`ravi login\` again.`, {
      reason: "missing_scope",
      scope,
    });
  }
  await assertKnowledgeFeature(input.auth, deps.featureAccess);
  const caller = await resolveKnowledgeOperator(
    { auth: input.auth, header: input.headers.get(KNOWLEDGE_EXEC_CONTEXT_HEADER), requestId: input.requestId },
    { findBinding: deps.findBinding, writeDeniedRun: deps.writeDeniedRun },
  );
  if (route === "search" || route === "read") {
    const key = `knowledge-cli:${caller.localInstallationId}`;
    const limited = deps.rateLimited
      ? deps.rateLimited(key)
      : isRateLimited({ key, limit: KNOWLEDGE_CLI_RATE_LIMIT, windowMs: RATE_WINDOW_MS });
    if (limited) throw cliApiError(429, "RATE_LIMITED", "Too many Knowledge requests from this installation; wait a minute.");
  }

  const context: OrgContext = { input, caller, deps, origin: raviLinkConsoleOrigin(input.requestUrl) };
  switch (route) {
    case "search":
      return { status: 200, payload: await searchKnowledgeForOperator(context) };
    case "read":
      return { status: 200, payload: await readKnowledgeForOperator(context) };
    case "runs":
      return { status: 200, payload: await listOperatorRuns(context) };
    case "run":
      return { status: 200, payload: await getOperatorRun(context, input.segments[1]!) };
    case "sources":
      return { status: 200, payload: await listOperatorSources(context) };
    default: {
      const handler = deps.f2?.[route] ?? DEFAULT_F2[route];
      return handler({
        caller,
        auth: input.auth,
        segments: input.segments,
        searchParams: input.searchParams,
        body: input.body,
        requestId: input.requestId,
        requestUrl: input.requestUrl,
      });
    }
  }
}

/** ConsoleApiError → CLI envelope for the org routes (F2 handlers throw these). */
export function knowledgeOrgCliError(error: ConsoleApiError): CliApiError {
  const code = error.payload.error;
  if (error.status === 409) {
    // The specific code travels in details (`reason` and `code`) for OSS and the cards.
    return cliApiError(409, "CONFLICT", knowledgeConflictMessage(code) ?? "This Knowledge change conflicts with another one.", {
      reason: code,
      code,
    });
  }
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return cliApiError(
      error.status === 413 ? 413 : 400,
      "PAYLOAD_INVALID",
      undefined,
      error.payload.fieldErrors ? { fieldErrors: error.payload.fieldErrors } : undefined,
    );
  }
  if (error.status === 404) return cliApiError(404, "NOT_FOUND");
  if (error.status === 403) return cliApiError(403, "ORG_ACCESS_DENIED", undefined, { reason: code });
  if (error.status === 429) return cliApiError(429, "RATE_LIMITED");
  return cliApiError(503, "SERVER_UNAVAILABLE", "Knowledge is temporarily unavailable.");
}

function classifyRoute(method: "GET" | "POST", segments: readonly string[]): OrgRoute {
  const [first, second, ...rest] = segments;
  if (rest.length === 0) {
    if (method === "POST" && second === undefined) {
      if (first === "search") return "search";
      if (first === "read") return "read";
      if (first === "proposals") return "proposals.create";
      if (first === "mirror") return "mirror";
    }
    if (method === "GET") {
      if (second === undefined) {
        if (first === "runs") return "runs";
        if (first === "sources") return "sources";
        if (first === "digest") return "digest";
        if (first === "marks") return "marks";
      } else if (second.length > 0) {
        if (first === "runs") return "run";
        if (first === "proposals") return "proposals.get";
      }
    }
  }
  throw cliApiError(404, "PAYLOAD_INVALID", "Unknown Knowledge CLI route.");
}

async function assertKnowledgeFeature(
  auth: CliAuthContext,
  loader: typeof getConsoleFeatureAccessForOrganizationRole = getConsoleFeatureAccessForOrganizationRole,
) {
  if (!parseConsoleRole(auth.membership.role)) {
    throw cliApiError(403, "KNOWLEDGE_DISABLED", undefined, { reason: "feature_forbidden" });
  }
  const access = await loader({ organizationId: auth.organization.id, role: auth.membership.role });
  const feature = access.byKey["console.knowledge"];
  if (!feature?.available) throw cliApiError(403, "KNOWLEDGE_DISABLED", undefined, { reason: "feature_unavailable" });
  if (!feature.authorized) throw cliApiError(403, "KNOWLEDGE_DISABLED", undefined, { reason: "feature_forbidden" });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const searchBodySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  kinds: z.array(z.enum(KINDS)).max(KINDS.length).optional(),
  since: z.string().datetime({ offset: true }).optional().nullable(),
  who: z.string().trim().max(80).optional().nullable(),
  project: z.string().trim().min(1).max(200).optional().nullable(),
});

async function searchKnowledgeForOperator(context: OrgContext) {
  const { caller, deps, input } = context;
  const body = parseBody(searchBodySchema, input.body);
  const query = buildKnowledgeQuery(body.query);
  if (!query) throw cliApiError(400, "PAYLOAD_INVALID", "query has no searchable terms");
  const limit = body.limit ?? DEFAULT_SEARCH_LIMIT;

  const started = Date.now();
  const projects = await accessibleProjects(caller, deps);
  const project = body.project ? findProjectRef(projects, body.project) : null;
  if (body.project && !project) throw cliApiError(404, "NOT_FOUND");
  const scope: KnowledgeSearchScope = project
    ? { organizationId: caller.workspace.organization.id, projectIds: [project.id], includeOrgLevel: false }
    : operatorScope(caller, projects);
  const filters: KnowledgeSearchFilters = {
    ...(body.kinds && body.kinds.length > 0 ? { kinds: [...new Set(body.kinds)] } : {}),
    since: body.since ? new Date(body.since) : null,
    who: body.who || null,
  };

  const issues: string[] = [];
  const strategy = await ensureKnowledgeStrategy(caller.workspace.organization.id);
  if (strategy.createdNow) {
    const organizationId = caller.workspace.organization.id;
    (deps.schedule ?? scheduleAfterResponse)(() =>
      (deps.startBackfill ?? defaultStartBackfill)({ organizationId, requestId: input.requestId }),
    );
    issues.push("backfill_started");
  }

  const { candidates, mode } = await searchKnowledgeCandidates({ scope, query, filters, limit });
  const rows = await reloadKnowledgeChunks({ scope, filters, chunkIds: candidates.map((candidate) => candidate.chunkId) });
  const byId = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
  const returned = rows.slice(0, limit).map((row, index) => ({ rank: index + 1, score: byId.get(row.chunkId)?.score ?? 0, row }));
  const revoked = Math.max(0, candidates.length - rows.length);
  const withheld: Record<string, number> = revoked > 0 ? { revoked } : {};
  if (returned.some((citation) => byId.get(citation.row.chunkId)?.pass === "or")) issues.push("query_or_fallback");

  const { runId } = await writeKnowledgeRun({
    organizationId: caller.workspace.organization.id,
    projectId: project?.id ?? null,
    audience: "operator",
    status: "completed",
    actorType: "cli",
    actorId: caller.workspace.user.id,
    callerJson: caller.callerJson,
    localInstallationId: caller.localInstallationId,
    turnKey: caller.turnKey,
    queryText: body.query,
    normalizedQuery: query.normalized,
    mode,
    candidateCount: candidates.length,
    withheld,
    deniedReason: null,
    citations: returned,
    durationMs: Date.now() - started,
    requestId: input.requestId,
    surface: "cli",
    prefilter: { kinds: filters.kinds, since: filters.since, who: filters.who, projectCount: scope.projectIds.length },
  });
  await recordSearchUsage(context, runId, project?.id ?? null);

  const next = await nextCommands(scope, returned.map((citation) => citation.row));
  const projectsById = new Map(projects.map((item) => [item.id, item]));
  return {
    runId,
    audience: "operator" as const,
    query: { normalized: query.normalized, mode },
    results: returned.map(({ row, score }) => ({
      ...resultHead(row, projectsById),
      text: neutralizeKnowledgeText(row.text),
      speakers: rowSpeakers(row),
      location: resultLocation(row),
      url: knowledgeResultUrl(row, context.origin),
      recordedAt: recordedAtIso(row.recordedAt),
      score,
      next: next.get(row.chunkId) ?? [],
    })),
    withheld: withheldView(withheld),
    issues,
  };
}

async function recordSearchUsage(context: OrgContext, runId: string, projectId: string | null) {
  try {
    await (context.deps.recordUsage ?? recordKnowledgeUsage)([
      buildKnowledgeUsageEvent({
        organizationId: context.caller.workspace.organization.id,
        projectId,
        metricKey: usageMetricKeys.knowledgeSearches,
        eventType: usageEventTypes.knowledgeSearchCompleted,
        id: runId,
        quantity: 1,
        requestId: context.input.requestId,
        dimensions: { audience: "operator" },
      }),
    ]);
  } catch (error) {
    console.error("[knowledge] failed to record search usage", {
      requestId: context.input.requestId,
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readBodySchema = z.object({
  ref: z.string().trim().min(1).max(200),
  around: z.number().int().min(0).max(MAX_READ_AROUND).optional(),
});

async function readKnowledgeForOperator(context: OrgContext) {
  const { caller, input } = context;
  const body = parseBody(readBodySchema, input.body);
  const chunkId = parseChunkRef(body.ref);
  const started = Date.now();
  const projects = await accessibleProjects(caller, context.deps);
  const scope = operatorScope(caller, projects);
  const rows = await readKnowledgeChunkNeighbours({ scope, chunkId, around: body.around ?? 0 });
  const focus = rows?.find((row) => row.chunkId === chunkId);
  if (!rows || !focus) throw cliApiError(404, "NOT_FOUND");

  const { runId } = await writeKnowledgeRun({
    organizationId: caller.workspace.organization.id,
    projectId: focus.projectId,
    audience: "operator",
    status: "completed",
    actorType: "cli",
    actorId: caller.workspace.user.id,
    callerJson: caller.callerJson,
    localInstallationId: caller.localInstallationId,
    turnKey: caller.turnKey,
    queryText: null,
    normalizedQuery: null,
    mode: null,
    candidateCount: rows.length,
    withheld: {},
    deniedReason: null,
    citations: rows.map((row, index) => ({ rank: index + 1, score: 0, row })),
    durationMs: Date.now() - started,
    requestId: input.requestId,
    surface: "cli",
  });

  const next = await nextCommands(scope, [focus], { readingRef: true });
  const projectsById = new Map(projects.map((item) => [item.id, item]));
  return {
    runId,
    ...resultHead(focus, projectsById),
    chunks: rows.map((row) => ({
      ref: `kc:${row.chunkId}`,
      ordinal: row.ordinal,
      text: neutralizeKnowledgeText(row.text),
      speakers: rowSpeakers(row),
      location: resultLocation(row),
      focus: row.chunkId === focus.chunkId,
    })),
    url: knowledgeResultUrl(focus, context.origin),
    next: next.get(focus.chunkId) ?? [],
  };
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

const runs = schema.knowledgeRetrievalRuns;

async function listOperatorRuns(context: OrgContext) {
  const params = context.input.searchParams;
  const turnKey = params.get("turnKey");
  if (turnKey !== null && !/^[a-f0-9]{64}$/i.test(turnKey)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "turnKey must be 64 hex characters.");
  }
  const session = params.get("session");
  if (session !== null && (session.length === 0 || session.length > 500)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "session must be 1-500 characters.");
  }
  const limit = intParam(params.get("limit"), DEFAULT_RUNS_LIMIT, 1, MAX_RUNS_LIMIT, "limit");

  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        operatorRunsWhere(context.caller),
        turnKey ? eq(runs.turnKey, turnKey.toLowerCase()) : undefined,
        session ? sql`${runs.callerJson}->>'sessionName' = ${session}` : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit);
  return { runs: rows.map(runSummary) };
}

async function getOperatorRun(context: OrgContext, rawId: string) {
  const id = rawId.startsWith("kr:") ? rawId.slice(3) : rawId;
  if (!UUID.test(id)) throw cliApiError(404, "NOT_FOUND");
  const [run] = await db
    .select()
    .from(runs)
    .where(and(operatorRunsWhere(context.caller), eq(runs.id, id)))
    .limit(1);
  if (!run) throw cliApiError(404, "NOT_FOUND");

  const citations = await db
    .select({
      rank: schema.knowledgeCitations.rank,
      chunkId: schema.knowledgeCitations.chunkId,
      textHash: schema.knowledgeCitations.textHash,
      documentVersion: schema.knowledgeCitations.documentVersion,
    })
    .from(schema.knowledgeCitations)
    .where(eq(schema.knowledgeCitations.retrievalRunId, run.id))
    .orderBy(schema.knowledgeCitations.rank);

  // Re-checked live under the caller's current scope: a revoked or deleted
  // chunk, or one the caller can no longer read, shows no title or url.
  const projects = await accessibleProjects(context.caller, context.deps);
  const live = await reloadKnowledgeChunks({
    scope: operatorScope(context.caller, projects),
    chunkIds: citations.flatMap((citation) => (citation.chunkId ? [citation.chunkId] : [])),
  });
  const liveById = new Map(live.map((row) => [row.chunkId, row]));
  return {
    run: runSummary(run),
    citations: citations.map((citation) => {
      const row = citation.chunkId ? liveById.get(citation.chunkId) : undefined;
      const ref = citation.chunkId ? `kc:${citation.chunkId}` : "kc:deleted";
      if (!row) return { rank: citation.rank, ref, available: false as const };
      return {
        rank: citation.rank,
        ref,
        kind: row.kind,
        trust: row.trust,
        title: neutralizeTitle(row.documentTitle || row.sourceTitle),
        documentVersion: citation.documentVersion ?? row.documentVersion,
        textHash: citation.textHash ?? row.textHash,
        url: knowledgeResultUrl(row, context.origin),
        available: true as const,
      };
    }),
  };
}

function operatorRunsWhere(caller: KnowledgeOperatorCaller) {
  return and(
    eq(runs.organizationId, caller.workspace.organization.id),
    eq(runs.localInstallationId, caller.localInstallationId),
    eq(runs.audience, "operator"),
  );
}

function runSummary(run: typeof runs.$inferSelect) {
  const caller = record(run.callerJson);
  return {
    runId: run.id,
    createdAt: run.createdAt.toISOString(),
    status: run.status,
    audience: "operator" as const,
    normalizedQuery: run.normalizedQuery,
    turnKey: run.turnKey,
    sessionName: typeof caller.sessionName === "string" ? caller.sessionName : null,
    citationCount: run.returnedChunkCount,
    withheld: withheldFromJson(run.deniedJson),
  };
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

const sourcesTable = schema.knowledgeSources;
// Correlated subqueries name the outer column explicitly: drizzle renders a
// column of a single-table select unqualified, which would bind to the inner table.

async function listOperatorSources(context: OrgContext) {
  const params = context.input.searchParams;
  const failing = params.get("failing") === "1" || params.get("failing") === "true";
  const limit = intParam(params.get("limit"), DEFAULT_SOURCES_LIMIT, 1, MAX_SOURCES_LIMIT, "limit");
  const cursor = decodeCursor(params.get("cursor"));

  const projects = await accessibleProjects(context.caller, context.deps);
  const projectIds = projects.map((project) => project.id);
  const lastJobStatus = sql<string | null>`(SELECT j.status::text FROM knowledge_ingestion_jobs j WHERE j.source_id = "knowledge_sources"."id" ORDER BY j.created_at DESC, j.id DESC LIMIT 1)`;
  const conditions: Array<SQL | undefined> = [
    eq(sourcesTable.organizationId, context.caller.workspace.organization.id),
    or(projectIds.length > 0 ? inArray(sourcesTable.projectId, projectIds) : sql`false`, isNull(sourcesTable.projectId)),
    failing ? sql`${lastJobStatus} IN ('failed', 'canceled')` : undefined,
    cursor
      ? sql`(${sourcesTable.createdAt}, ${sourcesTable.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : undefined,
  ];

  const rows = await db
    .select({
      id: sourcesTable.id,
      originKey: sourcesTable.originKey,
      title: sourcesTable.title,
      projectId: sourcesTable.projectId,
      trust: sourcesTable.trustTier,
      status: sourcesTable.status,
      createdAt: sourcesTable.createdAt,
      documents: sql<number>`(SELECT count(*)::int FROM knowledge_documents d WHERE d.source_id = "knowledge_sources"."id")`,
      chunks: sql<number>`(SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = "knowledge_sources"."id" AND c.status = 'active')`,
      lastJob: sql<JsonRecord | null>`(SELECT json_build_object('status', j.status, 'triggerType', j.trigger_type, 'at', coalesce(j.finished_at, j.started_at, j.created_at), 'failureCode', j.failure_code) FROM knowledge_ingestion_jobs j WHERE j.source_id = "knowledge_sources"."id" ORDER BY j.created_at DESC, j.id DESC LIMIT 1)`,
    })
    .from(sourcesTable)
    .where(and(...conditions))
    .orderBy(desc(sourcesTable.createdAt), desc(sourcesTable.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return {
    sources: page.map((row) => {
      const job = row.lastJob ? record(row.lastJob) : null;
      return {
        id: row.id,
        kind: knowledgeKindForOriginKey(row.originKey),
        title: neutralizeTitle(row.title),
        project: row.projectId ? (projectsById.get(row.projectId) ?? null) : null,
        trust: row.trust,
        status: row.status,
        documents: Number(row.documents) || 0,
        chunks: Number(row.chunks) || 0,
        lastJob: job
          ? {
              status: String(job.status),
              triggerType: String(job.triggerType),
              at: isoOrNull(job.at) ?? "",
              failureCode: typeof job.failureCode === "string" ? job.failureCode : null,
            }
          : null,
      };
    }),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c === "string" && typeof parsed.i === "string" && UUID.test(parsed.i) && !Number.isNaN(Date.parse(parsed.c))) {
      return { createdAt: new Date(parsed.c).toISOString(), id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw cliApiError(400, "PAYLOAD_INVALID", "cursor is invalid.");
}

// ---------------------------------------------------------------------------
// result shapes
// ---------------------------------------------------------------------------

/** Ref, kind, trust, project, source and document of a result. Titles come from pages and meetings (anyone can write them), so they are neutralized like text. */
export function resultHead(row: KnowledgeChunkRow, projectsById: ReadonlyMap<string, ProjectRef>) {
  return {
    ref: `kc:${row.chunkId}`,
    kind: row.kind,
    trust: row.trust,
    project: row.projectId ? (projectsById.get(row.projectId) ?? null) : null,
    source: { id: row.sourceId, title: neutralizeTitle(row.sourceTitle), originKey: row.originKey },
    document: { id: row.documentId, version: row.documentVersion, title: neutralizeTitle(row.documentTitle) },
  };
}

function neutralizeTitle<T extends string | null | undefined>(title: T): T {
  return (typeof title === "string" ? neutralizeKnowledgeText(title) : title) as T;
}

type ResultLocation =
  | { kind: "meeting"; meetingId: string; startSeconds: number | null; clock: string | null; part: number }
  | { kind: "page"; host: string; path: string; anchor: string | null; heading: string | null }
  | { kind: "note" };

export function resultLocation(row: Pick<KnowledgeChunkRow, "kind" | "location" | "metadata">): ResultLocation {
  const location = row.location;
  if (row.kind === "meeting" || row.kind === "transcript") {
    const startSeconds = callSeconds(location.startSeconds);
    const part = typeof location.part === "number" && Number.isInteger(location.part) ? location.part : 0;
    return {
      kind: "meeting",
      meetingId: typeof location.meetingId === "string" ? location.meetingId : "",
      startSeconds,
      clock: formatCallClock(startSeconds),
      part,
    };
  }
  if (row.kind === "page") {
    return {
      kind: "page",
      host: typeof location.host === "string" ? location.host : "",
      path: typeof location.path === "string" ? location.path : "/",
      anchor: typeof location.anchor === "string" && location.anchor ? location.anchor : null,
      heading: pageHeading(location, row.metadata),
    };
  }
  return { kind: "note" };
}

function pageHeading(location: JsonRecord, metadata: JsonRecord): string | null {
  const path = location.headingPath;
  let heading: unknown = null;
  if (Array.isArray(path)) heading = path[path.length - 1];
  else if (typeof path === "string" && path) heading = path.split(">").pop();
  if (typeof heading !== "string" || !heading.trim()) heading = metadata.heading;
  return typeof heading === "string" && heading.trim() ? neutralizeKnowledgeText(heading.trim()) : null;
}

function rowSpeakers(row: Pick<KnowledgeChunkRow, "metadata">): string[] {
  const value = row.metadata.speakers;
  const names: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") names.push(item);
      else if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
        names.push((item as { name: string }).name);
      }
    }
  } else if (typeof row.metadata.speakerName === "string") {
    names.push(row.metadata.speakerName);
  }
  return [...new Set(names.map((name) => sanitizeSpeakerName(name)))];
}

/**
 * Follow-up commands per chunk: Bases views a page reads, `read --around 2`
 * for a meeting window that is only part of its meeting, and the approved
 * correction that targets a chunk (reverse lookup of `metadata.corrects`).
 */
async function nextCommands(
  scope: KnowledgeSearchScope,
  rows: readonly KnowledgeChunkRow[],
  options: { readingRef?: boolean } = {},
): Promise<Map<string, string[]>> {
  const next = new Map<string, string[]>(rows.map((row) => [row.chunkId, []]));
  if (rows.length === 0) return next;

  for (const row of rows) {
    if (row.kind !== "page") continue;
    const views = Array.isArray(row.metadata.baseViews) ? row.metadata.baseViews : [];
    const ids = [...new Set(views.filter((view): view is string => typeof view === "string" && VIEW_ID.test(view)))];
    for (const viewId of ids.slice(0, MAX_BASE_VIEW_COMMANDS)) next.get(row.chunkId)!.push(`ravi bases views query ${viewId}`);
  }

  const meetingRows = options.readingRef ? [] : rows.filter((row) => row.kind === "meeting" || row.kind === "transcript");
  if (meetingRows.length > 0) {
    const documentIds = [...new Set(meetingRows.map((row) => row.documentId))];
    const counts = await db
      .select({ documentId: schema.knowledgeChunks.documentId, count: sql<number>`count(*)::int` })
      .from(schema.knowledgeChunks)
      .where(and(inArray(schema.knowledgeChunks.documentId, documentIds), eq(schema.knowledgeChunks.status, "active")))
      .groupBy(schema.knowledgeChunks.documentId);
    const byDocument = new Map(counts.map((row) => [row.documentId, Number(row.count)]));
    for (const row of meetingRows) {
      if ((byDocument.get(row.documentId) ?? 0) > 1) next.get(row.chunkId)!.push(`ravi knowledge read kc:${row.chunkId} --around 2`);
    }
  }

  const refs = rows.map((row) => `kc:${row.chunkId}`);
  const corrections = await db
    .select({
      chunkId: schema.knowledgeChunks.id,
      corrects: sql<string>`${schema.knowledgeChunks.safeMetadataJson}->>'corrects'`,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(schema.knowledgeDocuments, eq(schema.knowledgeChunks.documentId, schema.knowledgeDocuments.id))
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeChunks.sourceId, schema.knowledgeSources.id))
    .where(
      and(
        knowledgePrefilter(scope, { kinds: ["note"] }),
        inArray(sql<string>`${schema.knowledgeChunks.safeMetadataJson}->>'corrects'`, refs),
      ),
    )
    .orderBy(schema.knowledgeChunks.chunkOrdinal)
    .limit(50);
  const seen = new Set<string>();
  for (const correction of corrections) {
    const target = correction.corrects?.slice(3);
    if (!target || !next.has(target) || seen.has(target)) continue;
    seen.add(target);
    next.get(target)!.push(`ravi knowledge read kc:${correction.chunkId}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function accessibleProjects(caller: KnowledgeOperatorCaller, deps: KnowledgeOrgCliDeps): Promise<ProjectRef[]> {
  if (deps.listProjects) return deps.listProjects(caller.workspace);
  const records = await listAccessibleProjectRecords(caller.workspace);
  return records.map((project) => ({ id: project.id, slug: project.slug, name: project.name }));
}

function operatorScope(caller: KnowledgeOperatorCaller, projects: readonly ProjectRef[]): KnowledgeSearchScope {
  return {
    organizationId: caller.workspace.organization.id,
    projectIds: projects.map((project) => project.id),
    includeOrgLevel: true,
  };
}

function findProjectRef(projects: readonly ProjectRef[], ref: string): ProjectRef | null {
  const lowered = ref.toLowerCase();
  return projects.find((project) => project.id.toLowerCase() === lowered || project.slug === ref) ?? null;
}

function parseChunkRef(ref: string): string {
  const match = KC_REF.exec(ref);
  if (!match) throw cliApiError(400, "PAYLOAD_INVALID", "ref must look like kc:<uuid>.");
  return match[1]!.toLowerCase();
}

function parseBody<T>(schemaDef: z.ZodType<T>, body: unknown): T {
  const parsed = schemaDef.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".") || "body";
    fieldErrors[key] ??= issue.message;
  }
  throw cliApiError(400, "PAYLOAD_INVALID", undefined, { fieldErrors });
}

function intParam(value: string | null, fallback: number, min: number, max: number, name: string) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw cliApiError(400, "PAYLOAD_INVALID", `${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function withheldView(reasons: Record<string, number>) {
  const count = Object.values(reasons).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  return { count, reasons };
}

function withheldFromJson(value: unknown) {
  const json = record(value);
  const reasons: Record<string, number> = {};
  for (const [key, count] of Object.entries(record(json.reasons))) {
    if (typeof count === "number" && Number.isFinite(count)) reasons[key] = count;
  }
  const count = typeof json.count === "number" && Number.isFinite(json.count) ? json.count : withheldView(reasons).count;
  return { count, reasons };
}

function recordedAtIso(value: Date) {
  return value.getTime() > 0 ? value.toISOString() : null;
}

function isoOrNull(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function scheduleAfterResponse(task: () => Promise<unknown>) {
  const run = () =>
    task().catch((error: unknown) => {
      console.error("[knowledge] scheduled work failed", { name: error instanceof Error ? error.name : "unknown" });
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

