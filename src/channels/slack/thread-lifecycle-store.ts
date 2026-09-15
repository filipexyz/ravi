import { randomUUID } from "node:crypto";
import { executeWrite } from "../../db/write-retry.js";
import { getDb } from "../../router/router-db.js";

export type SlackThreadLifecycleSource = "action" | "inbound";
export type SlackThreadLifecycleStatus = "queued" | "root_delivered" | "starting" | "open" | "closed" | "failed";

export interface SlackThreadLifecycleRecord {
  requestId: string;
  source: SlackThreadLifecycleSource;
  status: SlackThreadLifecycleStatus;
  parentSessionKey: string;
  parentSessionName: string;
  initiatorSessionKey?: string;
  initiatorSessionName?: string;
  childSessionKey?: string;
  childSessionName?: string;
  accountId: string;
  instanceId: string;
  platformChatId: string;
  rootCanonicalChatId?: string;
  threadCanonicalChatId?: string;
  providerThreadId?: string;
  canonicalRootMessageId?: string;
  initialPrompt?: string;
  modelOverride?: string;
  creationClaimId?: string;
  creationClaimExpiresAt?: number;
  promptPublishedAt?: number;
  closeSequence: number;
  closeResult?: string;
  closedAt?: number;
  parentReturnRequested: boolean;
  parentEventId?: string;
  parentNotificationClaimId?: string;
  parentNotificationClaimExpiresAt?: number;
  parentNotifiedAt?: number;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

interface SlackThreadLifecycleRow {
  request_id: string;
  source: SlackThreadLifecycleSource;
  status: SlackThreadLifecycleStatus;
  parent_session_key: string;
  parent_session_name: string;
  initiator_session_key: string | null;
  initiator_session_name: string | null;
  child_session_key: string | null;
  child_session_name: string | null;
  account_id: string;
  instance_id: string;
  platform_chat_id: string;
  root_canonical_chat_id: string | null;
  thread_canonical_chat_id: string | null;
  provider_thread_id: string | null;
  canonical_root_message_id: string | null;
  initial_prompt: string | null;
  model_override: string | null;
  creation_claim_id: string | null;
  creation_claim_expires_at: number | null;
  prompt_published_at: number | null;
  close_sequence: number;
  close_result: string | null;
  closed_at: number | null;
  parent_return_requested: number;
  parent_event_id: string | null;
  parent_notification_claim_id: string | null;
  parent_notification_claim_expires_at: number | null;
  parent_notified_at: number | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSlackThreadLifecycleInput {
  requestId?: string;
  parentSessionKey: string;
  parentSessionName: string;
  initiatorSessionKey?: string;
  initiatorSessionName?: string;
  accountId: string;
  instanceId: string;
  platformChatId: string;
  rootCanonicalChatId?: string;
  initialPrompt: string;
  modelOverride?: string;
  createdAt?: number;
}

export interface RegisterInboundSlackThreadInput {
  requestId?: string;
  parentSessionKey: string;
  parentSessionName: string;
  childSessionKey: string;
  childSessionName: string;
  accountId: string;
  instanceId: string;
  platformChatId: string;
  rootCanonicalChatId?: string;
  threadCanonicalChatId: string;
  providerThreadId: string;
  seenAt?: number;
}

export interface CloseSlackThreadLifecycleResult {
  record: SlackThreadLifecycleRecord;
  changed: boolean;
}

export function createSlackThreadLifecycle(input: CreateSlackThreadLifecycleInput): SlackThreadLifecycleRecord {
  const requestId = requireText(input.requestId ?? `slack-thread:${randomUUID()}`, "requestId");
  const initialPrompt = requireText(input.initialPrompt, "initialPrompt");
  const now = input.createdAt ?? Date.now();
  executeWrite(
    getDb(),
    (database) => {
      database
        .prepare(
          `
          INSERT INTO slack_thread_lifecycle (
            request_id, source, status, parent_session_key, parent_session_name,
            initiator_session_key, initiator_session_name, account_id, instance_id,
            platform_chat_id, root_canonical_chat_id, initial_prompt, model_override,
            created_at, updated_at
          )
          VALUES (?, 'action', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(request_id) DO NOTHING
        `,
        )
        .run(
          requestId,
          requireText(input.parentSessionKey, "parentSessionKey"),
          requireText(input.parentSessionName, "parentSessionName"),
          cleanOptional(input.initiatorSessionKey),
          cleanOptional(input.initiatorSessionName),
          requireText(input.accountId, "accountId"),
          requireText(input.instanceId, "instanceId"),
          requireText(input.platformChatId, "platformChatId"),
          cleanOptional(input.rootCanonicalChatId),
          initialPrompt,
          cleanOptional(input.modelOverride),
          now,
          now,
        );
    },
    { label: "slack_thread_lifecycle_create" },
  );
  return requireSlackThreadLifecycle(requestId);
}

export function getSlackThreadLifecycle(requestId: string): SlackThreadLifecycleRecord | null {
  const row = getDb().prepare("SELECT * FROM slack_thread_lifecycle WHERE request_id = ?").get(requestId) as
    | SlackThreadLifecycleRow
    | undefined;
  return row ? rowToSlackThreadLifecycle(row) : null;
}

export function findSlackThreadLifecycleByChildSession(childSessionKey: string): SlackThreadLifecycleRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE child_session_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(childSessionKey) as SlackThreadLifecycleRow | undefined;
  return row ? rowToSlackThreadLifecycle(row) : null;
}

export function findSlackThreadLifecycleByProviderThread(input: {
  instanceId: string;
  platformChatId: string;
  providerThreadId: string;
}): SlackThreadLifecycleRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE instance_id = ? AND platform_chat_id = ? AND provider_thread_id = ?
      LIMIT 1
    `,
    )
    .get(input.instanceId, input.platformChatId, input.providerThreadId) as SlackThreadLifecycleRow | undefined;
  return row ? rowToSlackThreadLifecycle(row) : null;
}

export function markSlackThreadRootDelivered(input: {
  requestId: string;
  providerThreadId: string;
  canonicalRootMessageId?: string;
  deliveredAt?: number;
}): SlackThreadLifecycleRecord {
  const now = input.deliveredAt ?? Date.now();
  executeWrite(
    getDb(),
    (database) => {
      database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET status = CASE WHEN status = 'queued' THEN 'root_delivered' ELSE status END,
              provider_thread_id = COALESCE(provider_thread_id, ?),
              canonical_root_message_id = COALESCE(canonical_root_message_id, ?),
              failure_reason = NULL,
              updated_at = ?
          WHERE request_id = ?
            AND source = 'action'
            AND (provider_thread_id IS NULL OR provider_thread_id = ?)
        `,
        )
        .run(
          requireText(input.providerThreadId, "providerThreadId"),
          cleanOptional(input.canonicalRootMessageId),
          now,
          requireText(input.requestId, "requestId"),
          requireText(input.providerThreadId, "providerThreadId"),
        );
    },
    { label: "slack_thread_lifecycle_root_delivered" },
  );
  return requireSlackThreadLifecycle(input.requestId);
}

