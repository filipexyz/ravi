// `ravi knowledge search|read|why|sources|marks` (contract §10.5): Console and
// local history searched in parallel, merged by reciprocal rank, every excerpt
// fenced with one nonce per call, and a `next` that is never empty. The
// command layer (src/cli/commands/knowledge.ts) gates the turn first, prints
// and maps errors with `knowledgeContractError`.

import { createHash } from "node:crypto";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { getContext } from "../cli/context.js";
import { dbListChatsByRef } from "../router/router-db.js";
import { chatIdsForContact } from "./contacts.js";
import { isConsoleUnavailable, openKnowledgeClient, type KnowledgeClient } from "./client.js";
import { mergeRrf } from "./merge.js";
import { buildKnowledgeHeader, fenceKnowledgeText, formatClock, KNOWLEDGE_RULE, newKnowledgeNonce } from "./render.js";
import { foldKnowledgeText, knowledgeQueryTerms } from "./text.js";
import {
  CONSOLE_KNOWLEDGE_KINDS,
  lowestTier,
  type ConsoleKnowledgeKind,
  type ConsoleReadResponse,
  type ConsoleRunCitation,
  type ConsoleRunSummary,
  type ConsoleSearchRequest,
  type ConsoleSearchResult,
  type KnowledgeMarksPayload,
  type KnowledgeReadPayload,
  type KnowledgeResultView,
  type KnowledgeSearchInput,
  type KnowledgeSearchPayload,
  type KnowledgeSourcesPayload,
  type KnowledgeTrustTier,
  type KnowledgeTurn,
  type KnowledgeWhyCitation,
  type KnowledgeWhyPayload,
  type KnowledgeWhyRun,
} from "./types.js";
import {
  describeLocalRefs,
  indexLocalSources,
  localIndexStats,
  readLocal,
  searchLocal,
  type LocalDocKind,
  type LocalReadResult,
  type LocalSearchHit,
} from "./store/local-index.js";
import { getLocalRun, insertLocalRun, listLocalRuns, type LocalRun } from "./store/local-runs.js";
import { recordTurnRead } from "./store/turn-reads.js";

export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 8;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;
export const KNOWLEDGE_QUERY_MAX_CHARS = 2_000;
/** An in-turn search runs inside the daemon, whose event loop a synchronous indexer would block. */
export const GATEWAY_INDEX_BUDGET_MS = 200;
export const TERMINAL_INDEX_BUDGET_MS = 1_500;
export const RESEARCH_NEXT = 'ravi knowledge search "<counterpart name>" --since 30d';

export interface KnowledgeDeps {
  /** Null means no `ravi login`. */
  openClient?: () => Promise<KnowledgeClient | null>;
  indexLocal?: typeof indexLocalSources;
  searchLocal?: typeof searchLocal;
  readLocal?: typeof readLocal;
  chatIdsForContact?: (contactId: string) => string[];
  chatIdsForChat?: (chatRef: string) => string[];
  recordTurnRead?: typeof recordTurnRead;
  nonce?: () => string;
  /** True for an in-turn call through the gateway (smaller index budget). */
  inGateway?: () => boolean;
}

