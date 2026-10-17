// Knowledge memory types (spec knowledge): the local payloads `ravi knowledge`
// returns and the Console wire shapes of `/api/cli/knowledge/*`. The Console
// owns access, ranking and runs; this side only carries them.

import type { ExecContextV1 } from "../link/connector-turn.js";

/** Ordered from highest to lowest. */
export type KnowledgeTrustTier = "approved" | "published" | "said" | "inferred";
export const TRUST_ORDER: readonly KnowledgeTrustTier[] = ["approved", "published", "said", "inferred"];

/** The lowest tier among `tiers`, or null when there is none. */
export function lowestTier(tiers: Iterable<KnowledgeTrustTier>): KnowledgeTrustTier | null {
  let lowest: KnowledgeTrustTier | null = null;
  for (const tier of tiers) {
    if (!TRUST_ORDER.includes(tier)) continue;
    if (lowest === null || TRUST_ORDER.indexOf(tier) > TRUST_ORDER.indexOf(lowest)) lowest = tier;
  }
  return lowest;
}

export function isKnowledgeTrustTier(value: unknown): value is KnowledgeTrustTier {
  return typeof value === "string" && (TRUST_ORDER as readonly string[]).includes(value);
}

export type KnowledgeKind = "meeting" | "transcript" | "page" | "note" | "manual" | "chat";
/** Kinds the Console stores (everything but local chat). */
export type ConsoleKnowledgeKind = Exclude<KnowledgeKind, "chat">;
export const CONSOLE_KNOWLEDGE_KINDS: readonly ConsoleKnowledgeKind[] = [
  "meeting",
  "transcript",
  "page",
  "note",
  "manual",
];
export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [...CONSOLE_KNOWLEDGE_KINDS, "chat"];

/**
 * The channel of a curator turn. The gateway delivers nothing for it and the
 * local indexer never reads its rows.
 */
export const KNOWLEDGE_CURATOR_CHANNEL = "knowledge-curator";

/** An operator turn that may use Knowledge (the classifier's verdict). */
export interface KnowledgeTurn {
  audience: "operator";
  turnKey: string | null;
  sessionName: string | null;
  agentId: string | null;
  /** Sent as `X-Ravi-Exec-Context`, never with `speaker.consoleUserId`. */
  execContext: ExecContextV1;
}

export interface KnowledgeSearchInput {
  query: string;
  about?: { kind: "contact" | "chat"; id: string } | null;
  kinds?: KnowledgeKind[];
  who?: string | null;
  since?: Date | null;
  project?: string | null;
  limit?: number;
  localOnly?: boolean;
  turn: KnowledgeTurn;
}

export interface KnowledgeProjectRef {
  id: string;
  slug: string;
  name: string;
}

export interface KnowledgeResultView {
  ref: string;
  origin: "console" | "local";
  kind: KnowledgeKind;
  trust: KnowledgeTrustTier;
  header: string;
  /** Fenced, neutralized text. */
  excerpt: string;
  url: string | null;
  recordedAt: string | null;
  project: KnowledgeProjectRef | null;
  speakers: string[];
  score: number;
}

export interface KnowledgeWithheld {
  count: number;
  reasons: Record<string, number>;
}

export interface KnowledgeSearchPayload {
  query: string;
  audience: "operator";
  nonce: string;
  rule: string;
  results: KnowledgeResultView[];
  withheld: KnowledgeWithheld | null;
  runId: string | null;
  localRunId: string;
  issues: string[];
  next: string[];
}

export interface KnowledgeReadPayload {
  ref: string;
  nonce: string;
  rule: string;
  trust: KnowledgeTrustTier;
  header: string;
  /** Fenced; neighbours joined, the focus line prefixed "▶ ". */
  excerpt: string;
  url: string | null;
  runId: string | null;
  issues: string[];
  next: string[];
}

export interface KnowledgeWhyCitation {
  ref: string;
  trust: KnowledgeTrustTier | null;
  header: string | null;
  url: string | null;
  available: boolean;
}

export interface KnowledgeWhyRun {
  /** `kr:<uuid>` (Console run) or `kl:<uuid>` (local run). */
  id: string;
  createdAt: string;
  origin: "console" | "local";
  audience: "operator";
  query: string | null;
  citations: KnowledgeWhyCitation[];
  withheld: KnowledgeWithheld | null;
}

export interface KnowledgeWhyPayload {
  runs: KnowledgeWhyRun[];
  issues: string[];
  next: string[];
}

export interface KnowledgeSourcesPayload {
  console: ConsoleSourcesResponse["sources"] | null;
  local: { chatRows: number; transcriptRows: number; lastIndexedAt: string | null; fts5: boolean };
  issues: string[];
  next: string[];
}

export interface KnowledgeMarksPayload {
  marks: ConsoleMarksResponse["marks"];
  card: ConsoleMarksResponse["card"];
  issues: string[];
  next: string[];
}

// ---------------------------------------------------------------------------
// Console wire types (`/api/cli/knowledge/*`)
// ---------------------------------------------------------------------------

export interface ConsoleSearchRequest {
  query: string;
  limit?: number;
  kinds?: ConsoleKnowledgeKind[];
  /** ISO timestamp. */
  since?: string;
  who?: string;
  project?: string;
}