export function claimSlackThreadCreation(input: {
  requestId: string;
  claimId?: string;
  leaseMs?: number;
  now?: number;
}): SlackThreadLifecycleRecord | null {
  const claimId = input.claimId?.trim() || randomUUID();
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(1_000, input.leaseMs ?? 60_000);
  return executeWrite(
    getDb(),
    (database) => {
      const updated = database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET status = 'starting',
              creation_claim_id = ?,
              creation_claim_expires_at = ?,
              updated_at = ?
          WHERE request_id = ?
            AND source = 'action'
            AND provider_thread_id IS NOT NULL
            AND prompt_published_at IS NULL
            AND (
              status = 'root_delivered'
              OR (
                status = 'starting'
                AND COALESCE(creation_claim_expires_at, 0) <= ?
              )
            )
        `,
        )
        .run(claimId, expiresAt, now, input.requestId, now);
      if (updated.changes === 0) return null;
      return selectSlackThreadLifecycle(database, input.requestId);
    },
    { label: "slack_thread_lifecycle_claim_creation" },
  );
}

export function releaseSlackThreadCreationClaim(input: {
  requestId: string;
  claimId: string;
  failureReason: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET status = 'root_delivered',
              creation_claim_id = NULL,
              creation_claim_expires_at = NULL,
              failure_reason = ?,
              updated_at = ?
          WHERE request_id = ?
            AND status = 'starting'
            AND creation_claim_id = ?
            AND prompt_published_at IS NULL
        `,
        )
        .run(input.failureReason, now, input.requestId, input.claimId).changes > 0,
    { label: "slack_thread_lifecycle_release_creation" },
  );
}

