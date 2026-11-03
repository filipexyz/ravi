import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { findAccessibleProjectRecord, listAccessibleProjectRecords } from "@/server/console/project-access";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import type { SystemMeetingSegment } from "@/server/console/meetings/system";

import type { KnowledgeOperatorCaller } from "./caller";
import { publishFaqAnswer } from "./faq";
import { knowledgeProposalCardUrl, knowledgeRouteCardUrl } from "./inbox";
import { listMarkedRoutes, readRouteMark, writeRouteMark, type KnowledgeMarkAudience, type KnowledgeRouteMark } from "./marks";
import { ingestForProducer, type ProducerChunkInput, type ProducerIngestResult } from "./producer";
import { purgedProposalBody } from "./proposal-body";
import { buildMeetingTranscriptChunks, meetingRetentionMonths } from "./producers/meeting";
import { neutralizeKnowledgeText } from "./text";

// Proposals are what an installation asks the organization to approve: a
// note or correction (becomes an `approved` source), a local meeting
// transcript (a `said` source) or a gap a contact asked (answered on /faq).
// The CLI creates and reads them; only a web session decides, on the
// one-card pages under /k.

export type KnowledgeProposalKind = "note" | "gap" | "correction" | "transcript";
export type KnowledgeProposalDecision = "publish" | "approve" | "reject" | "dismiss";

export type KnowledgeProposalView = {
  id: string;
  kind: KnowledgeProposalKind;
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
};

export type KnowledgeDigest = {
  generatedAt: string;
  unanswered: Array<{
    id: string;
    question: string;
    waitingCount: number;
    cardUrl: string;
    createdAt: string;
    project: { id: string; slug: string; name: string } | null;
  }>;
  pending: { notes: number; corrections: number; transcripts: number };
  suspendedMarks: Array<{ routeId: string; url: string; reason: string; cardUrl: string }>;
};

/** Body limits per kind, in characters (transcripts: UTF-8 bytes of the `transcription.json` text). */
export const KNOWLEDGE_PROPOSAL_BODY_LIMITS: Record<KnowledgeProposalKind, number> = {
  note: 8000,
  gap: 1000,
  correction: 8000,
  transcript: 2 * 1024 * 1024,
};
const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_CHUNK_MAX_CHARS = 1200;
const CARD_TRANSCRIPT_LINES = 40;
const CARD_SECTION_LIMIT = 60;
const CARD_SECTION_TEXT_CHARS = 600;
const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const proposalBodySchema = z.object({
  kind: z.enum(["note", "gap", "correction", "transcript"]),
  project: z.string().trim().min(1).max(200).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().min(1),
  evidence: z
    .array(z.object({ ref: z.string().min(1).max(200), textHash: z.string().max(128).optional().default("") }))
    .max(50)
    .optional()
    .default([]),
  supersedes: z.string().trim().min(1).max(200).nullable().optional(),
  requestedAudience: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("contacts"), instanceId: z.string().regex(INSTANCE_ID), label: z.string().trim().max(80).optional().default("") }),
      z.object({ kind: z.literal("members") }),
    ])
    .nullable()
    .optional(),
  dedupeKey: z.string().trim().min(1).max(200).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export type ParsedKnowledgeProposalBody = z.infer<typeof proposalBodySchema>;

const KC_REF = /^kc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Evidence as stored: for `kc:<chunkId>` refs the hash is the chunk's own
 * `text_hash` (the CLI holds no chunk text and sends `textHash: ""`). A client
 * hash is never trusted over the stored one. Chunks of other organizations and
 * unknown chunks keep what was sent.
 */
export async function resolveEvidenceHashes(
  organizationId: string,
  evidence: ReadonlyArray<{ ref: string; textHash: string }>,
): Promise<Array<{ ref: string; textHash: string }>> {
  const chunkIds = [...new Set(evidence.flatMap((item) => KC_REF.exec(item.ref)?.[1]?.toLowerCase() ?? []))];
  const hashes = new Map<string, string>();
  if (chunkIds.length > 0) {
    const rows = await db
      .select({ id: schema.knowledgeChunks.id, textHash: schema.knowledgeChunks.textHash })
      .from(schema.knowledgeChunks)
      .where(and(eq(schema.knowledgeChunks.organizationId, organizationId), inArray(schema.knowledgeChunks.id, chunkIds)));
    for (const row of rows) hashes.set(row.id.toLowerCase(), row.textHash);
  }
  return evidence.map((item) => {
    const chunkId = KC_REF.exec(item.ref)?.[1]?.toLowerCase();
    return { ref: item.ref, textHash: (chunkId && hashes.get(chunkId)) || item.textHash };
  });
}

