import { createHash } from "node:crypto";
import { upsertLocalInboxItem, type LocalInboxItem } from "../inbox/local-db.js";
import { publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import type { RuntimeProviderId } from "./types.js";

const log = logger.child("runtime:recovery-alert");

export const RUNTIME_RECOVERY_EXHAUSTED_SUBJECT = "ravi.inbox.system.runtime_recovery_exhausted" as const;

export interface RuntimeRecoveryExhaustedAlertInput {
  sessionKey: string;
  sessionName: string;
  agentId?: string;
  provider?: RuntimeProviderId;
  reason: string;
  restartAttempts: number;
  stashedQueueSize: number;
  sourceMessageId?: string;
  occurredAt?: number;
}

export interface RuntimeRecoveryExhaustedAlertResult {
  item: LocalInboxItem | null;
  created: boolean;
  published: boolean;
}

type RuntimeRecoveryAlertPublisher = (subject: string, payload: Record<string, unknown>) => Promise<void> | void;

let runtimeRecoveryAlertPublisher: RuntimeRecoveryAlertPublisher = publish;

export function setRuntimeRecoveryAlertPublisherForTests(publisher?: RuntimeRecoveryAlertPublisher): void {
  runtimeRecoveryAlertPublisher = publisher ?? publish;
}

export async function notifyRuntimeRecoveryExhausted(
  input: RuntimeRecoveryExhaustedAlertInput,
): Promise<RuntimeRecoveryExhaustedAlertResult> {
  const occurredAt = input.occurredAt ?? Date.now();
  const sourceId = buildRecoverySourceId(input, occurredAt);
  const dedupeKey = `runtime-recovery-exhausted:${sourceId}`;
  let item: LocalInboxItem | null = null;
  let created = true;

  try {
    const projection = upsertLocalInboxItem({
      sourceDomain: "system",
      sourceType: "runtime_recovery_exhausted",
      sourceId,
      dedupeKey,
      title: "Runtime recovery exhausted",
      summary: `Session "${input.sessionName}" stopped after ${input.restartAttempts} automatic restart attempts. Inspect its trace before retrying.`,
      status: "open",
      priority: "urgent",
      occurredAt,
      metadata: {
        sessionKey: input.sessionKey,
        sessionName: input.sessionName,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        reason: input.reason,
        restartAttempts: input.restartAttempts,
        stashedQueueSize: input.stashedQueueSize,
      },
      actorType: "system",
    });
    item = projection.item;
    created = projection.created;
  } catch (error) {
    log.error("Failed to project exhausted runtime recovery into the local inbox", {
      sessionName: input.sessionName,
      error,
    });
  }

  if (!created) {
    return { item, created: false, published: false };
  }

  const timestamp = new Date(occurredAt).toISOString();
  try {
    await runtimeRecoveryAlertPublisher(RUNTIME_RECOVERY_EXHAUSTED_SUBJECT, {
      version: 1,
      eventType: "inbox.system.runtime_recovery_exhausted",
      inboxItemId: item?.id ?? null,
      sourceDomain: "system",
      sourceType: "runtime_recovery_exhausted",
      sourceId,
      dedupeKey,
      severity: "critical",
      sessionName: input.sessionName,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      reason: input.reason,
      restartAttempts: input.restartAttempts,
      stashedQueueSize: input.stashedQueueSize,
      occurredAt: timestamp,
      createdAt: timestamp,
    });
    return { item, created, published: true };
  } catch (error) {
    log.error("Failed to publish exhausted runtime recovery alert", {
      sessionName: input.sessionName,
      error,
    });
    return { item, created, published: false };
  }
}

function buildRecoverySourceId(input: RuntimeRecoveryExhaustedAlertInput, occurredAt: number): string {
  const episode = input.sourceMessageId?.trim() || `occurred-at:${occurredAt}`;
  return createHash("sha256").update(`${input.sessionKey}\0${episode}`).digest("hex").slice(0, 24);
}