export function completeSlackThreadCreation(input: {
  requestId: string;
  claimId: string;
  childSessionKey: string;
  childSessionName: string;
  threadCanonicalChatId: string;
  promptPublishedAt?: number;
}): SlackThreadLifecycleRecord {
  const now = input.promptPublishedAt ?? Date.now();
  const completed = executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET status = 'open',
              child_session_key = ?,
              child_session_name = ?,
              thread_canonical_chat_id = ?,
              prompt_published_at = COALESCE(prompt_published_at, ?),
              creation_claim_id = NULL,
              creation_claim_expires_at = NULL,
              failure_reason = NULL,
              updated_at = ?
          WHERE request_id = ?
            AND creation_claim_id = ?
        `,
        )
        .run(
          input.childSessionKey,
          input.childSessionName,
          input.threadCanonicalChatId,
          now,
          now,
          input.requestId,
          input.claimId,
        ).changes > 0,
    { label: "slack_thread_lifecycle_complete_creation" },
  );
  if (!completed) {
    throw new Error(`Slack thread creation claim was lost before completion: ${input.requestId}`);
  }
  return requireSlackThreadLifecycle(input.requestId);
}

export function listPendingSlackThreadCreations(
  input: { now?: number; limit?: number } = {},
): SlackThreadLifecycleRecord[] {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE source = 'action'
        AND provider_thread_id IS NOT NULL
        AND prompt_published_at IS NULL
        AND (
          status = 'root_delivered'
          OR (status = 'starting' AND COALESCE(creation_claim_expires_at, 0) <= ?)
        )
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    )
    .all(now, limit) as SlackThreadLifecycleRow[];
  return rows.map(rowToSlackThreadLifecycle);
}

export function registerInboundSlackThread(input: RegisterInboundSlackThreadInput): SlackThreadLifecycleRecord {
  const requestId =
    input.requestId?.trim() || `slack-inbound:${input.instanceId}:${input.platformChatId}:${input.providerThreadId}`;
  const now = input.seenAt ?? Date.now();
  return executeWrite(
    getDb(),
    (database) => {
      database
        .prepare(
          `
          INSERT INTO slack_thread_lifecycle (
            request_id, source, status, parent_session_key, parent_session_name,
            child_session_key, child_session_name, account_id, instance_id,
            platform_chat_id, root_canonical_chat_id, thread_canonical_chat_id,
            provider_thread_id, prompt_published_at, created_at, updated_at
          )
          VALUES (?, 'inbound', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(instance_id, platform_chat_id, provider_thread_id) DO UPDATE SET
            parent_session_key = excluded.parent_session_key,
            parent_session_name = excluded.parent_session_name,
            child_session_key = excluded.child_session_key,
            child_session_name = excluded.child_session_name,
            account_id = excluded.account_id,
            root_canonical_chat_id = COALESCE(
              excluded.root_canonical_chat_id,
              slack_thread_lifecycle.root_canonical_chat_id
            ),
            thread_canonical_chat_id = excluded.thread_canonical_chat_id,
            status = CASE
              WHEN slack_thread_lifecycle.source = 'action'
                AND slack_thread_lifecycle.prompt_published_at IS NULL
                AND slack_thread_lifecycle.status IN ('root_delivered', 'starting')
                THEN slack_thread_lifecycle.status
              ELSE 'open'
            END,
            closed_at = CASE
              WHEN slack_thread_lifecycle.source = 'action'
                AND slack_thread_lifecycle.prompt_published_at IS NULL
                AND slack_thread_lifecycle.status IN ('root_delivered', 'starting')
                THEN slack_thread_lifecycle.closed_at
              ELSE NULL
            END,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          requestId,
          input.parentSessionKey,
          input.parentSessionName,
          input.childSessionKey,
          input.childSessionName,
          input.accountId,
          input.instanceId,
          input.platformChatId,
          cleanOptional(input.rootCanonicalChatId),
          input.threadCanonicalChatId,
          input.providerThreadId,
          now,
          now,
          now,
        );
      return selectSlackThreadLifecycleByProviderThread(database, input);
    },
    { label: "slack_thread_lifecycle_register_inbound" },
  );
}

