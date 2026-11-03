import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { KnowledgeTriggerType } from "./jobs";
import {
  createKnowledgeRawSourceObjectStoreFromEnv,
  failedKnowledgeRawSourceRef,
  pendingKnowledgeRawSourceRef,
  putKnowledgeRawSourceObject,
  type KnowledgeRawSourceObjectStore,
} from "./raw-source-storage";
import { purgeProposalBody } from "./proposal-body";
import { knowledgeSearchVectorSql } from "./search-vector";
import { foldKnowledgeText, neutralizeKnowledgeText } from "./text";
import type { KnowledgeDbExecutor, KnowledgeTrustTier, KnowledgeTx } from "./types";
import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "./usage";

// The producer path: every capture (meetings, pages, approved proposals, /faq)
// writes a source keyed by `origin_key`, a new document version, its chunks and
// a v2 snapshot in one transaction under a per-origin advisory lock.

export const KNOWLEDGE_PRODUCER_MAX_BYTES = 2 * 1024 * 1024;

const SOURCE = "console.knowledge.producer";
const CURRENT_DOCUMENT_STATUSES = ["created", "parsed", "chunked", "indexed"] as const;
const READABLE_DOCUMENT_STATUSES = ["chunked", "indexed"] as const;

export type ProducerChunkInput = {
  /** Pages: heading path "h:Trocas>Prazo"; meetings: "t<sec>:<speakerKey>:p<part>". */
  stableKey: string;
  /** Already neutralized by the producer; at most 1200 chars. */
  text: string;
  heading?: string | null;
  /** Sanitized display names. */
  speakers?: readonly string[];
  charStart?: number | null;
  charEnd?: number | null;
  location: JsonRecord;
  metadata?: JsonRecord;
};

export type ProducerIngestInput = {
  organizationId: string;
  projectId: string | null;
  originKey: string;
  sourceType: (typeof schema.knowledgeSourceType.enumValues)[number];
  trustTier: KnowledgeTrustTier;
  title: string;
  /** Server-written; never client input. */
  sourceRef: JsonRecord;
  retainUntil?: Date | null;
  sensitivity?: "standard" | "confidential" | "restricted";
  document: {
    title: string;
    mimeType: string;
    parserVersion: string;
    contentHash: string;
    sizeBytes: number;
    language?: string | null;
    sourceLocation?: JsonRecord;
    rawText?: string | null;
  };
  chunks: readonly ProducerChunkInput[];
  actor: { type: "system" | "user" | "cli"; id: string | null };
  triggerType: KnowledgeTriggerType;
  requestId: string;
  /** Default true for "revoked", never for "deleted". */
  allowRevive?: boolean;
  /** Set inside a drainKnowledgeJobs handler: the producer then never writes job rows. */
  jobId?: string;
};

export type ProducerIngestResult =
  | {
      status: "ingested";
      sourceId: string;
      documentId: string;
      versionNumber: number;
      chunkCount: number;
      previousDocumentId: string | null;
    }
  | { status: "unchanged"; sourceId: string; documentId: string; versionNumber: number }
  | { status: "skipped"; sourceId: string; reason: "source_deleted" | "too_large" | "empty" };

type SkipReason = Extract<ProducerIngestResult, { status: "skipped" }>["reason"];

