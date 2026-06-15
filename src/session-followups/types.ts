import type { CronSchedule } from "../cron/types.js";
import type { DeliveryBarrier } from "../delivery-barriers.js";

export type SessionFollowupTargetType = "session" | "chat" | "reading_list";
export type SessionFollowupStatus = "pending" | "leased" | "sent" | "skipped" | "failed" | "dead";
export type SessionFollowupCadenceStatus = "ok" | "skipped" | "failed";

export interface SessionFollowupStep {
  afterMs: number;
  messageTemplate: string;
  label?: string;
}

export type SessionFollowupSchedule = CronSchedule & {
  steps?: SessionFollowupStep[];
};

export interface SessionFollowupCadence {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  ownerType: string;
  ownerId: string;
  targetType: SessionFollowupTargetType;
  targetRef: string;
  schedule: SessionFollowupSchedule;
  deliveryBarrier: DeliveryBarrier;
  messageTemplate: string;
  metadata?: Record<string, unknown>;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: SessionFollowupCadenceStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionFollowupCadenceInput {
  id?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  ownerType?: string;
  ownerId?: string;
  targetType: SessionFollowupTargetType;
  targetRef: string;
  schedule: SessionFollowupSchedule;
  deliveryBarrier?: string;
  messageTemplate: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface SessionFollowupCadenceUpdateInput {
  name?: string;
  description?: string | null;
  schedule?: SessionFollowupSchedule;
  deliveryBarrier?: string;
  messageTemplate?: string;
  metadata?: Record<string, unknown>;
  recalculateNextRun?: boolean;
  now?: number;
}

export interface SessionFollowupRun {
  id: string;
  cadenceId: string;
  targetType: SessionFollowupTargetType;
  targetRef: string;
  sessionName?: string;
  sessionKey?: string;
  chatId?: string;
  status: SessionFollowupStatus;
  dueAt: number;
  leasedUntil?: number;
  attemptCount: number;
  nextAttemptAt?: number;
  idempotencyKey: string;
  promptText?: string;
  eventPayload?: Record<string, unknown>;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
}

export interface SessionFollowupRunInput {
  cadenceId: string;
  targetType: SessionFollowupTargetType;
  targetRef: string;
  sessionName?: string;
  sessionKey?: string;
  chatId?: string;
  dueAt: number;
  idempotencyKey: string;
  eventPayload?: Record<string, unknown>;
  now?: number;
}

export interface SessionFollowupRunResult {
  run: SessionFollowupRun;
  created: boolean;
}

export interface SessionFollowupListInput {
  includeDisabled?: boolean;
  targetType?: SessionFollowupTargetType;
  limit?: number | string | null;
  offset?: number | string | null;
}

export interface SessionFollowupRunListInput {
  cadenceId?: string;
  status?: SessionFollowupStatus;
  limit?: number | string | null;
  offset?: number | string | null;
}