/** Validates a `POST /api/cli/knowledge/proposals` body; 400 `PAYLOAD_INVALID` on any problem, before any database read. */
export function parseKnowledgeProposalBody(body: unknown): ParsedKnowledgeProposalBody {
  const parsed = proposalBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid proposal: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "bad body"}.`);
  }
  const value = parsed.data;
  const limit = KNOWLEDGE_PROPOSAL_BODY_LIMITS[value.kind];
  const size = value.kind === "transcript" ? Buffer.byteLength(value.body, "utf8") : value.body.length;
  if (size > limit) {
    throw cliApiError(400, "PAYLOAD_INVALID", `A ${value.kind} proposal body is at most ${value.kind === "transcript" ? "2 MB" : `${limit} characters`}.`);
  }
  if (!value.body.trim()) throw cliApiError(400, "PAYLOAD_INVALID", "The proposal body is empty.");
  if (value.kind !== "note" && !value.project) {
    throw cliApiError(400, "PAYLOAD_INVALID", `A ${value.kind} proposal needs a project.`);
  }
  if (value.kind === "gap" && value.requestedAudience?.kind !== "contacts") {
    throw cliApiError(400, "PAYLOAD_INVALID", "A gap names the contacts audience that asked (requestedAudience.kind \"contacts\").");
  }
  if (value.kind === "correction" && !value.supersedes) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A correction names the ref it corrects (supersedes).");
  }
  if (value.kind === "transcript" && !parseTranscriptSegments(value.body)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "A transcript body is the text of transcription.json with a segments array.");
  }
  return value;
}

export async function createKnowledgeProposal(input: {
  caller: KnowledgeOperatorCaller;
  body: unknown;
  requestId: string;
  origin: string;
}): Promise<{ proposal: KnowledgeProposalView; deduped: boolean; created: boolean }> {
  const body = parseKnowledgeProposalBody(input.body);
  const caller = input.caller;
  const organizationId = caller.workspace.organization.id;

  let projectId: string | null = null;
  if (body.project) {
    const project = await findAccessibleProjectRecord(caller.workspace, body.project, "read");
    if (!project) throw cliApiError(404, "NOT_FOUND", "Project not found.");
    projectId = project.id;
  }

  const replay = await findByIdempotencyKey(organizationId, body.idempotencyKey);
  if (replay) return replayed(replay, caller, input.origin);

  const dedupeKey = body.kind === "gap" ? (body.dedupeKey ?? null) : null;
  if (dedupeKey) {
    const bumped = await bumpPendingGap(organizationId, caller.localInstallationId, dedupeKey);
    if (bumped) return { proposal: toProposalView(bumped, input.origin), deduped: true, created: false };
  }

  const now = new Date();
  const requestedAudience: JsonRecord =
    body.kind === "gap" && body.requestedAudience?.kind === "contacts"
      ? {
          kind: "contacts",
          // Forced: a gap is always answered to the installation that sent it.
          localInstallationId: caller.localInstallationId,
          instanceId: body.requestedAudience.instanceId,
          label: body.requestedAudience.label || body.requestedAudience.instanceId,
        }
      : { kind: "members" };

  const [inserted] = await db
    .insert(schema.knowledgeProposals)
    .values({
      organizationId,
      projectId,
      kind: body.kind,
      status: "pending",
      title: body.title ?? null,
      body: body.body,
      evidenceJson: await resolveEvidenceHashes(organizationId, body.evidence),
      supersedesRef: body.kind === "correction" ? (body.supersedes ?? null) : null,
      requestedAudienceJson: requestedAudience,
      proposedByJson: caller.callerJson,
      localInstallationId: caller.localInstallationId,
      dedupeKey,
      idempotencyKey: body.idempotencyKey,
      waitingCount: 1,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Lost a race on one of the two unique indexes: answer as the winner did.
    const winner = await findByIdempotencyKey(organizationId, body.idempotencyKey);
    if (winner) return replayed(winner, caller, input.origin);
    if (dedupeKey) {
      const bumped = await bumpPendingGap(organizationId, caller.localInstallationId, dedupeKey);
      if (bumped) return { proposal: toProposalView(bumped, input.origin), deduped: true, created: false };
    }
    throw cliApiError(409, "CONFLICT", "A matching proposal is being created; retry.");
  }

  await db.insert(schema.auditEvents).values({
    organizationId,
    projectId,
    actorType: "cli",
    actorId: caller.workspace.user.id,
    targetType: "knowledge_proposal",
    targetId: inserted.id,
    action: "knowledge_proposal.created",
    requestId: input.requestId,
    metadataJson: { proposalId: inserted.id, kind: inserted.kind, localInstallationId: caller.localInstallationId, evidenceCount: body.evidence.length },
  });
  return { proposal: toProposalView(inserted, input.origin), deduped: false, created: true };
}

/** 404 unless the same organization and (the same installation, or the caller can read the proposal's project). */
export async function getKnowledgeProposalForCaller(input: {
  caller: KnowledgeOperatorCaller;
  id: string;
  origin: string;
}): Promise<KnowledgeProposalView> {
  const notFound = () => cliApiError(404, "NOT_FOUND", "Proposal not found.");
  if (!UUID.test(input.id)) throw notFound();
  const proposal = await loadProposal(input.id);
  if (!proposal || proposal.organizationId !== input.caller.workspace.organization.id) throw notFound();
  if (proposal.localInstallationId !== input.caller.localInstallationId && proposal.projectId) {
    const project = await findAccessibleProjectRecord(input.caller.workspace, proposal.projectId, "read");
    if (!project) throw notFound();
  }
  return toProposalView(proposal, input.origin);
}

export type DecideKnowledgeProposalDeps = {
  publishFaq?: typeof publishFaqAnswer;
  ingest?: typeof ingestForProducer;
  buildTranscriptChunks?: (input: { segments: readonly SystemMeetingSegment[] }) => ProducerChunkInput[];
  retentionMonths?: (projectMetadata: unknown) => number;
  now?: () => Date;
};

/**
 * Decides a proposal from a web session. Project items need project admin
 * (org owner, org admin or `project_admin`); org-level items need org owner
 * or admin. Gaps take publish or dismiss; the other kinds approve or reject.
 */
export async function decideKnowledgeProposal(
  input: {
    workspace: ConsoleWorkspace;
    id: string;
    decision: KnowledgeProposalDecision;
    answer?: string;
    faqQuestion?: string;
    requestId: string;
    origin?: string;
  },
  deps: DecideKnowledgeProposalDeps = {},
): Promise<KnowledgeProposalView> {
  const origin = input.origin ?? raviLinkConsoleOrigin("https://console.ravi.bot/");
  const now = deps.now ?? (() => new Date());
  const proposal = UUID.test(input.id) ? await loadProposal(input.id) : null;
  if (!proposal || proposal.organizationId !== input.workspace.organization.id) {
    throw new ConsoleApiError(404, { error: "knowledge_proposal_not_found" });
  }
  if (!(await canDecideItem(input.workspace, proposal.projectId))) {
    throw new ConsoleApiError(403, { error: "knowledge_proposal_forbidden" });
  }
  if (proposal.status !== "pending" || proposal.expiresAt <= now()) {
    throw new ConsoleApiError(409, { error: "knowledge_proposal_closed" });
  }
  const allowed = proposal.kind === "gap" ? ["publish", "dismiss"] : ["approve", "reject"];
  if (!allowed.includes(input.decision)) throw new ConsoleApiError(400, { error: "invalid_decision" });

  const actorUserId = input.workspace.user.id;
  if (input.decision === "publish") {
    await (deps.publishFaq ?? publishFaqAnswer)({
      proposalId: proposal.id,
      answer: input.answer ?? "",
      faqQuestion: input.faqQuestion?.trim() || proposal.body || "",
      actorUserId,
      requestId: input.requestId,
      origin,
    });
  } else if (input.decision === "reject" || input.decision === "dismiss") {
    await closeProposal(proposal, { status: "rejected", actorUserId, requestId: input.requestId, decision: input.decision, now: now(), resultJson: {} });
  } else {
    const result = await ingestApprovedProposal(proposal, { actorUserId, requestId: input.requestId, now: now() }, deps);
    if (result.status === "skipped") throw new ConsoleApiError(409, { error: `knowledge_proposal_${result.reason}` });
    await closeProposal(proposal, {
      status: "approved",
      actorUserId,
      requestId: input.requestId,
      decision: input.decision,
      now: now(),
      resultSourceId: result.sourceId,
      resultJson: { sourceId: result.sourceId, documentId: result.documentId, versionNumber: result.versionNumber, originKey: approvedOriginKey(proposal) },
    });
  }

  const updated = await loadProposal(proposal.id);
  if (!updated) throw new ConsoleApiError(404, { error: "knowledge_proposal_not_found" });
  return toProposalView(updated, origin);
}

export async function buildKnowledgeDigest(input: {
  caller: KnowledgeOperatorCaller;
  since: Date | null;
  origin: string;
}): Promise<KnowledgeDigest> {
  const caller = input.caller;
  const organizationId = caller.workspace.organization.id;
  const now = new Date();
  const projects = await listAccessibleProjectRecords(caller.workspace);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const projectIds = [...projectById.keys()];

  // Every gap of this installation that is still open; `since` does not hide one.
  const unanswered = await db
    .select()
    .from(schema.knowledgeProposals)
    .where(
      and(
        eq(schema.knowledgeProposals.organizationId, organizationId),
        eq(schema.knowledgeProposals.localInstallationId, caller.localInstallationId),
        eq(schema.knowledgeProposals.kind, "gap"),
        eq(schema.knowledgeProposals.status, "pending"),
        gt(schema.knowledgeProposals.expiresAt, now),
      ),
    )
    .orderBy(asc(schema.knowledgeProposals.createdAt))
    .limit(100);

  const counts = await db
    .select({ kind: schema.knowledgeProposals.kind, count: sql<number>`count(*)::int` })
    .from(schema.knowledgeProposals)
    .where(
      and(
        eq(schema.knowledgeProposals.organizationId, organizationId),
        eq(schema.knowledgeProposals.status, "pending"),
        gt(schema.knowledgeProposals.expiresAt, now),
        inArray(schema.knowledgeProposals.kind, ["note", "correction", "transcript"]),
        projectScopeCondition(projectIds),
      ),
    )
    .groupBy(schema.knowledgeProposals.kind);
  const countOf = (kind: string) => counts.find((row) => row.kind === kind)?.count ?? 0;

  const suspended = await listMarkedRoutes({ organizationId, state: "suspended" });
  return {
    generatedAt: now.toISOString(),
    unanswered: unanswered.map((proposal) => {
      const project = proposal.projectId ? projectById.get(proposal.projectId) : null;
      return {
        id: proposal.id,
        // A contact's words: neutralized like any knowledge text before an agent reads them.
        question: neutralizeKnowledgeText(proposal.body ?? ""),
        waitingCount: proposal.waitingCount,
        cardUrl: knowledgeProposalCardUrl(input.origin, proposal.id),
        createdAt: proposal.createdAt.toISOString(),
        project: project ? { id: project.id, slug: project.slug, name: project.name } : null,
      };
    }),
    pending: { notes: countOf("note"), corrections: countOf("correction"), transcripts: countOf("transcript") },
    suspendedMarks: suspended
      .filter((route) => projectById.has(route.projectId))
      .map((route) => ({
        routeId: route.routeId,
        url: `https://${route.host}${route.path}`,
        reason: route.mark.suspendedReason ?? "new_version",
        cardUrl: knowledgeRouteCardUrl(input.origin, route.routeId),
      })),
  };
}