export type ConsoleKnowledgeLocation =
  | { kind: "meeting"; meetingId: string; startSeconds: number | null; clock: string | null; part?: number }
  | { kind: "page"; host: string; path: string; anchor: string | null; heading: string | null }
  | { kind: "note" };

export interface ConsoleKnowledgeSourceRef {
  id: string;
  title: string;
  originKey: string | null;
}

export interface ConsoleKnowledgeDocumentRef {
  id: string;
  version: number;
  title: string;
}

export interface ConsoleSearchResult {
  ref: string;
  kind: ConsoleKnowledgeKind;
  trust: KnowledgeTrustTier;
  project: KnowledgeProjectRef | null;
  source: ConsoleKnowledgeSourceRef;
  document: ConsoleKnowledgeDocumentRef;
  text: string;
  speakers: string[];
  location: ConsoleKnowledgeLocation;
  url: string | null;
  recordedAt: string | null;
  score: number;
  next: string[];
}

export interface ConsoleSearchResponse {
  runId: string;
  audience: "operator";
  query: { normalized: string; mode: "and" | "or" };
  results: ConsoleSearchResult[];
  withheld: KnowledgeWithheld;
  issues: string[];
}

export interface ConsoleReadChunk {
  ref: string;
  ordinal: number;
  text: string;
  speakers: string[];
  location: ConsoleKnowledgeLocation;
  focus: boolean;
}

export interface ConsoleReadResponse {
  runId: string;
  ref: string;
  kind: ConsoleKnowledgeKind;
  trust: KnowledgeTrustTier;
  project: KnowledgeProjectRef | null;
  source: ConsoleKnowledgeSourceRef;
  document: ConsoleKnowledgeDocumentRef;
  chunks: ConsoleReadChunk[];
  url: string | null;
  next: string[];
}

export interface ConsoleRunSummary {
  runId: string;
  createdAt: string;
  status: "completed" | "denied" | "failed";
  audience: "operator";
  normalizedQuery: string | null;
  turnKey: string | null;
  sessionName: string | null;
  citationCount: number;
  withheld: KnowledgeWithheld;
}

export type ConsoleRunCitation =
  | {
      rank: number;
      ref: string;
      kind: ConsoleKnowledgeKind;
      trust: KnowledgeTrustTier;
      title: string;
      documentVersion: number;
      textHash: string;
      url: string | null;
      available: true;
    }
  | { rank: number; ref: string; available: false };

export interface ConsoleRunDetail {
  run: ConsoleRunSummary;
  citations: ConsoleRunCitation[];
}

export interface ConsoleSourceRow {
  id: string;
  kind: ConsoleKnowledgeKind;
  title: string;
  project: KnowledgeProjectRef | null;
  trust: KnowledgeTrustTier;
  status: string;
  documents: number;
  chunks: number;
  lastJob: { status: string; triggerType: string; at: string; failureCode: string | null } | null;
}

export interface ConsoleSourcesResponse {
  sources: ConsoleSourceRow[];
  nextCursor: string | null;
}

export interface ConsoleMarkRow {
  routeId: string;
  url: string;
  state: "active" | "suspended";
  /** `page_viewers` or `contacts:<instance>`. */
  audiences: string[];
  approvedVersion: number;
  approvedAt: string | null;
  cardUrl: string;
}

export interface ConsoleMarksResponse {
  marks: ConsoleMarkRow[];
  card: { url: string } | null;
}

export type ConsoleProposalKind = "note" | "gap" | "correction" | "transcript";

export type ConsoleRequestedAudience = { kind: "contacts"; instanceId: string; label: string } | { kind: "members" };

export interface ConsoleProposalCreate {
  kind: ConsoleProposalKind;
  project: string | null;
  title: string | null;
  body: string;
  evidence: Array<{ ref: string; textHash: string }>;
  supersedes: string | null;
  requestedAudience: ConsoleRequestedAudience;
  dedupeKey?: string | null;
  idempotencyKey: string;
}

export interface ConsoleProposalView {
  id: string;
  kind: ConsoleProposalKind;
  status: string;
  projectId: string | null;
  title: string | null;
  body: string;
  answer: string | null;
  faq: { url: string; anchor: string } | null;
  waitingCount: number;
  cardUrl: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface ConsoleDigest {
  generatedAt: string;
  unanswered: Array<{
    id: string;
    question: string;
    waitingCount: number;
    cardUrl: string;
    createdAt: string;
    project: KnowledgeProjectRef | null;
  }>;
  pending: { notes: number; corrections: number; transcripts: number };
  suspendedMarks: Array<{ routeId: string; url: string; reason: string; cardUrl: string }>;
}

export interface ConsoleMirrorSection {
  stableKey: string;
  heading: string | null;
  anchor: string | null;
  text: string;
}

export interface ConsoleMirrorPage {
  routeId: string;
  url: string;
  host: string;
  path: string;
  title: string | null;
  documentId: string;
  version: number;
  approvedAt: string | null;
  /** Instance names (`instances.name`). */
  instances: string[];
  sections: ConsoleMirrorSection[];
}

export interface ConsoleMirror {
  generatedAt: string;
  ttlSeconds: number;
  raviHosts: string[];
  pages: ConsoleMirrorPage[];
}