export function closeSlackThreadLifecycle(input: {
  childSessionKey: string;
  returnResult?: string;
  closedAt?: number;
}): CloseSlackThreadLifecycleResult {
  const now = input.closedAt ?? Date.now();
  const returnResult = cleanOptional(input.returnResult);
  return executeWrite(
    getDb(),
    (database) => {
      const existing = selectSlackThreadLifecycleByChildSession(database, input.childSessionKey);
      if (!existing) {
        throw new Error(`Slack thread lifecycle not found for session: ${input.childSessionKey}`);
      }
      if (existing.status === "closed") {
        return { record: existing, changed: false };
      }
      const nextSequence = existing.closeSequence + 1;
      const parentEventId = returnResult ? `slack-thread-close:${existing.requestId}:${nextSequence}` : null;
      const updated = database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET status = 'closed',
              close_sequence = ?,
              close_result = ?,
              closed_at = ?,
              parent_return_requested = ?,
              parent_event_id = ?,
              parent_notification_claim_id = NULL,
              parent_notification_claim_expires_at = NULL,
              parent_notified_at = NULL,
              updated_at = ?
          WHERE request_id = ?
            AND status != 'closed'
        `,
        )
        .run(nextSequence, returnResult, now, returnResult ? 1 : 0, parentEventId, now, existing.requestId);
      if (updated.changes === 0) {
        return {
          record: selectSlackThreadLifecycle(database, existing.requestId),
          changed: false,
        };
      }
      return {
        record: selectSlackThreadLifecycle(database, existing.requestId),
        changed: true,
      };
    },
    { label: "slack_thread_lifecycle_close" },
  );
}

export function claimSlackThreadParentReturn(input: {
  requestId: string;
  claimId?: string;
  leaseMs?: number;
  now?: number;
}): SlackThreadLifecycleRecord | null {
  const claimId = input.claimId?.trim() || randomUUID();
  const now = input.now ?? Date.now();
  const expiresAt = now + Math.max(1_000, input.leaseMs ?? 60_000);
  return executeWrite(
    getDb(),
    (database) => {
      const updated = database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET parent_notification_claim_id = ?,
              parent_notification_claim_expires_at = ?,
              updated_at = ?
          WHERE request_id = ?
            AND parent_return_requested = 1
            AND parent_notified_at IS NULL
            AND (
              parent_notification_claim_id IS NULL
              OR COALESCE(parent_notification_claim_expires_at, 0) <= ?
            )
        `,
        )
        .run(claimId, expiresAt, now, input.requestId, now);
      if (updated.changes === 0) return null;
      return selectSlackThreadLifecycle(database, input.requestId);
    },
    { label: "slack_thread_lifecycle_claim_parent_return" },
  );
}