export async function ingestForProducer(
  input: ProducerIngestInput,
  database: typeof db = db,
): Promise<ProducerIngestResult> {
  const chunkBytes = input.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"), 0);
  const limitReason: SkipReason | null =
    input.chunks.length === 0 ? "empty" : chunkBytes > KNOWLEDGE_PRODUCER_MAX_BYTES ? "too_large" : null;
  const now = new Date();
  const documentId = randomUUID();

  const result = await database.transaction(async (tx) => {
    await lockKnowledgeOrigin(tx, input.organizationId, input.originKey);
    const source = await upsertKnowledgeSourceForOrigin(
      { ...input, allowRevive: limitReason ? false : input.allowRevive },
      tx,
    );

    const skipReason: SkipReason | null =
      source.status === "deleted" || source.status === "disabled" ? "source_deleted" : limitReason;
    if (skipReason || source.status !== "active") {
      const reason = skipReason ?? "source_deleted";
      if (!input.jobId) {
        await insertProducerJob(tx, input, { sourceId: source.id, documentId: null, now, failureCode: reason, resultJson: { status: reason } });
      }
      return { status: "skipped", sourceId: source.id, reason } as const;
    }

    const [current] = await tx
      .select({
        id: schema.knowledgeDocuments.id,
        versionNumber: schema.knowledgeDocuments.versionNumber,
        contentHash: schema.knowledgeDocuments.contentHash,
        status: schema.knowledgeDocuments.status,
      })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.sourceId, source.id),
          inArray(schema.knowledgeDocuments.status, [...CURRENT_DOCUMENT_STATUSES]),
        ),
      )
      .orderBy(desc(schema.knowledgeDocuments.versionNumber))
      .limit(1);

    if (
      current &&
      current.contentHash === input.document.contentHash &&
      (READABLE_DOCUMENT_STATUSES as readonly string[]).includes(current.status)
    ) {
      // Same content: keep the version, but let a tier change (a /faq capture
      // becoming approved) reach the chunks readers rank on.
      await tx
        .update(schema.knowledgeChunks)
        .set({ trustTier: input.trustTier, updatedAt: now })
        .where(and(eq(schema.knowledgeChunks.documentId, current.id), ne(schema.knowledgeChunks.trustTier, input.trustTier)));
      if (!input.jobId) {
        await insertProducerJob(tx, input, {
          sourceId: source.id,
          documentId: current.id,
          now,
          failureCode: null,
          resultJson: { status: "unchanged", documentId: current.id, versionNumber: current.versionNumber },
        });
      }
      return { status: "unchanged", sourceId: source.id, documentId: current.id, versionNumber: current.versionNumber } as const;
    }

    const versionNumber = await nextDocumentVersion(tx, source.id);
    const [document] = await tx
      .insert(schema.knowledgeDocuments)
      .values({
        id: documentId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceId: source.id,
        versionNumber,
        title: input.document.title,
        status: "chunked",
        contentHash: input.document.contentHash,
        mimeType: input.document.mimeType,
        language: input.document.language ?? null,
        parserVersion: input.document.parserVersion,
        sizeBytes: input.document.sizeBytes,
        sourceLocationJson: {
          schemaVersion: 1,
          source: SOURCE,
          rawRef: pendingKnowledgeRawSourceRef(),
          ...input.document.sourceLocation,
        },
        safeMetadataJson: { schemaVersion: 1, originKey: input.originKey, triggerType: input.triggerType },
        parsedAt: now,
      })
      .returning();
    if (!document) throw new Error("Failed to create knowledge document.");

    const snapshotId = await insertPolicySnapshotV2(tx, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceId: source.id,
      documentId: document.id,
      trustTier: input.trustTier,
      sensitivity: input.sensitivity ?? "standard",
      retainUntil: input.retainUntil ?? null,
      actor: input.actor,
      now,
    });

    const rows = input.chunks.map((chunk, ordinal) => {
      const text = neutralizeKnowledgeText(chunk.text);
      const textHash = sha256Hex(text);
      const speakers = chunk.speakers ?? [];
      const vectors = knowledgeSearchVectorSql({ title: input.title, heading: chunk.heading ?? null, text, speakers });
      return {
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceId: source.id,
        documentId: document.id,
        permissionSnapshotId: snapshotId,
        chunkOrdinal: ordinal,
        chunkKey: knowledgeChunkKey(chunk.stableKey, ordinal, textHash),
        stableKey: chunk.stableKey,
        trustTier: input.trustTier,
        searchVector: vectors.searchVector,
        searchVectorStem: vectors.searchVectorStem,
        text,
        textHash,
        tokenCount: Math.max(1, Math.ceil(text.length / 4)),
        charStart: chunk.charStart ?? null,
        charEnd: chunk.charEnd ?? null,
        status: "active" as const,
        locationJson: chunk.location,
        safeMetadataJson: {
          parserVersion: input.document.parserVersion,
          ...(chunk.heading ? { heading: chunk.heading } : {}),
          ...chunk.metadata,
          speakersFolded: speakersFolded(chunk),
        },
      };
    });
    for (let start = 0; start < rows.length; start += 200) {
      await tx.insert(schema.knowledgeChunks).values(rows.slice(start, start + 200));
    }

    const archived = await archiveOtherDocuments(tx, source.id, document.id, now);
    const previousDocumentId = current?.id ?? archived[0] ?? null;

    let jobId = input.jobId ?? null;
    if (!input.jobId) {
      jobId = await insertProducerJob(tx, input, {
        sourceId: source.id,
        documentId: document.id,
        now,
        failureCode: null,
        resultJson: {
          status: "ingested",
          documentId: document.id,
          versionNumber,
          chunkCount: rows.length,
          contentHash: input.document.contentHash,
        },
      });
    }

    await tx
      .update(schema.knowledgeSources)
      .set({ rawRefJson: pendingKnowledgeRawSourceRef(), updatedAt: now })
      .where(eq(schema.knowledgeSources.id, source.id));

    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      targetType: "knowledge_source",
      targetId: source.id,
      action: "knowledge_source.ingested",
      requestId: input.requestId,
      metadataJson: {
        source: SOURCE,
        documentId: document.id,
        previousDocumentId,
        ingestionJobId: jobId,
        versionNumber,
        chunkCount: rows.length,
        contentHash: input.document.contentHash,
        parserVersion: input.document.parserVersion,
        triggerType: input.triggerType,
      },
    });

    await recordKnowledgeUsage(
      [
        buildKnowledgeUsageEvent({
          organizationId: input.organizationId,
          projectId: input.projectId,
          metricKey: "knowledge.chunks_stored",
          eventType: "knowledge.document_ingested",
          id: document.id,
          quantity: rows.length,
          requestId: input.requestId,
          dimensions: { kind: input.originKey.split(":")[0] },
        }),
      ],
      tx,
    );

    return {
      status: "ingested",
      sourceId: source.id,
      documentId: document.id,
      versionNumber,
      chunkCount: rows.length,
      previousDocumentId,
    } as const;
  });

  if (result.status === "ingested" && input.document.rawText) {
    await storeRawAfterCommit({
      database,
      documentId: result.documentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rawText: input.document.rawText,
      mimeType: input.document.mimeType,
      sourceId: result.sourceId,
      store: createKnowledgeRawSourceObjectStoreFromEnv(),
    });
  }
  return result;
}