// ---------------------------------------------------------------------------
// Approved proposals become sources (CONTRACT §6.5)
// ---------------------------------------------------------------------------

type ProposalRow = typeof schema.knowledgeProposals.$inferSelect;

async function ingestApprovedProposal(
  proposal: ProposalRow,
  context: { actorUserId: string; requestId: string; now: Date },
  deps: DecideKnowledgeProposalDeps,
): Promise<ProducerIngestResult> {
  const ingest = deps.ingest ?? ingestForProducer;
  // A pending proposal always has its body; only a closed or expired one is purged.
  const body = proposal.body ?? "";
  if (!body.trim()) throw new ConsoleApiError(409, { error: "knowledge_proposal_empty" });
  const evidence = proposal.evidenceJson.flatMap((item) => (typeof item.ref === "string" ? [item.ref] : []));
  const sourceRef = { proposalId: proposal.id, kind: proposal.kind };

  if (proposal.kind === "transcript") {
    if (!proposal.projectId) throw new ConsoleApiError(409, { error: "knowledge_proposal_no_project" });
    const parsed = parseTranscriptSegments(body);
    if (!parsed) throw new ConsoleApiError(409, { error: "knowledge_proposal_empty" });
    const [project] = await db
      .select({ metadataJson: schema.projects.metadataJson })
      .from(schema.projects)
      .where(eq(schema.projects.id, proposal.projectId))
      .limit(1);
    const months = (deps.retentionMonths ?? meetingRetentionMonths)(project?.metadataJson ?? {});
    const retainUntil = new Date(context.now);
    retainUntil.setUTCMonth(retainUntil.getUTCMonth() + months);
    const chunks = (deps.buildTranscriptChunks ?? buildMeetingTranscriptChunks)({ segments: parsed.segments });
    const title = parsed.title ?? proposal.title ?? "Meeting transcript";
    return ingest({
      organizationId: proposal.organizationId,
      projectId: proposal.projectId,
      originKey: `transcript:${proposal.id}`,
      sourceType: "meeting",
      trustTier: "said",
      title,
      sourceRef: { ...sourceRef, uploadedBy: proposal.proposedByJson, localMeetingKey: localMeetingKey(proposal.title) },
      retainUntil,
      document: {
        title,
        mimeType: "application/json",
        parserVersion: "knowledge-meeting-windows-v1",
        contentHash: sha256Hex(chunks.map((chunk) => chunk.text).join("\n")),
        sizeBytes: Buffer.byteLength(body, "utf8"),
        language: parsed.language,
      },
      chunks,
      actor: { type: "user", id: context.actorUserId },
      triggerType: "proposal_approved",
      requestId: context.requestId,
    });
  }

  const title = proposal.title?.trim() || firstLine(body) || (proposal.kind === "correction" ? "Correction" : "Note");
  const metadata: JsonRecord = { evidence, ...(proposal.kind === "correction" ? { corrects: proposal.supersedesRef } : {}) };
  const parts = splitKnowledgeText(body, NOTE_CHUNK_MAX_CHARS);
  return ingest({
    organizationId: proposal.organizationId,
    projectId: proposal.projectId,
    originKey: `note:${proposal.id}`,
    sourceType: "manual_note",
    trustTier: "approved",
    title,
    sourceRef,
    document: {
      title,
      mimeType: "text/plain",
      parserVersion: "knowledge-note-v1",
      contentHash: sha256Hex(body),
      sizeBytes: Buffer.byteLength(body, "utf8"),
    },
    chunks: parts.map((part, ordinal) => ({
      stableKey: `o${ordinal}`,
      text: part.text,
      heading: title,
      charStart: part.start,
      charEnd: part.end,
      location: { kind: "note", proposalId: proposal.id },
      metadata,
    })),
    actor: { type: "user", id: context.actorUserId },
    triggerType: "proposal_approved",
    requestId: context.requestId,
  });
}

