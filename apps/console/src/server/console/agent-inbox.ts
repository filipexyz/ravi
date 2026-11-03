import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export type AgentInboxWorkspace = {
  authorization?: import("./authorization/identity").AuthorizationActor["delegation"];
  user: { id: string };
  organization: { id: string; name: string; slug: string };
  membership: { role: string };
  localInstallation: {
    id: string;
    name: string;
    capabilitiesJson: string[];
  };
};

export type InboxPollAckInput = {
  errorCode?: string;
  itemId: string;
  leaseId?: string;
  localEventId?: string;
  status?: "delivered" | "read" | "resolved" | "failed" | "skipped";
};

export type RecordMailMessageReceivedInboxItemInput = {
  attachmentCount?: number;
  hasEncryptedBody: boolean;
  hasEncryptedSubject: boolean;
  mailboxAddress: string;
  mailboxId: string;
  messageId: string;
  organizationId: string;
  projectId: string | null;
  providerAdapter: string;
  receivedAt: Date | null;
  requestId: string;
  routeId: string | null;
  sizeBytes: number | null;
  threadId?: string | null;
};

export type AgentInboxPulse = {
  changed: boolean;
  version: 2;
  subscribed: boolean;
  subscription: {
    deliveryMode: string;
    id: string;
    lastDeliveredSequence: number;
    lastPollAt: string | null;
    localInstallationId: string;
    name: string | null;
    status: string;
  } | null;
  watermark: {
    cacheKey: string;
    generation: number;
    latestItemAt: string | null;
    latestSequence: number;
    organizationId: string;
    updatedAt: string;
  };
};

export type AgentInboxPollResult = AgentInboxPulse & {
  hasMore: boolean;
  items: AgentInboxDeliveryItem[];
  leaseId: string;
  leaseExpiresAt: string | null;
  leaseSeconds: number;
  pollId: string;
  serverTime: string;
};

export type AgentInboxLinks = JsonRecord | JsonRecord[];

export type AgentInboxDeliveryItem = {
  id: string;
  itemId: string;
  sequence: number;
  dedupeKey: string;
  eventType: string;
  category: string;
  severity: string;
  sensitivity: string;
  title: string;
  summary: string | null;
  sourceType: string;
  sourceId: string | null;
  targetType: string;
  targetId: string | null;
  source: { type: string; id: string | null };
  actor: { type: string | null; id: string | null };
  target: { type: string; id: string | null };
  organization: { id: string };
  project: { id: string } | null;
  payload: JsonRecord;
  links: AgentInboxLinks;
  occurredAt: string;
  createdAt: string;
  receiptId: string;
  leaseId: string;
  leaseExpiresAt: string;
  lease: {
    expiresAt: string;
    id: string;
    seconds: number;
  };
};

const DEFAULT_LEASE_MS = 60_000;
export const AGENT_INBOX_EVENT_SUBJECT = "ravi.console.inbox.item";
export const AGENT_INBOX_TARGET_LOCAL_INSTALLATION = "local_installation";
const DEFAULT_OUTBOX_LOCK_MS = 60_000;
const DEFAULT_OUTBOX_LIMIT = 25;
const OUTBOX_BASE_BACKOFF_MS = 5_000;
const OUTBOX_MAX_BACKOFF_MS = 5 * 60_000;

export type AgentInboxOutboxPayload = JsonRecord & {
  version: 1;
  eventId: string;
  sequence: number;
  dedupeKey: string;
  eventType: string;
  category: string;
  severity: string;
  sensitivity: string;
  title: string;
  summary: string | null;
  organization: { id: string };
  project: { id: string } | null;
  source: JsonRecord & { type: string; id: string | null };
  actor: JsonRecord & { type: string | null; id: string | null };
  target: JsonRecord & { type: string; id: string | null };
  payload: JsonRecord;
  links: AgentInboxLinks;
  delivery: JsonRecord;
  occurredAt: string;
  createdAt: string;
};

export type AgentInboxOutboxPublishEnvelope = {
  attempt: number;
  correlationId: string;
  eventId: string;
  idempotencyKey: string;
  inboxItemId: string;
  organizationId: string;
  outboxId: string;
  payload: AgentInboxOutboxPayload;
  subject: string;
  trace: JsonRecord;
};