type ResultWithHash = KnowledgeResultView & { textHash: string };

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function runKnowledgeSearch(
  input: KnowledgeSearchInput,
  deps: KnowledgeDeps = {},
): Promise<KnowledgeSearchPayload> {
  const query = input.query?.trim() ?? "";
  if (!query) throw payloadInvalid("A search query is required.");
  if (query.length > KNOWLEDGE_QUERY_MAX_CHARS) {
    throw payloadInvalid(`The query is longer than ${KNOWLEDGE_QUERY_MAX_CHARS} characters.`);
  }
  if (knowledgeQueryTerms(query).length === 0) throw payloadInvalid("The query has no searchable terms.");
  const limit = clampLimit(input.limit);
  const nonce = (deps.nonce ?? newKnowledgeNonce)();
  const issues: string[] = [];

  const kinds = input.kinds?.length ? [...new Set(input.kinds)] : null;
  const consoleKinds = kinds
    ? kinds.filter((kind): kind is ConsoleKnowledgeKind =>
        (CONSOLE_KNOWLEDGE_KINDS as readonly string[]).includes(kind),
      )
    : null;
  const localKinds = kinds
    ? kinds.filter((kind): kind is LocalDocKind => kind === "chat" || kind === "transcript")
    : null;
  const skipConsole = input.localOnly === true || (consoleKinds !== null && consoleKinds.length === 0);
  const skipLocal = localKinds !== null && localKinds.length === 0;

  // Console first (async), local meanwhile (synchronous), then join.
  let consolePromise: Promise<{ response: Awaited<ReturnType<KnowledgeClient["search"]>> | null }> = Promise.resolve({
    response: null,
  });
  if (!skipConsole) {
    const client = await (deps.openClient ?? defaultOpenClient)();
    if (!client) {
      issues.push("console_not_logged_in");
    } else {
      const request: ConsoleSearchRequest = {
        query,
        limit,
        ...(consoleKinds ? { kinds: consoleKinds } : {}),
        ...(input.since ? { since: input.since.toISOString() } : {}),
        ...(input.who?.trim() ? { who: input.who.trim() } : {}),
        ...(input.project?.trim() ? { project: input.project.trim() } : {}),
      };
      consolePromise = client.search(request, input.turn).then(
        (response) => ({ response }),
        (error: unknown) => {
          if (isConsoleUnavailable(error)) {
            issues.push(`console_unavailable: ${error.code}`);
            return { response: null };
          }
          if (isCloudAuthError(error) && (error.code === "AUTH_REQUIRED" || error.code === "CREDENTIALS_INVALID")) {
            issues.push("console_not_logged_in");
            return { response: null };
          }
          throw error;
        },
      );
    }
  }

  let localHits: LocalSearchHit[] = [];
  if (!skipLocal) {
    try {
      const chatIds = input.about ? resolveAboutChatIds(input.about, deps) : null;
      const inGateway = (deps.inGateway ?? defaultInGateway)();
      try {
        (deps.indexLocal ?? indexLocalSources)({
          budgetMs: inGateway ? GATEWAY_INDEX_BUDGET_MS : TERMINAL_INDEX_BUDGET_MS,
        });
      } catch {
        issues.push("local_index_stale");
      }
      localHits = (deps.searchLocal ?? searchLocal)({
        query,
        about: chatIds ? { chatIds } : null,
        ...(localKinds ? { kinds: localKinds } : {}),
        who: input.who ?? null,
        since: input.since ? input.since.getTime() : null,
        limit,
      });
    } catch (error) {
      // The local half never hides the Console's answer.
      consolePromise.catch(() => undefined);
      if (!(error instanceof Error)) throw error;
      issues.push("local_search_failed");
    }
  }

  const { response } = await consolePromise;
  for (const issue of response?.issues ?? []) if (typeof issue === "string") issues.push(issue);

  const consoleViews = (response?.results ?? []).map((result) => consoleResultView(result, nonce));
  const localViews = localHits.map((hit) => localHitView(hit, nonce));
  const merged = mergeRrf<ResultWithHash>([consoleViews, localViews], limit);
  const results: KnowledgeResultView[] = merged.map(({ textHash: _hash, ...view }) => view);

  const next: string[] = [];
  for (const result of response?.results ?? []) {
    if (results.some((view) => view.ref === result.ref))
      for (const command of result.next ?? []) pushUnique(next, command);
  }
  if (results[0]) pushUnique(next, `ravi knowledge read ${results[0].ref} --around 2`);
  pushUnique(next, "ravi knowledge why --last");
  if (results.length === 0) pushUnique(next, RESEARCH_NEXT);

  const tier = lowestTier(results.map((result) => result.trust));
  const localRun = insertLocalRun({
    turnKey: input.turn.turnKey,
    sessionName: input.turn.sessionName,
    consoleRunId: response?.runId ?? null,
    queryHash: queryHash(query),
    refs: results.map((result) => ({ ref: result.ref, trust: result.trust })),
    lowestTier: tier,
    issues: issues.map(issueCode),
  });
  if (input.turn.turnKey && tier) (deps.recordTurnRead ?? recordTurnRead)(input.turn.turnKey, tier);

  return {
    query,
    audience: "operator",
    nonce,
    rule: KNOWLEDGE_RULE,
    results,
    withheld: response?.withheld ?? null,
    runId: response?.runId ?? null,
    localRunId: `kl:${localRun.id}`,
    issues: dedupe(issues),
    next,
  };
}