/** Splits text into parts of at most `max` chars at paragraph, then sentence, then hard boundaries. */
export function splitKnowledgeText(text: string, max: number): Array<{ text: string; start: number; end: number }> {
  const normalized = text.replace(/\r\n?/g, "\n");
  const pieces: Array<{ text: string; start: number }> = [];
  const paragraph = /[^\n]+(?:\n(?!\n)[^\n]*)*/g;
  for (const match of normalized.matchAll(paragraph)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (!value.trim()) continue;
    if (value.length <= max) {
      pieces.push({ text: value, start });
      continue;
    }
    let offset = 0;
    for (const sentence of value.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [value]) {
      for (let cut = 0; cut < sentence.length; cut += max) {
        pieces.push({ text: sentence.slice(cut, cut + max), start: start + offset + cut });
      }
      offset += sentence.length;
    }
  }

  const parts: Array<{ text: string; start: number; end: number }> = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    const joined = last ? normalized.slice(last.start, piece.start + piece.text.length) : null;
    if (last && joined && joined.length <= max) {
      last.text = joined;
      last.end = piece.start + piece.text.length;
    } else {
      parts.push({ text: piece.text, start: piece.start, end: piece.start + piece.text.length });
    }
  }
  return parts
    .map((part) => {
      const leading = part.text.length - part.text.trimStart().length;
      const trimmed = part.text.trim();
      return { text: trimmed, start: part.start + leading, end: part.start + leading + trimmed.length };
    })
    .filter((part) => part.text.length > 0);
}

/** The segments of a `transcription.json` text, as the meeting windowing expects them; null when unusable. */
export function parseTranscriptSegments(
  body: string,
): { segments: SystemMeetingSegment[]; title: string | null; language: string | null } | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.segments)) return null;
  const meeting = root.meeting && typeof root.meeting === "object" ? (root.meeting as Record<string, unknown>) : {};
  const segments: SystemMeetingSegment[] = root.segments.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const segment = value as Record<string, unknown>;
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) return [];
    const startSeconds = finiteNumber(segment.startSec);
    return [
      {
        speaker: typeof segment.speaker === "string" ? segment.speaker : null,
        speakerId: null,
        isHost: null,
        startSeconds,
        endSeconds: finiteNumber(segment.endSec),
        startedAt: typeof segment.startAt === "string" ? segment.startAt : null,
        text,
        part: 0,
        callSeconds: startSeconds,
      },
    ];
  });
  if (segments.length === 0) return null;
  return {
    segments,
    title: typeof meeting.title === "string" && meeting.title.trim() ? meeting.title.trim().slice(0, 200) : null,
    language: typeof meeting.language === "string" ? meeting.language : null,
  };
}

// ---------------------------------------------------------------------------
// One-card pages (/k/[id], /k/routes/[routeId]) and their POST routes
// ---------------------------------------------------------------------------

/** Builds the viewer's workspace in the item's organization; null when they are not a member. */
export type CardWorkspaceResolver = (organizationId: string) => Promise<ConsoleWorkspace | null>;

export type KnowledgeProposalCard =
  | { kind: "not_found" }
  | {
      kind: "proposal";
      canDecide: boolean;
      proposal: {
        id: string;
        kind: KnowledgeProposalKind;
        status: string;
        projectName: string | null;
        title: string | null;
        body: string;
        bodyLineCount: number;
        evidence: string[];
        supersedes: string | null;
        waitingCount: number;
        audienceLabel: string | null;
        answer: string | null;
        faqQuestion: string | null;
        faq: { url: string; anchor: string } | null;
        createdAt: string;
        expiresAt: string;
        decidedAt: string | null;
      };
    };

export type KnowledgeRouteCardAudience = { value: string; label: string; detail: string | null; checked: boolean };
export type KnowledgeRouteCard =
  | { kind: "not_found" }
  | {
      kind: "route";
      canDecide: boolean;
      route: {
        id: string;
        url: string;
        state: "unmarked" | "active" | "suspended";
        managedBy: "web" | "faq" | null;
        suspendedReason: string | null;
        approvedVersion: number | null;
        approvedAt: string | null;
        currentVersion: number | null;
        /** The version the viewer is shown; the card posts it back so a mark pins exactly what was reviewed. */
        currentDocumentId: string | null;
        sections: Array<{ stableKey: string; heading: string | null; text: string }>;
        sectionCount: number;
        diff: Array<{ stableKey: string; heading: string | null; change: "added" | "removed" | "changed" }> | null;
        audiences: KnowledgeRouteCardAudience[];
      };
    };