/**
 * Finds or creates the source for `(organizationId, originKey)` and refreshes
 * its server-written fields. A `deleted` source is returned untouched and is
 * never revived; a `revoked` one is revived unless `allowRevive` is false.
 */
export async function upsertKnowledgeSourceForOrigin(
  input: Omit<ProducerIngestInput, "document" | "chunks" | "triggerType">,
  tx: KnowledgeTx,
): Promise<{ id: string; status: string; created: boolean }> {
  const now = new Date();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [existing] = await tx
      .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status })
      .from(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.organizationId, input.organizationId),
          eq(schema.knowledgeSources.originKey, input.originKey),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.status === "deleted") return { id: existing.id, status: existing.status, created: false };
      const revive = existing.status === "revoked" && input.allowRevive !== false;
      const [updated] = await tx
        .update(schema.knowledgeSources)
        .set({
          projectId: input.projectId,
          sourceType: input.sourceType,
          title: input.title,
          trustTier: input.trustTier,
          sensitivity: input.sensitivity ?? "standard",
          sourceRefJson: input.sourceRef,
          accessPolicyJson: producerAccessPolicy(input),
          ...(input.retainUntil !== undefined ? { retainUntil: input.retainUntil } : {}),
          ...(revive ? { status: "active" as const, revokedAt: null } : {}),
          updatedAt: now,
        })
        .where(eq(schema.knowledgeSources.id, existing.id))
        .returning({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status });
      if (!updated) throw new Error("Failed to update knowledge source.");
      return { id: updated.id, status: updated.status, created: false };
    }

    const [created] = await tx
      .insert(schema.knowledgeSources)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceType: input.sourceType,
        title: input.title,
        status: "active",
        sensitivity: input.sensitivity ?? "standard",
        sourceRefJson: input.sourceRef,
        rawRefJson: pendingKnowledgeRawSourceRef(),
        accessPolicyJson: producerAccessPolicy(input),
        createdByActorType: input.actor.type,
        createdByActorId: input.actor.id,
        originKey: input.originKey,
        trustTier: input.trustTier,
        retainUntil: input.retainUntil ?? null,
      })
      .onConflictDoNothing({
        target: [schema.knowledgeSources.organizationId, schema.knowledgeSources.originKey],
        where: sql`${schema.knowledgeSources.originKey} IS NOT NULL`,
      })
      .returning({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status });
    if (created) {
      await tx.insert(schema.auditEvents).values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        targetType: "knowledge_source",
        targetId: created.id,
        action: "knowledge_source.created",
        requestId: input.requestId,
        metadataJson: { source: SOURCE, sourceType: input.sourceType, trustTier: input.trustTier, originKind: originKind(input.originKey) },
      });
      return { id: created.id, status: created.status, created: true };
    }
    // Lost a race with another writer of the same origin: read it again.
  }
  throw new Error("Failed to upsert knowledge source.");
}