function consoleResultView(result: ConsoleSearchResult, nonce: string): ResultWithHash {
  const location = result.location;
  const clock = location?.kind === "meeting" ? (location.clock ?? formatClock(location.startSeconds ?? null)) : null;
  return {
    ref: result.ref,
    origin: "console",
    kind: result.kind,
    trust: result.trust,
    header: buildKnowledgeHeader({
      projectName: result.project?.name ?? null,
      kind: result.kind,
      title: result.document?.title ?? result.source?.title ?? null,
      recordedAt: result.recordedAt ?? null,
      clock,
      trust: result.trust,
      speakers: result.speakers ?? [],
    }),
    excerpt: fenceKnowledgeText(result.text ?? "", { nonce, trust: result.trust, ref: result.ref }),
    url: result.url ?? null,
    recordedAt: result.recordedAt ?? null,
    project: result.project ?? null,
    speakers: [...(result.speakers ?? [])],
    score: typeof result.score === "number" ? result.score : 0,
    textHash: mergeHash(result.text ?? "", result.ref),
  };
}

function localHitView(hit: LocalSearchHit, nonce: string): ResultWithHash {
  const trust: KnowledgeTrustTier = "said";
  const recordedAt = Number.isFinite(hit.recordedAt) ? new Date(hit.recordedAt).toISOString() : null;
  return {
    ref: hit.ref,
    origin: "local",
    kind: hit.kind,
    trust,
    header: localHeader(hit, trust),
    excerpt: fenceKnowledgeText(hit.text, { nonce, trust, ref: hit.ref }),
    url: null,
    recordedAt,
    project: null,
    speakers: hit.speaker ? [hit.speaker] : [],
    score: Math.round(-hit.bm25 * 10_000) / 10_000,
    textHash: mergeHash(hit.text, hit.ref),
  };
}

function localHeader(
  hit: Pick<LocalSearchHit, "kind" | "speaker" | "channel" | "sessionName" | "recordedAt" | "startSec" | "meetingKey">,
  trust: KnowledgeTrustTier,
): string {
  return buildKnowledgeHeader({
    projectName: null,
    kind: hit.kind,
    title: hit.kind === "transcript" ? hit.meetingKey : null,
    recordedAt: Number.isFinite(hit.recordedAt) ? hit.recordedAt : null,
    clock: hit.kind === "transcript" ? formatClock(hit.startSec) : null,
    trust,
    speakers: hit.kind === "transcript" && hit.speaker ? [hit.speaker] : [],
    chat: hit.kind === "chat" ? { channel: hit.channel, senderName: hit.speaker, sessionName: hit.sessionName } : null,
  });
}

function resolveAboutChatIds(about: NonNullable<KnowledgeSearchInput["about"]>, deps: KnowledgeDeps): string[] {
  if (about.kind === "contact") return (deps.chatIdsForContact ?? chatIdsForContact)(about.id);
  return (deps.chatIdsForChat ?? defaultChatIdsForChat)(about.id);
}

