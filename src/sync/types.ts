export const SYNC_OUTBOX_STATUSES = ["pending", "leased", "sent", "acked", "failed", "dead"] as const;
export type SyncOutboxStatus = (typeof SYNC_OUTBOX_STATUSES)[number];

export const SYNC_INBOX_STATUSES = ["pending", "applied", "skipped", "failed", "dead"] as const;
export type SyncInboxStatus = (typeof SYNC_INBOX_STATUSES)[number];

export interface SyncEventEnvelope {
  eventId: string;
  originInstallationId?: string | null;
  domain: string;
  eventType: string;
  entityType: string;
  entityId: string;
  entityRevision?: number | null;
  idempotencyKey: string;
  occurredAt: string;
  payload: unknown;
  evidenceRefs?: unknown[];
  schemaVersion: number;
}

export interface SyncOutboxRecord {
  id: string;
  eventId: string;
  originInstallationId: string | null;
  domain: string;
  eventType: string;
  entityType: string;
  entityId: string;
  entityRevision: number | null;
  idempotencyKey: string;
  payload: unknown;
  evidenceRefs: unknown[];
  schemaVersion: number;
  status: SyncOutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  leaseId: string | null;
  leasedUntil: number | null;
  lastErrorCode: string | null;
  occurredAt: number;
  sentAt: number | null;
  ackedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncInboxRecord {
  id: string;
  remoteSequence: string | null;
  remoteEventId: string;
  domain: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  status: SyncInboxStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  receivedAt: number;
  appliedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncCursorRecord {
  domain: string;
  cursorKey: string;
  cursorValue: string | null;
  updatedAt: number;
  meta: unknown | null;
}

export interface SyncBatch<T> {
  items: T[];
  leaseId?: string;
  bytes: number;
}

export interface SyncStatusSummary {
  outbox: {
    pending: number;
    leased: number;
    sent: number;
    acked: number;
    failed: number;
    dead: number;
  };
  inbox: {
    pending: number;
    applied: number;
    skipped: number;
    failed: number;
    dead: number;
  };
  cursors: SyncCursorRecord[];
  lastError: string | null;
}