/** status=revoked, revoked_at=now; chunks stay (readers join on source status). */
export async function revokeKnowledgeSourceByOrigin(
  input: { organizationId: string; originKey: string; reason: string; requestId: string },
  database: typeof db = db,
): Promise<boolean> {
  const now = new Date();
  return database.transaction(async (tx) => {
    const [source] = await tx
      .update(schema.knowledgeSources)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.knowledgeSources.organizationId, input.organizationId),
          eq(schema.knowledgeSources.originKey, input.originKey),
          eq(schema.knowledgeSources.status, "active"),
        ),
      )
      .returning({ id: schema.knowledgeSources.id, projectId: schema.knowledgeSources.projectId });
    if (!source) return false;
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      projectId: source.projectId,
      actorType: "system",
      targetType: "knowledge_source",
      targetId: source.id,
      action: "knowledge_source.revoked",
      requestId: input.requestId,
      metadataJson: { source: SOURCE, reason: safeCode(input.reason), originKind: originKind(input.originKey) },
    });
    return true;
  });
}

/**
 * Hard-deletes a source's documents, snapshots and chunks (citations keep
 * their rows with null ids). A person's deletion and retention then mark the
 * source `deleted`, so no capture revives it; a site move leaves it `revoked`,
 * so the next capture of the page revives it for the site's new owner.
 */