export function releaseSlackThreadParentReturnClaim(input: {
  requestId: string;
  claimId: string;
  failureReason: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET parent_notification_claim_id = NULL,
              parent_notification_claim_expires_at = NULL,
              failure_reason = ?,
              updated_at = ?
          WHERE request_id = ?
            AND parent_notification_claim_id = ?
            AND parent_notified_at IS NULL
        `,
        )
        .run(input.failureReason, now, input.requestId, input.claimId).changes > 0,
    { label: "slack_thread_lifecycle_release_parent_return" },
  );
}

export function completeSlackThreadParentReturn(input: {
  requestId: string;
  claimId: string;
  notifiedAt?: number;
}): SlackThreadLifecycleRecord {
  const now = input.notifiedAt ?? Date.now();
  const completed = executeWrite(
    getDb(),
    (database) =>
      database
        .prepare(
          `
          UPDATE slack_thread_lifecycle
          SET parent_notified_at = COALESCE(parent_notified_at, ?),
              parent_notification_claim_id = NULL,
              parent_notification_claim_expires_at = NULL,
              failure_reason = NULL,
              updated_at = ?
          WHERE request_id = ?
            AND parent_notification_claim_id = ?
        `,
        )
        .run(now, now, input.requestId, input.claimId).changes > 0,
    { label: "slack_thread_lifecycle_complete_parent_return" },
  );
  if (!completed) {
    throw new Error(`Slack thread parent return claim was lost before completion: ${input.requestId}`);
  }
  return requireSlackThreadLifecycle(input.requestId);
}

export function listPendingSlackThreadParentReturns(
  input: { now?: number; limit?: number } = {},
): SlackThreadLifecycleRecord[] {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = getDb()
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE parent_return_requested = 1
        AND parent_notified_at IS NULL
        AND (
          parent_notification_claim_id IS NULL
          OR COALESCE(parent_notification_claim_expires_at, 0) <= ?
        )
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    )
    .all(now, limit) as SlackThreadLifecycleRow[];
  return rows.map(rowToSlackThreadLifecycle);
}

function selectSlackThreadLifecycle(database: ReturnType<typeof getDb>, requestId: string): SlackThreadLifecycleRecord {
  const row = database.prepare("SELECT * FROM slack_thread_lifecycle WHERE request_id = ?").get(requestId) as
    | SlackThreadLifecycleRow
    | undefined;
  if (!row) throw new Error(`Slack thread lifecycle not found: ${requestId}`);
  return rowToSlackThreadLifecycle(row);
}

function selectSlackThreadLifecycleByChildSession(
  database: ReturnType<typeof getDb>,
  childSessionKey: string,
): SlackThreadLifecycleRecord | null {
  const row = database
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE child_session_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(childSessionKey) as SlackThreadLifecycleRow | undefined;
  return row ? rowToSlackThreadLifecycle(row) : null;
}

function selectSlackThreadLifecycleByProviderThread(
  database: ReturnType<typeof getDb>,
  input: Pick<RegisterInboundSlackThreadInput, "instanceId" | "platformChatId" | "providerThreadId">,
): SlackThreadLifecycleRecord {
  const row = database
    .prepare(
      `
      SELECT *
      FROM slack_thread_lifecycle
      WHERE instance_id = ? AND platform_chat_id = ? AND provider_thread_id = ?
      LIMIT 1
    `,
    )
    .get(input.instanceId, input.platformChatId, input.providerThreadId) as SlackThreadLifecycleRow | undefined;
  if (!row) throw new Error("Slack thread lifecycle was not registered");
  return rowToSlackThreadLifecycle(row);
}

function requireSlackThreadLifecycle(requestId: string): SlackThreadLifecycleRecord {
  const record = getSlackThreadLifecycle(requestId);
  if (!record) throw new Error(`Slack thread lifecycle not found: ${requestId}`);
  return record;
}

function rowToSlackThreadLifecycle(row: SlackThreadLifecycleRow): SlackThreadLifecycleRecord {
  return {
    requestId: row.request_id,
    source: row.source,
    status: row.status,
    parentSessionKey: row.parent_session_key,
    parentSessionName: row.parent_session_name,
    ...(row.initiator_session_key ? { initiatorSessionKey: row.initiator_session_key } : {}),
    ...(row.initiator_session_name ? { initiatorSessionName: row.initiator_session_name } : {}),
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.child_session_name ? { childSessionName: row.child_session_name } : {}),
    accountId: row.account_id,
    instanceId: row.instance_id,
    platformChatId: row.platform_chat_id,
    ...(row.root_canonical_chat_id ? { rootCanonicalChatId: row.root_canonical_chat_id } : {}),
    ...(row.thread_canonical_chat_id ? { threadCanonicalChatId: row.thread_canonical_chat_id } : {}),
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    ...(row.canonical_root_message_id ? { canonicalRootMessageId: row.canonical_root_message_id } : {}),
    ...(row.initial_prompt ? { initialPrompt: row.initial_prompt } : {}),
    ...(row.model_override ? { modelOverride: row.model_override } : {}),
    ...(row.creation_claim_id ? { creationClaimId: row.creation_claim_id } : {}),
    ...(row.creation_claim_expires_at !== null ? { creationClaimExpiresAt: row.creation_claim_expires_at } : {}),
    ...(row.prompt_published_at !== null ? { promptPublishedAt: row.prompt_published_at } : {}),
    closeSequence: row.close_sequence,
    ...(row.close_result ? { closeResult: row.close_result } : {}),
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
    parentReturnRequested: row.parent_return_requested === 1,
    ...(row.parent_event_id ? { parentEventId: row.parent_event_id } : {}),
    ...(row.parent_notification_claim_id ? { parentNotificationClaimId: row.parent_notification_claim_id } : {}),
    ...(row.parent_notification_claim_expires_at !== null
      ? { parentNotificationClaimExpiresAt: row.parent_notification_claim_expires_at }
      : {}),
    ...(row.parent_notified_at !== null ? { parentNotifiedAt: row.parent_notified_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function cleanOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