/** GET /k/[id]: the proposal when the viewer can read its project (or, org-level, is org owner or admin); otherwise not found. */
export async function loadKnowledgeProposalCard(input: { id: string; workspaceFor: CardWorkspaceResolver }): Promise<KnowledgeProposalCard> {
  const notFound = { kind: "not_found" } as const;
  if (!UUID.test(input.id)) return notFound;
  const proposal = await loadProposal(input.id);
  if (!proposal) return notFound;
  const workspace = await input.workspaceFor(proposal.organizationId).catch(() => null);
  if (!workspace || workspace.organization.id !== proposal.organizationId) return notFound;

  let projectName: string | null = null;
  if (proposal.projectId) {
    const project = await findAccessibleProjectRecord(workspace, proposal.projectId, "read");
    if (!project) return notFound;
    projectName = project.name;
  } else if (!isOrgAdmin(workspace)) {
    return notFound;
  }

  // A purged body (decided transcript, expired, or closed for 30 days) shows as empty.
  const body = proposal.body ?? "";
  const transcript = proposal.kind === "transcript" && body ? parseTranscriptSegments(body) : null;
  const lines = transcript
    ? transcript.segments.map((segment) => `${segment.speaker?.trim() || "Unknown speaker"}: ${segment.text}`)
    : body.split("\n");
  const audience = proposal.requestedAudienceJson;
  const status = effectiveStatus(proposal);
  return {
    kind: "proposal",
    canDecide: status === "pending" && (await canDecideItem(workspace, proposal.projectId)),
    proposal: {
      id: proposal.id,
      kind: proposal.kind,
      status,
      projectName,
      title: proposal.title,
      body: proposal.kind === "transcript" ? lines.slice(0, CARD_TRANSCRIPT_LINES).join("\n") : body,
      bodyLineCount: lines.length,
      evidence: proposal.evidenceJson.flatMap((item) => (typeof item.ref === "string" ? [item.ref] : [])),
      supersedes: proposal.supersedesRef,
      waitingCount: proposal.waitingCount,
      audienceLabel:
        audience.kind === "contacts"
          ? String(typeof audience.label === "string" && audience.label ? audience.label : audience.instanceId ?? "")
          : null,
      answer: proposal.answerText,
      faqQuestion: proposal.faqQuestion,
      faq: faqFromResult(proposal),
      createdAt: proposal.createdAt.toISOString(),
      expiresAt: proposal.expiresAt.toISOString(),
      decidedAt: proposal.decidedAt?.toISOString() ?? null,
    },
  };
}

/** GET /k/routes/[routeId]: the route's mark, its current sections and, when suspended, the section diff. */
export async function loadKnowledgeRouteCard(input: { routeId: string; workspaceFor: CardWorkspaceResolver }): Promise<KnowledgeRouteCard> {
  const notFound = { kind: "not_found" } as const;
  const route = await loadRouteRecord(input.routeId);
  if (!route) return notFound;
  const workspace = await input.workspaceFor(route.organizationId).catch(() => null);
  if (!workspace || workspace.organization.id !== route.organizationId) return notFound;
  if (!(await findAccessibleProjectRecord(workspace, route.projectId, "read"))) return notFound;

  const mark = readRouteMark(route.routeConfigJson);
  const current = await currentRouteDocument(route);
  const currentChunks = current ? await documentSections(current.id) : [];
  const approvedChunks = mark?.state === "suspended" ? await documentSections(mark.approvedDocumentId) : null;

  return {
    kind: "route",
    canDecide: Boolean(await findAccessibleProjectRecord(workspace, route.projectId, "admin")),
    route: {
      id: route.id,
      url: `https://${route.host}${route.path}`,
      state: mark ? mark.state : "unmarked",
      managedBy: mark?.managedBy ?? null,
      suspendedReason: mark?.suspendedReason ?? null,
      approvedVersion: mark?.approvedVersion ?? null,
      approvedAt: mark?.approvedAt ?? null,
      currentVersion: current?.versionNumber ?? null,
      currentDocumentId: current?.id ?? null,
      sections: currentChunks.slice(0, CARD_SECTION_LIMIT).map((chunk) => ({
        stableKey: chunk.stableKey,
        heading: chunk.heading,
        text: chunk.text.length > CARD_SECTION_TEXT_CHARS ? `${chunk.text.slice(0, CARD_SECTION_TEXT_CHARS)}…` : chunk.text,
      })),
      sectionCount: currentChunks.length,
      diff: approvedChunks ? diffSections(approvedChunks, currentChunks) : null,
      audiences: await routeAudienceOptions(route.organizationId, mark),
    },
  };
}

/** Section diff by `stable_key`: added, removed or changed (text hash). */
export function diffSections(
  approved: ReadonlyArray<{ stableKey: string; heading: string | null; textHash: string }>,
  current: ReadonlyArray<{ stableKey: string; heading: string | null; textHash: string }>,
): Array<{ stableKey: string; heading: string | null; change: "added" | "removed" | "changed" }> {
  const group = (rows: typeof approved) => {
    const map = new Map<string, { heading: string | null; hashes: string[] }>();
    for (const row of rows) {
      const entry = map.get(row.stableKey) ?? { heading: row.heading, hashes: [] };
      entry.hashes.push(row.textHash);
      map.set(row.stableKey, entry);
    }
    return map;
  };
  const before = group(approved);
  const after = group(current);
  const diff: Array<{ stableKey: string; heading: string | null; change: "added" | "removed" | "changed" }> = [];
  for (const [stableKey, entry] of after) {
    const old = before.get(stableKey);
    if (!old) diff.push({ stableKey, heading: entry.heading, change: "added" });
    else if (old.hashes.join(",") !== entry.hashes.join(",")) diff.push({ stableKey, heading: entry.heading, change: "changed" });
  }
  for (const [stableKey, entry] of before) {
    if (!after.has(stableKey)) diff.push({ stableKey, heading: entry.heading, change: "removed" });
  }
  return diff;
}

export type KnowledgeCardViewer = { userId: string; impersonated: boolean };

export type KnowledgeCardPostDeps = {
  getAuth?: () => Promise<ConsoleAuthState | null>;
  viewerFromAuth?: (auth: ConsoleAuthState) => Promise<KnowledgeCardViewer>;
  workspaceFor?: (auth: ConsoleAuthState, organizationId: string) => Promise<ConsoleWorkspace | null>;
  isTrustedPost?: (request: NextRequest) => boolean;
  decide?: typeof decideKnowledgeProposal;
  writeMark?: typeof writeRouteMark;
};

const PROPOSAL_DECISIONS = new Set<KnowledgeProposalDecision>(["publish", "approve", "reject", "dismiss"]);
const ROUTE_ACTIONS = new Set(["mark", "reapprove", "unmark"] as const);