export async function deleteKnowledgeSourceContent(
  input: {
    organizationId: string;
    sourceId: string;
    actor: { type: "system" | "user"; id: string | null };
    reason: "user_deleted" | "retention" | "site_moved";
    requestId: string;
  },
  database: typeof db = db,
): Promise<{ documents: number; chunks: number }> {
  const now = new Date();
  return database.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: schema.knowledgeSources.id, originKey: schema.knowledgeSources.originKey, projectId: schema.knowledgeSources.projectId })
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.organizationId, input.organizationId), eq(schema.knowledgeSources.id, input.sourceId)))
      .limit(1);
    if (!source) return { documents: 0, chunks: 0 };
    if (source.originKey) await lockKnowledgeOrigin(tx, input.organizationId, source.originKey);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge_source:${source.id}`}))`);

    const [chunkCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.sourceId, source.id));
    const deletedDocuments = await tx
      .delete(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.sourceId, source.id))
      .returning({ id: schema.knowledgeDocuments.id });
    // Chunks and snapshots cascade from their document; sweep any orphan left.
    await tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.sourceId, source.id));
    await tx.delete(schema.knowledgePermissionSnapshots).where(eq(schema.knowledgePermissionSnapshots.sourceId, source.id));

    await tx
      .update(schema.knowledgeSources)
      .set({
        status: input.reason === "site_moved" ? "revoked" : "deleted",
        revokedAt: now,
        rawRefJson: pendingKnowledgeRawSourceRef(),
        updatedAt: now,
      })
      .where(eq(schema.knowledgeSources.id, source.id));

    // An approved transcript's text also sits in its proposal's body: that goes too.
    if (source.originKey?.startsWith("transcript:")) {
      await purgeProposalBody(tx, { organizationId: input.organizationId, proposalId: source.originKey.slice("transcript:".length) });
    }

    const counts = { documents: deletedDocuments.length, chunks: chunkCount?.count ?? 0 };
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      projectId: source.projectId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      targetType: "knowledge_source",
      targetId: source.id,
      action: "knowledge_source.content_deleted",
      requestId: input.requestId,
      metadataJson: { source: SOURCE, reason: input.reason, ...counts },
    });
    return counts;
  });
}

/** `${stableKey}:${ordinal}:${textHash[0..16]}`: unique per document even when a section repeats. */
export function knowledgeChunkKey(stableKey: string, ordinal: number, textHash: string): string {
  return `${stableKey}:${ordinal}:${textHash.slice(0, 16)}`;
}

/** The v2 snapshot: audit only, no reader authorizes from it. */
export function knowledgePolicySnapshotV2(input: {
  trustTier: KnowledgeTrustTier;
  sensitivity: string;
  retainUntil: Date | null;
  capturedAt: Date;
}): JsonRecord {
  return {
    policyVersion: 2,
    trustTier: input.trustTier,
    sensitivity: input.sensitivity,
    retention: { retainUntil: input.retainUntil ? input.retainUntil.toISOString() : null },
    capturedAt: input.capturedAt.toISOString(),
  };
}

export async function insertPolicySnapshotV2(
  tx: KnowledgeDbExecutor,
  input: {
    organizationId: string;
    projectId: string | null;
    sourceId: string;
    documentId: string;
    trustTier: KnowledgeTrustTier;
    sensitivity: string;
    retainUntil: Date | null;
    actor: { type: "system" | "user" | "cli" | "anonymous"; id: string | null };
    now: Date;
  },
): Promise<string> {
  const policyJson = knowledgePolicySnapshotV2({
    trustTier: input.trustTier,
    sensitivity: input.sensitivity,
    retainUntil: input.retainUntil,
    capturedAt: input.now,
  });
  const [snapshot] = await tx
    .insert(schema.knowledgePermissionSnapshots)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceId: input.sourceId,
      documentId: input.documentId,
      snapshotHash: sha256Hex(stableStringify(policyJson)),
      policyJson,
      capturedByActorType: input.actor.type,
      capturedByActorId: input.actor.id,
      capturedAt: input.now,
    })
    .returning({ id: schema.knowledgePermissionSnapshots.id });
  if (!snapshot) throw new Error("Failed to create knowledge permission snapshot.");
  return snapshot.id;
}

/** Archives every other current document of the source; their chunks keep their status. */
export async function archiveOtherDocuments(
  tx: KnowledgeDbExecutor,
  sourceId: string,
  keepDocumentId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .update(schema.knowledgeDocuments)
    .set({ status: "archived", updatedAt: now })
    .where(
      and(
        eq(schema.knowledgeDocuments.sourceId, sourceId),
        ne(schema.knowledgeDocuments.id, keepDocumentId),
        inArray(schema.knowledgeDocuments.status, [...CURRENT_DOCUMENT_STATUSES]),
      ),
    )
    .returning({ id: schema.knowledgeDocuments.id, versionNumber: schema.knowledgeDocuments.versionNumber });
  return rows.sort((left, right) => right.versionNumber - left.versionNumber).map((row) => row.id);
}