export type AgentInboxEventPlanePublisher = {
  publish(envelope: AgentInboxOutboxPublishEnvelope): Promise<{
    providerMessageId?: string | null;
    trace?: JsonRecord | null;
  } | void>;
};

export type AgentInboxOutboxPublishResult = {
  claimed: number;
  deadLettered: number;
  failed: number;
  published: number;
};

export async function recordMailMessageReceivedInboxItem(input: RecordMailMessageReceivedInboxItemInput) {
  return recordAgentInboxItem(buildMailMessageReceivedInboxItem(input));
}

export function buildMailMessageReceivedInboxItem(input: RecordMailMessageReceivedInboxItemInput) {
  const receivedAtIso = input.receivedAt?.toISOString() ?? null;
  return {
    actorType: "system",
    category: "mail",
    dedupeKey: `mail:message:${input.organizationId}:${input.messageId}:received`,
    eventType: "mail.message.received",
    linksJson: {
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      routeId: input.routeId,
    },
    organizationId: input.organizationId,
    payloadJson: {
      attachmentCount: input.attachmentCount ?? 0,
      hasEncryptedBody: input.hasEncryptedBody,
      hasEncryptedSubject: input.hasEncryptedSubject,
      hasAttachments: (input.attachmentCount ?? 0) > 0,
      direction: "inbound",
      mailboxAddress: input.mailboxAddress,
      mailboxId: input.mailboxId,
      messageId: input.messageId,
      projectId: input.projectId,
      providerAdapter: input.providerAdapter,
      receivedAt: receivedAtIso,
      requestId: input.requestId,
      sizeBytes: input.sizeBytes,
      status: "received",
      threadId: input.threadId ?? null,
    },
    projectId: input.projectId,
    sensitivity: "restricted",
    severity: "info",
    sourceId: input.messageId,
    sourceType: "mail_message",
    summary: `New inbound email for ${input.mailboxAddress}.`,
    targetId: input.mailboxId,
    targetType: "mailbox",
    title: "New email received",
    occurredAt: input.receivedAt ?? new Date(),
  } satisfies typeof schema.agentInboxItems.$inferInsert;
}

export type AgentInboxDbExecutor = Pick<typeof db, "insert" | "select" | "update">;

export function isInboxItemVisibleToInstallation(
  item: { targetType: string; targetId: string | null },
  localInstallationId: string,
) {
  if (item.targetType !== AGENT_INBOX_TARGET_LOCAL_INSTALLATION) return true;
  return item.targetId === localInstallationId;
}

export async function recordAgentInboxItem(
  input: typeof schema.agentInboxItems.$inferInsert,
  executor?: AgentInboxDbExecutor,
) {
  if (executor) {
    return writeAgentInboxItem(input, executor);
  }
  return db.transaction(async (tx) => writeAgentInboxItem(input, tx));
}