/** POST /api/console/knowledge/cards/proposals: form `{id, decision, answer?, faqQuestion?}` → 303 `/k/<id>?done=<decision>`. */
export async function handleKnowledgeProposalCardPost(request: NextRequest, deps: KnowledgeCardPostDeps = {}): Promise<NextResponse> {
  const web = await cardWebDeps(deps);
  if (!web.isTrustedPost(request)) return forbidden();
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const form = await request.formData().catch(() => null);
  const id = formValue(form, "id");
  if (!id || !UUID.test(id)) return redirectTo(request, "/k/invalid");
  const back = `/k/${id}`;
  const decision = formValue(form, "decision") as KnowledgeProposalDecision | null;
  if (!decision || !PROPOSAL_DECISIONS.has(decision)) return redirectTo(request, `${back}?error=invalid_decision`);

  const session = await webSession(request, back, web);
  if (session instanceof NextResponse) return session;

  const proposal = await loadProposal(id);
  if (!proposal) return redirectTo(request, back);
  const workspace = await web.workspaceFor(session.auth, proposal.organizationId).catch(() => null);
  if (!workspace || workspace.user.id !== session.viewer.userId) return redirectTo(request, back);

  try {
    await (deps.decide ?? decideKnowledgeProposal)({
      workspace,
      id,
      decision,
      answer: formValue(form, "answer", false) ?? undefined,
      faqQuestion: formValue(form, "faqQuestion") ?? undefined,
      requestId,
      origin: raviLinkConsoleOrigin(request.url),
    });
  } catch (error) {
    if (error instanceof ConsoleApiError) return redirectTo(request, `${back}?error=${encodeURIComponent(error.payload.error)}`);
    throw error;
  }
  return redirectTo(request, `${back}?done=${decision}`);
}

/**
 * POST /api/console/knowledge/cards/routes: form `{routeId, action, audiences[], expectedDocumentId}` → 303
 * `/k/routes/<routeId>?done=<action>`. Mark and re-approve need the version the card showed: a newer one is
 * `?error=knowledge_mark_stale`, so the person reviews it first.
 */