function defaultChatIdsForChat(chatRef: string): string[] {
  const ids = new Set<string>([chatRef]);
  try {
    for (const chat of dbListChatsByRef({ ref: chatRef, limit: 20 })) {
      ids.add(chat.platformChatId);
      ids.add(chat.normalizedChatId);
    }
  } catch {
    // Unknown chat: the given id only.
  }
  return [...ids].filter(Boolean);
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const CONSOLE_REF = /^kc:[0-9a-f-]{8,64}$/i;
const MESSAGE_REF = /^km:\d+$/;
const TRANSCRIPT_REF = /^kt:[^:\s]+:\d+$/;

export async function runKnowledgeRead(
  input: { ref: string; around?: number; turn: KnowledgeTurn },
  deps: KnowledgeDeps = {},
): Promise<KnowledgeReadPayload> {
  const ref = input.ref?.trim() ?? "";
  const around = Math.max(0, Math.min(5, Math.trunc(input.around ?? 0)));
  const nonce = (deps.nonce ?? newKnowledgeNonce)();
  if (CONSOLE_REF.test(ref)) return readConsoleRef(ref, around, nonce, input.turn, deps);
  if (MESSAGE_REF.test(ref) || TRANSCRIPT_REF.test(ref)) return readLocalRef(ref, around, nonce, input.turn, deps);
  throw payloadInvalid("A ref is kc:<id>, km:<id> or kt:<meeting>:<segment>.");
}

async function readConsoleRef(
  ref: string,
  around: number,
  nonce: string,
  turn: KnowledgeTurn,
  deps: KnowledgeDeps,
): Promise<KnowledgeReadPayload> {
  const client = await (deps.openClient ?? defaultOpenClient)();
  if (!client) throw loginRequired();
  const response: ConsoleReadResponse = await client.read({ ref, around }, turn);
  const focus = response.chunks.find((chunk) => chunk.focus) ?? response.chunks[0] ?? null;
  const text = response.chunks.map((chunk) => `${chunk.focus ? "▶ " : ""}${chunk.text}`).join("\n");
  const location = focus?.location;
  const clock = location?.kind === "meeting" ? (location.clock ?? formatClock(location.startSeconds ?? null)) : null;
  const speakers = [...new Set(response.chunks.flatMap((chunk) => chunk.speakers ?? []))];
  if (turn.turnKey) (deps.recordTurnRead ?? recordTurnRead)(turn.turnKey, response.trust);
  insertLocalRun({
    turnKey: turn.turnKey,
    sessionName: turn.sessionName,
    consoleRunId: response.runId ?? null,
    queryHash: queryHash(`read ${ref}`),
    refs: [{ ref: response.ref || ref, trust: response.trust }],
    lowestTier: response.trust,
    issues: [],
  });
  const next: string[] = [];
  for (const command of response.next ?? []) pushUnique(next, command);
  pushUnique(next, "ravi knowledge why --last");
  return {
    ref: response.ref || ref,
    nonce,
    rule: KNOWLEDGE_RULE,
    trust: response.trust,
    header: buildKnowledgeHeader({
      projectName: response.project?.name ?? null,
      kind: response.kind,
      title: response.document?.title ?? response.source?.title ?? null,
      recordedAt: null,
      clock,
      trust: response.trust,
      speakers,
    }),
    excerpt: fenceKnowledgeText(text, { nonce, trust: response.trust, ref: response.ref || ref }),
    url: response.url ?? null,
    runId: response.runId ?? null,
    issues: [],
    next,
  };
}

function readLocalRef(
  ref: string,
  around: number,
  nonce: string,
  turn: KnowledgeTurn,
  deps: KnowledgeDeps,
): KnowledgeReadPayload {
  const result: LocalReadResult | null = (deps.readLocal ?? readLocal)(ref, around);
  if (!result) throw new CloudAuthError("NOT_FOUND", "Knowledge ref was not found.", { status: 404 });
  const trust: KnowledgeTrustTier = "said";
  const text = result.rows
    .map((row) => {
      const clock = row.kind === "transcript" ? formatClock(row.startSec) : null;
      const who = row.speaker ? `«${row.speaker}»: ` : "";
      return `${row.focus ? "▶ " : ""}${clock ? `[${clock}] ` : ""}${who}${row.text}`;
    })
    .join("\n");
  if (turn.turnKey) (deps.recordTurnRead ?? recordTurnRead)(turn.turnKey, trust);
  const run = insertLocalRun({
    turnKey: turn.turnKey,
    sessionName: turn.sessionName,
    consoleRunId: null,
    queryHash: queryHash(`read ${ref}`),
    refs: [{ ref: result.ref, trust }],
    lowestTier: trust,
    issues: [],
  });
  const next: string[] = [];
  if (around < 5) pushUnique(next, `ravi knowledge read ${result.ref} --around ${Math.min(5, around + 2)}`);
  pushUnique(next, "ravi knowledge why --last");
  return {
    ref: result.ref,
    nonce,
    rule: KNOWLEDGE_RULE,
    trust,
    header: localHeader(result.focus, trust),
    excerpt: fenceKnowledgeText(text, { nonce, trust, ref: result.ref }),
    url: null,
    runId: `kl:${run.id}`,
    issues: [],
    next,
  };
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

export async function runKnowledgeWhy(
  input: { last?: boolean; runId?: string; session?: string; limit?: number; turn: KnowledgeTurn },
  deps: KnowledgeDeps = {},
): Promise<KnowledgeWhyPayload> {
  const issues: string[] = [];
  const limit = input.last ? 1 : Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
  const runId = input.runId?.trim();
  let runs: KnowledgeWhyRun[];

  if (runId) {
    runs = [await whyForRunId(runId, input.turn, deps, issues)];
  } else {
    const turnKey = input.turn.turnKey;
    const locals = listLocalRuns({
      turnKey,
      session: input.session ?? null,
      limit,
    });
    const client = await openClientForOptional(deps, issues);
    const views = await Promise.all(locals.map((run) => localRunView(run, client, input.turn, issues)));
    runs = views;
    if (!input.last && client) {
      try {
        const listed = await client.runs(
          {
            ...(turnKey ? { turnKey } : {}),
            ...(input.session ? { session: input.session } : {}),
            limit,
          },
          input.turn,
        );
        const known = new Set(locals.map((run) => run.consoleRunId).filter(Boolean));
        for (const summary of listed.runs ?? []) {
          if (!known.has(summary.runId)) runs.push(consoleSummaryView(summary, []));
        }
      } catch (error) {
        if (!isConsoleUnavailable(error)) throw error;
        issues.push(`console_unavailable: ${error.code}`);
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      runs = runs.slice(0, limit);
    }
  }

  const next: string[] = [];
  const firstRef = runs.flatMap((run) => run.citations).find((citation) => citation.available)?.ref;
  if (firstRef) pushUnique(next, `ravi knowledge read ${firstRef} --around 2`);
  pushUnique(next, 'ravi knowledge search "<terms>"');
  return { runs, issues: dedupe(issues), next };
}

async function whyForRunId(
  runId: string,
  turn: KnowledgeTurn,
  deps: KnowledgeDeps,
  issues: string[],
): Promise<KnowledgeWhyRun> {
  if (runId.startsWith("kl:") || (!runId.startsWith("kr:") && getLocalRun(runId))) {
    const local = getLocalRun(runId);
    if (!local) throw new CloudAuthError("NOT_FOUND", "Knowledge run was not found.", { status: 404 });
    const client = await openClientForOptional(deps, issues);
    return localRunView(local, client, turn, issues);
  }
  const id = runId.startsWith("kr:") ? runId.slice(3) : runId;
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw payloadInvalid("A run id is kr:<id> or kl:<id>.");
  const client = await (deps.openClient ?? defaultOpenClient)();
  if (!client) throw loginRequired();
  const detail = await client.run(id, turn);
  return consoleSummaryView(detail.run, detail.citations ?? []);
}

async function localRunView(
  run: LocalRun,
  client: KnowledgeClient | null,
  turn: KnowledgeTurn,
  issues: string[],
): Promise<KnowledgeWhyRun> {
  const local = describeLocalRefs(run.refs.map((ref) => ref.ref));
  let consoleCitations: Map<string, ConsoleRunCitation> | null = null;
  let consoleSummary: ConsoleRunSummary | null = null;
  if (run.consoleRunId && run.refs.some((ref) => ref.ref.startsWith("kc:"))) {
    if (client) {
      try {
        const detail = await client.run(run.consoleRunId, turn);
        consoleSummary = detail.run;
        consoleCitations = new Map((detail.citations ?? []).map((citation) => [citation.ref, citation]));
      } catch (error) {
        if (!isConsoleUnavailable(error) && !(isCloudAuthError(error) && error.code === "NOT_FOUND")) throw error;
        issues.push(isCloudAuthError(error) ? `console_unavailable: ${error.code}` : "console_unavailable");
      }
    }
  }
  const citations: KnowledgeWhyCitation[] = run.refs.map((entry) => {
    if (entry.ref.startsWith("kc:")) {
      const citation = consoleCitations?.get(entry.ref);
      if (citation) return consoleCitationView(citation);
      // Not re-checked live (Console unreachable): no header, no link.
      return { ref: entry.ref, trust: entry.trust, header: null, url: null, available: consoleCitations === null };
    }
    const hit = local.get(entry.ref);
    return hit
      ? { ref: entry.ref, trust: entry.trust, header: localHeader(hit, entry.trust), url: null, available: true }
      : { ref: entry.ref, trust: null, header: null, url: null, available: false };
  });
  return {
    id: `kl:${run.id}`,
    createdAt: new Date(run.createdAt).toISOString(),
    origin: "local",
    audience: "operator",
    query: consoleSummary?.normalizedQuery ?? null,
    citations,
    withheld: consoleSummary?.withheld ?? null,
  };
}

function consoleSummaryView(summary: ConsoleRunSummary, citations: ConsoleRunCitation[]): KnowledgeWhyRun {
  return {
    id: `kr:${summary.runId}`,
    createdAt: summary.createdAt,
    origin: "console",
    audience: "operator",
    query: summary.normalizedQuery ?? null,
    citations: citations.map(consoleCitationView),
    withheld: summary.withheld ?? null,
  };
}

function consoleCitationView(citation: ConsoleRunCitation): KnowledgeWhyCitation {
  if (!citation.available) return { ref: citation.ref, trust: null, header: null, url: null, available: false };
  return {
    ref: citation.ref,
    trust: citation.trust,
    header: buildKnowledgeHeader({
      projectName: null,
      kind: citation.kind,
      title: citation.title,
      recordedAt: null,
      trust: citation.trust,
    }).replace(/^local · /, ""),
    url: citation.url ?? null,
    available: true,
  };
}

// ---------------------------------------------------------------------------
// sources and marks
// ---------------------------------------------------------------------------

export async function runKnowledgeSources(
  input: { failing?: boolean; turn: KnowledgeTurn },
  deps: KnowledgeDeps = {},
): Promise<KnowledgeSourcesPayload> {
  const issues: string[] = [];
  let sources: KnowledgeSourcesPayload["console"] = null;
  const client = await openClientForOptional(deps, issues);
  if (client) {
    try {
      const response = await client.sources({ ...(input.failing ? { failing: true } : {}), limit: 50 }, input.turn);
      sources = response.sources ?? [];
    } catch (error) {
      if (!isConsoleUnavailable(error)) throw error;
      issues.push(`console_unavailable: ${error.code}`);
    }
  }
  const stats = localIndexStats();
  const next: string[] = [];
  if (!input.failing) pushUnique(next, "ravi knowledge sources --failing");
  pushUnique(next, 'ravi knowledge search "<terms>"');
  return {
    console: sources,
    local: {
      chatRows: stats.chatRows,
      transcriptRows: stats.transcriptRows,
      lastIndexedAt: stats.lastIndexedAt ? new Date(stats.lastIndexedAt).toISOString() : null,
      fts5: stats.fts5,
    },
    issues: dedupe(issues),
    next,
  };
}

export async function runKnowledgeMarks(
  input: { url?: string; turn: KnowledgeTurn },
  deps: KnowledgeDeps = {},
): Promise<KnowledgeMarksPayload> {
  const client = await (deps.openClient ?? defaultOpenClient)();
  if (!client) throw loginRequired();
  const url = input.url?.trim();
  const response = await client.marks(url ? { url } : {}, input.turn);
  const next: string[] = [];
  if (response.card?.url) pushUnique(next, `open ${response.card.url} in a browser to mark it for clients`);
  if (!url) pushUnique(next, "ravi knowledge marks --url <page url>");
  pushUnique(next, 'ravi knowledge search "<terms>" --type page');
  return { marks: response.marks ?? [], card: response.card ?? null, issues: [], next };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOpenClient(): Promise<KnowledgeClient | null> {
  return openKnowledgeClient();
}

function defaultInGateway(): boolean {
  return getContext({ localOnly: true })?.transport === "gateway";
}

async function openClientForOptional(deps: KnowledgeDeps, issues: string[]): Promise<KnowledgeClient | null> {
  const client = await (deps.openClient ?? defaultOpenClient)();
  if (!client) issues.push("console_not_logged_in");
  return client;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(KNOWLEDGE_SEARCH_MAX_LIMIT, Math.trunc(limit)));
}

function payloadInvalid(message: string): CloudAuthError {
  return new CloudAuthError("PAYLOAD_INVALID", message, { exitCode: 2 });
}

function loginRequired(): CloudAuthError {
  return new CloudAuthError("AUTH_REQUIRED", "Knowledge needs a Ravi Cloud login. Run `ravi login`.");
}

/** Hash for merge dedupe: the same text from either origin is one result. */
function mergeHash(text: string, ref: string): string {
  const folded = foldKnowledgeText(text);
  return createHash("sha256")
    .update(folded || ref)
    .digest("hex");
}

/** Run rows keep a hash of the folded query, never the query. */
function queryHash(query: string): string {
  return createHash("sha256").update(foldKnowledgeText(query)).digest("hex");
}

/** `console_unavailable: SERVER_UNAVAILABLE` is stored as is; nothing free-form reaches a run row. */
function issueCode(issue: string): string {
  return issue.replace(/[^A-Za-z0-9_:. -]/g, "").slice(0, 80);
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