async function writeAgentInboxItem(
  input: typeof schema.agentInboxItems.$inferInsert,
  tx: AgentInboxDbExecutor,
) {
  const [item] = await tx
    .insert(schema.agentInboxItems)
    .values(input)
    .onConflictDoNothing()
    .returning();

  if (item) {
    await advanceWatermark(item.organizationId, item.sequence, item.occurredAt, tx);
    await enqueueAgentInboxOutboxItem(item, tx);
    return item;
  }

  const [existing] = await tx
    .select()
    .from(schema.agentInboxItems)
    .where(
      and(
        eq(schema.agentInboxItems.organizationId, input.organizationId),
        eq(schema.agentInboxItems.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);

  if (!existing) return null;
  await advanceWatermark(existing.organizationId, existing.sequence, existing.occurredAt, tx);
  await enqueueAgentInboxOutboxItem(existing, tx);
  return existing;
}

export function buildAgentInboxOutboxPayload(
  item: typeof schema.agentInboxItems.$inferSelect,
): AgentInboxOutboxPayload {
  return {
    version: 1,
    eventId: item.id,
    sequence: item.sequence,
    dedupeKey: item.dedupeKey,
    eventType: item.eventType,
    category: item.category,
    severity: item.severity,
    sensitivity: item.sensitivity,
    title: item.title,
    summary: item.summary,
    organization: { id: item.organizationId },
    project: item.projectId ? { id: item.projectId } : null,
    source: {
      type: item.sourceType,
      id: item.sourceId,
      requestId: safeString(item.payloadJson.requestId),
    },
    actor: { type: item.actorType, id: item.actorId },
    target: {
      type: item.targetType,
      id: item.targetId,
      ref: safeString(item.payloadJson.mailboxAddress),
    },
    payload: item.payloadJson,
    links: item.linksJson as AgentInboxLinks,
    delivery: {
      mode: "event_plane",
      state: "available",
    },
    occurredAt: item.occurredAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
  };
}

export async function publishAgentInboxOutboxBatch(input: {
  limit?: number;
  lockMs?: number;
  now?: Date;
  ownerId?: string;
  publisher: AgentInboxEventPlanePublisher;
}): Promise<AgentInboxOutboxPublishResult> {
  const now = input.now ?? new Date();
  const ownerId = input.ownerId ?? `agent-inbox-outbox:${randomUUID()}`;
  const rows = await claimAgentInboxOutboxEvents({
    limit: input.limit ?? DEFAULT_OUTBOX_LIMIT,
    lockMs: input.lockMs ?? DEFAULT_OUTBOX_LOCK_MS,
    now,
    ownerId,
  });
  const result: AgentInboxOutboxPublishResult = {
    claimed: rows.length,
    deadLettered: 0,
    failed: 0,
    published: 0,
  };

  for (const row of rows) {
    const attempt = row.attempts + 1;
    const envelope: AgentInboxOutboxPublishEnvelope = {
      attempt,
      correlationId: row.correlationId,
      eventId: row.eventId,
      idempotencyKey: row.idempotencyKey,
      inboxItemId: row.inboxItemId,
      organizationId: row.organizationId,
      outboxId: row.id,
      payload: row.payloadJson as AgentInboxOutboxPayload,
      subject: row.subject,
      trace: row.traceJson,
    };

    try {
      const publishResult = await input.publisher.publish(envelope);
      await markAgentInboxOutboxPublished({
        attempt,
        now: new Date(),
        outboxId: row.id,
        providerMessageId: publishResult?.providerMessageId ?? null,
        trace: publishResult?.trace ?? null,
      });
      result.published += 1;
    } catch (error) {
      const failed = await markAgentInboxOutboxFailed({
        attempt,
        errorCode: normalizeAgentInboxOutboxErrorCode(error),
        maxAttempts: row.maxAttempts,
        now: new Date(),
        outboxId: row.id,
      });
      if (failed.deadLettered) result.deadLettered += 1;
      else result.failed += 1;
    }
  }

  return result;
}

export function nextAgentInboxOutboxAttemptAt(attempt: number, now = new Date()) {
  const backoffMs = Math.min(
    OUTBOX_MAX_BACKOFF_MS,
    OUTBOX_BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
  );
  return new Date(now.getTime() + backoffMs);
}

export function normalizeAgentInboxOutboxErrorCode(error: unknown) {
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : error instanceof Error
        ? error.name
        : "publish_failed";
  const raw = String(rawCode ?? "publish_failed");
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(raw)) return "PUBLISH_FAILED";
  return raw.toUpperCase();
}

export { upsertScopedInbox as upsertGlobalInboxSubscription, scopedInboxPulse as getInboxPulse, pollScopedInbox as pollInbox, ackScopedInbox as ackInboxItems } from "./agent-inbox-scope";

export function buildInboxPulseEtag(input: {
  cacheKey: string;
  generation: number;
  latestSequence: number;
  subscriptionCursor: number | null;
  subscriptionId: string | null;
  subscribed: boolean;
}) {
  return [
    "W/\"ravi-inbox",
    input.cacheKey,
    input.generation,
    input.latestSequence,
    input.subscriptionCursor ?? "none",
    input.subscriptionId ?? "none",
    input.subscribed ? "1" : "0",
    "\"",
  ].join(":");
}


async function advanceWatermark(
  organizationId: string,
  latestSequence: number,
  latestItemAt: Date,
  database: AgentInboxDbExecutor = db,
) {
  const cacheKey = `${latestSequence}:${latestItemAt.getTime()}`;
  const now = new Date();
  const latestItemAtIso = latestItemAt.toISOString();
  const nowIso = now.toISOString();
  await database
    .insert(schema.agentInboxWatermarks)
    .values({
      organizationId,
      cacheKey,
      generation: 1,
      latestItemAt,
      latestSequence,
    })
    .onConflictDoUpdate({
      target: schema.agentInboxWatermarks.organizationId,
      set: {
        cacheKey: sql`CASE WHEN ${schema.agentInboxWatermarks.latestSequence} < ${latestSequence} THEN ${cacheKey} ELSE ${schema.agentInboxWatermarks.cacheKey} END`,
        generation: sql`${schema.agentInboxWatermarks.generation} + CASE WHEN ${schema.agentInboxWatermarks.latestSequence} < ${latestSequence} THEN 1 ELSE 0 END`,
        latestItemAt: sql`CASE WHEN ${schema.agentInboxWatermarks.latestSequence} < ${latestSequence} THEN ${latestItemAtIso}::timestamptz ELSE ${schema.agentInboxWatermarks.latestItemAt} END`,
        latestSequence: sql`GREATEST(${schema.agentInboxWatermarks.latestSequence}, ${latestSequence})`,
        updatedAt: sql`CASE WHEN ${schema.agentInboxWatermarks.latestSequence} < ${latestSequence} THEN ${nowIso}::timestamptz ELSE ${schema.agentInboxWatermarks.updatedAt} END`,
      },
    });
}

async function enqueueAgentInboxOutboxItem(
  item: typeof schema.agentInboxItems.$inferSelect,
  database: AgentInboxDbExecutor = db,
) {
  const payload = buildAgentInboxOutboxPayload(item);
  const now = new Date();
  const correlationId = safeString(item.payloadJson.requestId) ?? item.id;
  const idempotencyKey = `agent-inbox:${item.organizationId}:${item.id}`;

  await database
    .insert(schema.agentInboxOutboxEvents)
    .values({
      organizationId: item.organizationId,
      inboxItemId: item.id,
      eventId: payload.eventId,
      subject: AGENT_INBOX_EVENT_SUBJECT,
      idempotencyKey,
      payloadJson: payload,
      status: "pending",
      nextAttemptAt: now,
      correlationId,
      traceJson: buildAgentInboxOutboxTrace(item, correlationId),
    })
    .onConflictDoUpdate({
      target: schema.agentInboxOutboxEvents.inboxItemId,
      set: {
        eventId: payload.eventId,
        subject: AGENT_INBOX_EVENT_SUBJECT,
        idempotencyKey,
        payloadJson: payload,
        status: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.status} ELSE 'pending'::agent_inbox_outbox_status END`,
        nextAttemptAt: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.nextAttemptAt} ELSE ${now.toISOString()}::timestamptz END`,
        lockedBy: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.lockedBy} ELSE NULL END`,
        lockedUntil: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.lockedUntil} ELSE NULL END`,
        deadLetterAt: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.deadLetterAt} ELSE NULL END`,
        lastErrorCode: sql`CASE WHEN ${schema.agentInboxOutboxEvents.status} = 'published' THEN ${schema.agentInboxOutboxEvents.lastErrorCode} ELSE NULL END`,
        correlationId,
        traceJson: buildAgentInboxOutboxTrace(item, correlationId),
        updatedAt: now,
      },
    });
}

async function claimAgentInboxOutboxEvents(input: {
  limit: number;
  lockMs: number;
  now: Date;
  ownerId: string;
}) {
  const statuses = ["pending", "failed", "publishing"] as const;
  const candidates = await db
    .select()
    .from(schema.agentInboxOutboxEvents)
    .where(
      and(
        inArray(schema.agentInboxOutboxEvents.status, statuses),
        lte(schema.agentInboxOutboxEvents.nextAttemptAt, input.now),
        or(
          isNull(schema.agentInboxOutboxEvents.lockedUntil),
          lte(schema.agentInboxOutboxEvents.lockedUntil, input.now),
        ),
      ),
    )
    .orderBy(
      asc(schema.agentInboxOutboxEvents.nextAttemptAt),
      asc(schema.agentInboxOutboxEvents.createdAt),
    )
    .limit(Math.max(1, Math.min(input.limit, 100)));

  const lockedUntil = new Date(input.now.getTime() + input.lockMs);
  const claimed: (typeof schema.agentInboxOutboxEvents.$inferSelect)[] = [];
  for (const candidate of candidates) {
    const [row] = await db
      .update(schema.agentInboxOutboxEvents)
      .set({
        status: "publishing",
        lockedBy: input.ownerId,
        lockedUntil,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.agentInboxOutboxEvents.id, candidate.id),
          inArray(schema.agentInboxOutboxEvents.status, statuses),
          or(
            isNull(schema.agentInboxOutboxEvents.lockedUntil),
            lte(schema.agentInboxOutboxEvents.lockedUntil, input.now),
          ),
        ),
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

async function markAgentInboxOutboxPublished(input: {
  attempt: number;
  now: Date;
  outboxId: string;
  providerMessageId: string | null;
  trace: JsonRecord | null;
}) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.agentInboxOutboxEvents)
      .set({
        status: "published",
        attempts: input.attempt,
        publishedAt: input.now,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: null,
        traceJson: sql`${schema.agentInboxOutboxEvents.traceJson} || ${JSON.stringify(input.trace ?? {})}::jsonb`,
        updatedAt: input.now,
      })
      .where(eq(schema.agentInboxOutboxEvents.id, input.outboxId))
      .returning();

    if (!row) return;
    await tx.insert(schema.auditEvents).values({
      organizationId: row.organizationId,
      actorType: "system",
      targetType: "agent_inbox_outbox_event",
      targetId: row.id,
      action: "agent_inbox.outbox.published",
      requestId: row.correlationId,
      metadataJson: {
        eventId: row.eventId,
        inboxItemId: row.inboxItemId,
        providerMessageId: input.providerMessageId,
        subject: row.subject,
        attempts: input.attempt,
      },
    });
  });
}

async function markAgentInboxOutboxFailed(input: {
  attempt: number;
  errorCode: string;
  maxAttempts: number;
  now: Date;
  outboxId: string;
}) {
  const deadLettered = input.attempt >= input.maxAttempts;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.agentInboxOutboxEvents)
      .set({
        status: deadLettered ? "dead_letter" : "failed",
        attempts: input.attempt,
        nextAttemptAt: deadLettered
          ? input.now
          : nextAgentInboxOutboxAttemptAt(input.attempt, input.now),
        lockedBy: null,
        lockedUntil: null,
        deadLetterAt: deadLettered ? input.now : null,
        lastErrorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(eq(schema.agentInboxOutboxEvents.id, input.outboxId))
      .returning();

    if (!row || !deadLettered) return;
    await tx.insert(schema.auditEvents).values({
      organizationId: row.organizationId,
      actorType: "system",
      targetType: "agent_inbox_outbox_event",
      targetId: row.id,
      action: "agent_inbox.outbox.dead_lettered",
      requestId: row.correlationId,
      metadataJson: {
        eventId: row.eventId,
        errorCode: input.errorCode,
        inboxItemId: row.inboxItemId,
        subject: row.subject,
        attempts: input.attempt,
      },
    });
  });

  return { deadLettered };
}

function buildAgentInboxOutboxTrace(
  item: typeof schema.agentInboxItems.$inferSelect,
  correlationId: string,
): JsonRecord {
  return {
    correlationId,
    inboxItemId: item.id,
    producer: "agent_inbox",
    requestId: safeString(item.payloadJson.requestId),
    sourceType: item.sourceType,
  };
}

function safeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}


export function deliveryItem(
  item: typeof schema.agentInboxItems.$inferSelect,
  receipt: typeof schema.agentInboxReceipts.$inferSelect,
  leaseId: string,
  leaseExpiresAt: Date,
): AgentInboxDeliveryItem {
  const leaseSeconds = Math.floor(DEFAULT_LEASE_MS / 1000);
  const leaseExpiresAtIso = leaseExpiresAt.toISOString();
  return {
    id: item.id,
    itemId: item.id,
    sequence: item.sequence,
    dedupeKey: item.dedupeKey,
    eventType: item.eventType,
    category: item.category,
    severity: item.severity,
    sensitivity: item.sensitivity,
    title: item.title,
    summary: item.summary,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    targetType: item.targetType,
    targetId: item.targetId,
    source: { type: item.sourceType, id: item.sourceId },
    actor: { type: item.actorType, id: item.actorId },
    target: { type: item.targetType, id: item.targetId },
    organization: { id: item.organizationId },
    project: item.projectId ? { id: item.projectId } : null,
    payload: item.payloadJson,
    links: item.linksJson as AgentInboxLinks,
    occurredAt: item.occurredAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
    receiptId: receipt.id,
    leaseId,
    leaseExpiresAt: leaseExpiresAtIso,
    lease: {
      expiresAt: leaseExpiresAtIso,
      id: leaseId,
      seconds: leaseSeconds,
    },
  };
}