export async function handleKnowledgeRouteCardPost(request: NextRequest, deps: KnowledgeCardPostDeps = {}): Promise<NextResponse> {
  const web = await cardWebDeps(deps);
  if (!web.isTrustedPost(request)) return forbidden();
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const form = await request.formData().catch(() => null);
  const routeId = formValue(form, "routeId");
  if (!routeId || !UUID.test(routeId)) return redirectTo(request, "/k/routes/invalid");
  const back = `/k/routes/${routeId}`;
  const action = formValue(form, "action") as "mark" | "reapprove" | "unmark" | null;
  if (!action || !ROUTE_ACTIONS.has(action)) return redirectTo(request, `${back}?error=invalid_action`);

  const session = await webSession(request, back, web);
  if (session instanceof NextResponse) return session;

  const route = await loadRouteRecord(routeId);
  if (!route) return redirectTo(request, back);
  const workspace = await web.workspaceFor(session.auth, route.organizationId).catch(() => null);
  if (!workspace || workspace.user.id !== session.viewer.userId) return redirectTo(request, back);
  if (!(await findAccessibleProjectRecord(workspace, route.projectId, "read"))) return redirectTo(request, back);
  if (!(await findAccessibleProjectRecord(workspace, route.projectId, "admin"))) {
    return redirectTo(request, `${back}?error=knowledge_mark_forbidden`);
  }

  const values = form?.getAll("audiences").flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])) ?? [];
  const audiences = action === "unmark" ? [] : await parseCardAudiences(values, route.organizationId);
  if (!audiences) {
    return new NextResponse("Unknown contacts audience.", {
      status: 400,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (action !== "unmark" && audiences.length === 0) return redirectTo(request, `${back}?error=no_audience`);
  // The Console's own /faq is re-marked on every publish; a web mark would hand it to someone else.
  if (action !== "unmark" && readRouteMark(route.routeConfigJson)?.managedBy === "faq") {
    return redirectTo(request, `${back}?error=faq_managed`);
  }
  // Mark and re-approve approve the version the card showed, never one captured since.
  const expectedDocumentId = formValue(form, "expectedDocumentId");
  if (action !== "unmark" && (!expectedDocumentId || !UUID.test(expectedDocumentId))) {
    return redirectTo(request, `${back}?error=knowledge_mark_stale`);
  }

  try {
    await (deps.writeMark ?? writeRouteMark)({
      routeId,
      action,
      audiences,
      actorUserId: workspace.user.id,
      managedBy: "web",
      ...(action !== "unmark" && expectedDocumentId ? { expectedDocumentId } : {}),
      requestId,
    });
  } catch (error) {
    if (error instanceof ConsoleApiError) return redirectTo(request, `${back}?error=${encodeURIComponent(error.payload.error)}`);
    throw error;
  }
  return redirectTo(request, `${back}?done=${action}`);
}

/**
 * Card audiences: `page_viewers`, or `contacts:<localInstallationId>:<instanceId>`
 * where the installation belongs to the organization, is not revoked, and
 * reported that instance for knowledge. Null when any value is unknown.
 */
export async function parseCardAudiences(values: readonly string[], organizationId: string): Promise<KnowledgeMarkAudience[] | null> {
  const contacts: Array<{ localInstallationId: string; instanceId: string }> = [];
  let pageViewers = false;
  for (const value of values) {
    if (value === "page_viewers") {
      pageViewers = true;
      continue;
    }
    const match = /^contacts:([0-9a-f-]{36}):(.+)$/i.exec(value);
    if (!match || !UUID.test(match[1]!) || !INSTANCE_ID.test(match[2]!)) return null;
    contacts.push({ localInstallationId: match[1]!.toLowerCase(), instanceId: match[2]! });
  }

  const reported: Map<string, ReportedInstance[]> =
    contacts.length > 0 ? await reportedInstances(organizationId, [...new Set(contacts.map((item) => item.localInstallationId))]) : new Map();
  const audiences: KnowledgeMarkAudience[] = pageViewers ? [{ kind: "page_viewers" }] : [];
  const seen = new Set<string>();
  for (const item of contacts) {
    const instance = reported.get(item.localInstallationId)?.find((candidate) => candidate.id === item.instanceId);
    if (!instance) return null;
    const key = `${item.localInstallationId}:${item.instanceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    audiences.push({ kind: "contacts", localInstallationId: item.localInstallationId, instanceId: item.instanceId, label: instance.label });
  }
  return audiences;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function toProposalView(proposal: ProposalRow, origin: string): KnowledgeProposalView {
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: effectiveStatus(proposal),
    projectId: proposal.projectId,
    title: proposal.title,
    // A gap's body is a contact's words, read back by agents: neutralized like any knowledge text.
    // Empty once purged.
    body: proposal.kind === "gap" ? neutralizeKnowledgeText(proposal.body ?? "") : (proposal.body ?? ""),
    answer: proposal.answerText,
    faq: faqFromResult(proposal),
    waitingCount: proposal.waitingCount,
    cardUrl: knowledgeProposalCardUrl(origin, proposal.id),
    createdAt: proposal.createdAt.toISOString(),
    expiresAt: proposal.expiresAt.toISOString(),
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
  };
}

async function loadProposal(id: string): Promise<ProposalRow | null> {
  const [proposal] = await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, id)).limit(1);
  return proposal ?? null;
}

async function findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
  const [proposal] = await db
    .select()
    .from(schema.knowledgeProposals)
    .where(and(eq(schema.knowledgeProposals.organizationId, organizationId), eq(schema.knowledgeProposals.idempotencyKey, idempotencyKey)))
    .limit(1);
  return proposal ?? null;
}

function replayed(proposal: ProposalRow, caller: KnowledgeOperatorCaller, origin: string) {
  // The key is unique per organization; another installation's proposal is not shown.
  if (proposal.localInstallationId !== caller.localInstallationId) {
    throw cliApiError(409, "CONFLICT", "This idempotency key was already used for another proposal.");
  }
  return { proposal: toProposalView(proposal, origin), deduped: false, created: false };
}

async function bumpPendingGap(organizationId: string, localInstallationId: string, dedupeKey: string) {
  const [bumped] = await db
    .update(schema.knowledgeProposals)
    .set({ waitingCount: sql`${schema.knowledgeProposals.waitingCount} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(schema.knowledgeProposals.organizationId, organizationId),
        eq(schema.knowledgeProposals.localInstallationId, localInstallationId),
        eq(schema.knowledgeProposals.dedupeKey, dedupeKey),
        eq(schema.knowledgeProposals.status, "pending"),
      ),
    )
    .returning();
  return bumped ?? null;
}

async function closeProposal(
  proposal: ProposalRow,
  input: {
    status: "approved" | "rejected";
    actorUserId: string;
    requestId: string;
    decision: KnowledgeProposalDecision;
    now: Date;
    resultSourceId?: string;
    resultJson: JsonRecord;
  },
) {
  const updated = await db
    .update(schema.knowledgeProposals)
    .set({
      status: input.status,
      decidedByUserId: input.actorUserId,
      decidedAt: input.now,
      resultSourceId: input.resultSourceId ?? null,
      resultJson: input.resultJson,
      updatedAt: input.now,
      // A transcript is a whole meeting: once decided, the proposal keeps only its hash (an approved one lives on as a source).
      ...(proposal.kind === "transcript" ? purgedProposalBody() : {}),
    })
    .where(and(eq(schema.knowledgeProposals.id, proposal.id), eq(schema.knowledgeProposals.status, "pending")))
    .returning({ id: schema.knowledgeProposals.id });
  if (updated.length === 0) throw new ConsoleApiError(409, { error: "knowledge_proposal_closed" });
  await db.insert(schema.auditEvents).values({
    organizationId: proposal.organizationId,
    projectId: proposal.projectId,
    actorType: "user",
    actorId: input.actorUserId,
    targetType: "knowledge_proposal",
    targetId: proposal.id,
    action: `knowledge_proposal.${input.status}`,
    requestId: input.requestId,
    metadataJson: {
      proposalId: proposal.id,
      kind: proposal.kind,
      decision: input.decision,
      sourceId: input.resultSourceId ?? null,
      documentId: typeof input.resultJson.documentId === "string" ? input.resultJson.documentId : null,
    },
  });
}

async function canDecideItem(workspace: ConsoleWorkspace, projectId: string | null) {
  if (!projectId) return isOrgAdmin(workspace);
  return Boolean(await findAccessibleProjectRecord(workspace, projectId, "admin"));
}

function isOrgAdmin(workspace: { membership: { role: string } }) {
  return workspace.membership.role === "owner" || workspace.membership.role === "admin";
}

function projectScopeCondition(projectIds: readonly string[]): SQL {
  return (
    or(
      projectIds.length > 0 ? inArray(schema.knowledgeProposals.projectId, [...projectIds]) : sql`false`,
      isNull(schema.knowledgeProposals.projectId),
    ) ?? sql`false`
  );
}

function effectiveStatus(proposal: Pick<ProposalRow, "status" | "expiresAt">) {
  return proposal.status === "pending" && proposal.expiresAt <= new Date() ? "expired" : proposal.status;
}

function faqFromResult(proposal: Pick<ProposalRow, "kind" | "status" | "resultJson">) {
  if (proposal.kind !== "gap" || proposal.status !== "approved") return null;
  const url = typeof proposal.resultJson.url === "string" ? proposal.resultJson.url : null;
  const anchor = typeof proposal.resultJson.anchor === "string" ? proposal.resultJson.anchor : null;
  return url && anchor ? { url, anchor } : null;
}

function approvedOriginKey(proposal: ProposalRow) {
  return proposal.kind === "transcript" ? `transcript:${proposal.id}` : `note:${proposal.id}`;
}

type RouteRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  path: string;
  host: string;
  routeConfigJson: JsonRecord;
};

async function loadRouteRecord(routeId: string): Promise<RouteRecord | null> {
  if (!UUID.test(routeId)) return null;
  const [route] = await db
    .select({
      id: schema.pageRoutes.id,
      organizationId: schema.pageRoutes.organizationId,
      projectId: schema.pageRoutes.projectId,
      siteId: schema.pageRoutes.siteId,
      path: schema.pageRoutes.path,
      host: schema.pageSites.defaultHostname,
      routeConfigJson: schema.pageRoutes.routeConfigJson,
    })
    .from(schema.pageRoutes)
    .innerJoin(schema.pageSites, eq(schema.pageSites.id, schema.pageRoutes.siteId))
    .where(eq(schema.pageRoutes.id, routeId))
    .limit(1);
  return route ?? null;
}