export async function nextDocumentVersion(tx: Pick<typeof db, "select">, sourceId: string) {
  const [latest] = await tx
    .select({ versionNumber: schema.knowledgeDocuments.versionNumber })
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.sourceId, sourceId))
    .orderBy(desc(schema.knowledgeDocuments.versionNumber))
    .limit(1);
  return (latest?.versionNumber ?? 0) + 1;
}

/** Writes the raw copy after the chunks committed; a missing or failing vault never fails the capture. */
export async function storeRawAfterCommit(input: {
  database: KnowledgeDbExecutor;
  documentId: string;
  organizationId: string;
  projectId: string | null;
  rawText: string;
  mimeType: string;
  sourceId: string;
  filename?: string | null;
  store: KnowledgeRawSourceObjectStore | null;
}): Promise<void> {
  if (!input.store) return;
  let rawRef: JsonRecord;
  try {
    rawRef = await putKnowledgeRawSourceObject({
      body: input.rawText,
      contentType: input.mimeType,
      documentId: input.documentId,
      filename: input.filename ?? null,
      organizationId: input.organizationId,
      projectId: input.projectId ?? "none",
      sourceId: input.sourceId,
      store: input.store,
    });
  } catch {
    rawRef = failedKnowledgeRawSourceRef();
  }
  try {
    await input.database
      .update(schema.knowledgeDocuments)
      .set({
        sourceLocationJson: sql`jsonb_set(${schema.knowledgeDocuments.sourceLocationJson}, '{rawRef}', ${JSON.stringify(rawRef)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(schema.knowledgeDocuments.id, input.documentId));
    await input.database
      .update(schema.knowledgeSources)
      .set({ rawRefJson: rawRef, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, input.sourceId));
  } catch {
    // The capture already committed; the raw ref stays pending.
  }
}

export async function lockKnowledgeOrigin(tx: KnowledgeDbExecutor, organizationId: string, originKey: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge_origin:${organizationId}:${originKey}`}))`);
}

async function insertProducerJob(
  tx: KnowledgeDbExecutor,
  input: ProducerIngestInput,
  outcome: { sourceId: string; documentId: string | null; now: Date; failureCode: string | null; resultJson: JsonRecord },
): Promise<string> {
  const [job] = await tx
    .insert(schema.knowledgeIngestionJobs)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceId: outcome.sourceId,
      documentId: outcome.documentId,
      status: outcome.failureCode ? "failed" : "completed",
      triggerType: input.triggerType,
      requestId: input.requestId,
      attempts: 1,
      maxAttempts: 1,
      inputJson: { schemaVersion: 1, source: SOURCE, originKind: originKind(input.originKey), contentHash: input.document.contentHash },
      resultJson: { schemaVersion: 1, ...outcome.resultJson },
      failureCode: outcome.failureCode,
      requestedByActorType: input.actor.type,
      requestedByActorId: input.actor.id,
      startedAt: outcome.now,
      finishedAt: outcome.now,
    })
    .returning({ id: schema.knowledgeIngestionJobs.id });
  if (!job) throw new Error("Failed to record the knowledge ingestion job.");
  return job.id;
}

function producerAccessPolicy(input: { organizationId: string; projectId: string | null }): JsonRecord {
  return {
    schemaVersion: 2,
    scope: input.projectId ? "project" : "organization",
    organizationId: input.organizationId,
    projectId: input.projectId,
    visibility: input.projectId ? "project_private" : "organization_private",
  };
}

function speakersFolded(chunk: ProducerChunkInput): string[] {
  const provided = chunk.metadata?.speakersFolded;
  if (Array.isArray(provided)) return provided.filter((item): item is string => typeof item === "string");
  return [...new Set((chunk.speakers ?? []).map((speaker) => foldKnowledgeText(speaker)).filter(Boolean))];
}

function originKind(originKey: string) {
  return originKey.split(":")[0] ?? "unknown";
}

function safeCode(value: string) {
  return /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : "other";
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