async function currentRouteDocument(route: RouteRecord) {
  const [document] = await db
    .select({ id: schema.knowledgeDocuments.id, versionNumber: schema.knowledgeDocuments.versionNumber })
    .from(schema.knowledgeDocuments)
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, schema.knowledgeDocuments.sourceId))
    .where(
      and(
        eq(schema.knowledgeSources.organizationId, route.organizationId),
        eq(schema.knowledgeSources.originKey, `page:${route.siteId}:${route.path}`),
        eq(schema.knowledgeSources.status, "active"),
        inArray(schema.knowledgeDocuments.status, ["chunked", "indexed"]),
      ),
    )
    .orderBy(sql`${schema.knowledgeDocuments.versionNumber} desc`)
    .limit(1);
  return document ?? null;
}

async function documentSections(documentId: string) {
  if (!UUID.test(documentId)) return [];
  const rows = await db
    .select({
      stableKey: schema.knowledgeChunks.stableKey,
      chunkKey: schema.knowledgeChunks.chunkKey,
      text: schema.knowledgeChunks.text,
      textHash: schema.knowledgeChunks.textHash,
      metadata: schema.knowledgeChunks.safeMetadataJson,
    })
    .from(schema.knowledgeChunks)
    .where(and(eq(schema.knowledgeChunks.documentId, documentId), eq(schema.knowledgeChunks.status, "active")))
    .orderBy(asc(schema.knowledgeChunks.chunkOrdinal));
  return rows.map((row) => ({
    stableKey: row.stableKey ?? row.chunkKey,
    heading: typeof row.metadata.heading === "string" ? row.metadata.heading : null,
    text: row.text,
    textHash: row.textHash,
  }));
}

type ReportedInstance = { id: string; label: string };

async function reportedInstances(organizationId: string, installationIds?: readonly string[]) {
  const conditions: SQL[] = [
    eq(schema.localInstallations.organizationId, organizationId),
    eq(schema.localInstallations.status, "active"),
    isNull(schema.localInstallations.revokedAt),
  ];
  if (installationIds) conditions.push(inArray(schema.localInstallations.id, [...installationIds]));
  const rows = await db
    .select({ id: schema.localInstallations.id, name: schema.localInstallations.name, metadata: schema.localInstallations.metadataJson })
    .from(schema.localInstallations)
    .where(and(...conditions))
    .orderBy(asc(schema.localInstallations.name));
  const byInstallation = new Map<string, ReportedInstance[]>();
  const names = new Map<string, string>();
  for (const row of rows) {
    names.set(row.id, row.name);
    const list = Array.isArray(row.metadata.knowledgeInstances) ? row.metadata.knowledgeInstances : [];
    byInstallation.set(
      row.id,
      list.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || !INSTANCE_ID.test(record.id)) return [];
        const label = typeof record.label === "string" && record.label.trim() ? record.label.trim().slice(0, 80) : record.id;
        return [{ id: record.id, label }];
      }),
    );
  }
  return Object.assign(byInstallation, { names });
}

async function routeAudienceOptions(organizationId: string, mark: KnowledgeRouteMark | null): Promise<KnowledgeRouteCardAudience[]> {
  const selected = new Set(
    (mark?.audiences ?? []).map((audience) =>
      audience.kind === "page_viewers" ? "page_viewers" : `contacts:${audience.localInstallationId}:${audience.instanceId}`,
    ),
  );
  const reported = await reportedInstances(organizationId);
  const options: KnowledgeRouteCardAudience[] = [];
  for (const [installationId, instances] of reported) {
    for (const instance of instances) {
      const value = `contacts:${installationId}:${instance.id}`;
      options.push({ value, label: `Contacts of ${instance.label}`, detail: reported.names.get(installationId) ?? null, checked: selected.has(value) });
    }
  }
  options.push({
    value: "page_viewers",
    label: "Page viewers (members and guests with access)",
    detail: null,
    checked: selected.has("page_viewers"),
  });
  return options;
}

async function cardWebDeps(deps: KnowledgeCardPostDeps) {
  // Loaded lazily so CLI handlers importing this module never pull the web session stack.
  const needsDefaults = !deps.getAuth || !deps.viewerFromAuth || !deps.workspaceFor || !deps.isTrustedPost;
  const web = needsDefaults ? await import("@/server/console/ravi-link-web") : null;
  const session = !deps.getAuth ? await import("@/lib/auth/session") : null;
  const workspaces = !deps.workspaceFor ? await import("@/server/console/workspace") : null;
  return {
    getAuth: deps.getAuth ?? (() => session!.getConsoleApiAuthState()),
    viewerFromAuth: deps.viewerFromAuth ?? ((auth: ConsoleAuthState) => web!.raviLinkApproverFromAuth(auth)),
    workspaceFor:
      deps.workspaceFor ??
      ((auth: ConsoleAuthState, organizationId: string) =>
        workspaces!.getConsoleWorkspace(auth, { organizationRef: organizationId }).catch(() => null)),
    isTrustedPost: deps.isTrustedPost ?? ((request: NextRequest) => web!.isTrustedConsolePost(request)),
  };
}

async function webSession(
  request: NextRequest,
  back: string,
  web: Awaited<ReturnType<typeof cardWebDeps>>,
): Promise<NextResponse | { auth: ConsoleAuthState; viewer: KnowledgeCardViewer }> {
  const auth = await web.getAuth();
  if (!auth) return redirectTo(request, `/login?returnTo=${encodeURIComponent(back)}`);
  let viewer: KnowledgeCardViewer;
  try {
    viewer = await web.viewerFromAuth(auth);
  } catch {
    return redirectTo(request, back);
  }
  if (viewer.impersonated) return redirectTo(request, `${back}?error=impersonated`);
  return { auth, viewer };
}

function redirectTo(request: NextRequest, path: string) {
  const response = NextResponse.redirect(new URL(path, request.url), { status: 303 });
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cache-control", "no-store");
  return response;
}

function forbidden() {
  return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
}

function formValue(form: FormData | null, key: string, trim = true) {
  const value = form?.get(key);
  if (typeof value !== "string") return null;
  const cleaned = trim ? value.trim() : value;
  return cleaned.trim() ? cleaned : null;
}

function localMeetingKey(title: string | null) {
  const key = title?.trim();
  return key && /^[A-Za-z0-9._-]{1,200}$/.test(key) ? key : null;
}

function firstLine(text: string) {
  const line = text.split("\n").find((candidate) => candidate.trim())?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
