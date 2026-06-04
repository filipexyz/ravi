import { ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { logger } from "../utils/logger.js";
import {
  applyInboxBatch,
  enqueueRemoteEvent,
  getSyncCursor,
  listPendingOutboxBatch,
  markOutboxAcked,
  markOutboxFailed,
  markOutboxSent,
  setSyncCursor,
  type ApplyInboxBatchInput,
  type ListPendingOutboxBatchInput,
} from "./db.js";
import { sanitizeSyncError } from "./redaction.js";
import type { SyncOutboxRecord } from "./types.js";

const log = logger.child("sync:console-bridge");
const RUNTIME_TRACE_DOMAIN = "runtime_trace";

export interface ConsoleSyncBridgeDeps {
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  createClient?: (credentials: CloudCredentials) => ConsoleApiClient;
}

export interface SyncBridgeBatchOptions {
  domain?: string;
  project?: string;
  projectRef?: string;
  projectId?: string;
  scope?: "organization";
  limit?: number;
  maxBytes?: number;
}

export interface ConsoleSyncPushResult {
  linked: boolean;
  status: "unlinked" | "noop" | "uploaded" | "failed";
  attempted: number;
  sent: number;
  acked: number;
  failed: number;
  errorCode?: string;
}

export interface ConsoleSyncPullResult {
  linked: boolean;
  status: "unlinked" | "noop" | "downloaded" | "failed";
  downloaded: number;
  enqueued: number;
  applied: number;
  skipped: number;
  failed: number;
  cursor: string | null;
  errorCode?: string;
}

interface RemoteSyncEvent {
  remoteSequence?: string | number | null;
  sequence?: string | number | null;
  remoteEventId?: string | null;
  eventId?: string | null;
  id?: string | null;
  domain?: string | null;
  eventType?: string | null;
  type?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  payload?: unknown;
}

interface ConsoleSyncUploadResponse {
  version?: number;
  accepted?: number;
  duplicates?: number;
  events?: Array<{
    eventId?: string | null;
    accepted?: boolean | null;
    duplicate?: boolean | null;
    sequence?: string | number | null;
  }>;
}

export class ConsoleSyncBridge {
  private readCredentials: typeof readCloudCredentials;
  private writeCredentials: typeof writeCloudCredentials;
  private deleteCredentials: typeof deleteCloudCredentials;
  private createClient: (credentials: CloudCredentials) => ConsoleApiClient;

  constructor(deps: ConsoleSyncBridgeDeps = {}) {
    this.readCredentials = deps.readCredentials ?? readCloudCredentials;
    this.writeCredentials = deps.writeCredentials ?? writeCloudCredentials;
    this.deleteCredentials = deps.deleteCredentials ?? deleteCloudCredentials;
    this.createClient =
      deps.createClient ?? ((credentials) => new ConsoleApiClient({ consoleUrl: credentials.consoleUrl }));
  }

  isLinked(): boolean {
    return !!this.readCredentials();
  }

  async push(options: SyncBridgeBatchOptions = {}): Promise<ConsoleSyncPushResult> {
    const ctx = this.getAuthContext();
    if (!ctx) return { linked: false, status: "unlinked", attempted: 0, sent: 0, acked: 0, failed: 0 };

    const batch = listPendingOutboxBatch({
      domain: options.domain,
      excludeDomains: [RUNTIME_TRACE_DOMAIN],
      limit: options.limit,
      maxBytes: options.maxBytes,
    } satisfies ListPendingOutboxBatchInput);
    if (batch.items.length === 0) {
      return { linked: true, status: "noop", attempted: 0, sent: 0, acked: 0, failed: 0 };
    }

    try {
      const target = resolveSyncTarget(options);
      const response = await this.requestWithRefresh<ConsoleSyncUploadResponse>(ctx, "POST", "/api/cli/sync/events", {
        installationId: ctx.credentials.installationId,
        events: batch.items.map((item) => toUploadEvent(item, target)),
      });
      const upload = interpretUploadResponse(batch.items, response);
      const sentIds = upload.ackedIds;
      const ackedIds = upload.ackedIds;
      const failedIds = upload.failedIds;
      markOutboxSent(sentIds);
      if (ackedIds.length > 0) markOutboxAcked(ackedIds);
      if (failedIds.length > 0) {
        markOutboxFailed({
          ids: failedIds,
          errorCode: "SYNC_EVENT_REJECTED",
          retryable: false,
        });
      }
      if (upload.cursor) setSyncCursor("sync", "last_upload", upload.cursor, target);
      return {
        linked: true,
        status: "uploaded",
        attempted: batch.items.length,
        sent: sentIds.length,
        acked: ackedIds.length,
        failed: failedIds.length,
      };
    } catch (error) {
      const code = bridgeErrorCode(error);
      const retryable = isRetryableBridgeError(error);
      markOutboxFailed({
        ids: batch.items.map((item) => item.id),
        errorCode: code,
        retryable,
      });
      log.warn("Console sync push failed", { code });
      return {
        linked: true,
        status: "failed",
        attempted: batch.items.length,
        sent: 0,
        acked: 0,
        failed: batch.items.length,
        errorCode: code,
      };
    }
  }

  async pull(options: SyncBridgeBatchOptions & ApplyInboxBatchInput = {}): Promise<ConsoleSyncPullResult> {
    const ctx = this.getAuthContext();
    if (!ctx)
      return {
        linked: false,
        status: "unlinked",
        downloaded: 0,
        enqueued: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        cursor: null,
      };

    if (!options.domain) {
      return {
        linked: true,
        status: "failed",
        downloaded: 0,
        enqueued: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        cursor: null,
        errorCode: "DOMAIN_REQUIRED",
      };
    }

    const target = resolveSyncTarget(options);
    const remoteCursorKey = cursorKey(options.domain, target);
    const cursor = getSyncCursor("sync_remote", remoteCursorKey)?.cursorValue ?? null;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    params.set("domain", options.domain);
    appendTargetParams(params, target);
    if (options.limit) params.set("limit", String(options.limit));
    const path = `/api/cli/sync/events${params.size ? `?${params.toString()}` : ""}`;

    try {
      const response = await this.requestWithRefresh<{
        events?: RemoteSyncEvent[];
        items?: RemoteSyncEvent[];
        nextCursor?: string | null;
        cursor?: string | null;
      }>(ctx, "GET", path);
      const events = response.events ?? response.items ?? [];
      for (const event of events) enqueueRemoteEvent(normalizeRemoteEvent(event));
      const apply = await applyInboxBatch({ domain: options.domain, limit: options.limit, handlers: options.handlers });
      const nextCursor = response.nextCursor ?? response.cursor ?? cursor;
      if (nextCursor !== cursor) setSyncCursor("sync_remote", remoteCursorKey, nextCursor, target);
      if (nextCursor !== cursor) {
        await this.requestWithRefresh<Record<string, unknown>>(ctx, "POST", "/api/cli/sync/ack", {
          cursor: nextCursor,
          domain: options.domain,
          ...target,
        });
      }
      return {
        linked: true,
        status: events.length > 0 ? "downloaded" : "noop",
        downloaded: events.length,
        enqueued: events.length,
        applied: apply.applied,
        skipped: apply.skipped,
        failed: apply.failed,
        cursor: nextCursor,
      };
    } catch (error) {
      const code = bridgeErrorCode(error);
      log.warn("Console sync pull failed", { code });
      return {
        linked: true,
        status: "failed",
        downloaded: 0,
        enqueued: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        cursor,
        errorCode: code,
      };
    }
  }

  async uploadRuntimeTraceEvents(payload: unknown): Promise<{ linked: boolean; status: "unlinked" | "uploaded" }> {
    const ctx = this.getAuthContext();
    if (!ctx) return { linked: false, status: "unlinked" };
    await this.requestWithRefresh<Record<string, unknown>>(ctx, "POST", "/api/cli/runtime-traces/events", payload);
    return { linked: true, status: "uploaded" };
  }

  private getAuthContext(): { credentials: CloudCredentials; client: ConsoleApiClient; accessToken: string } | null {
    const credentials = this.readCredentials();
    if (!credentials) return null;
    return {
      credentials,
      client: this.createClient(credentials),
      accessToken: credentials.accessToken,
    };
  }

  private async requestWithRefresh<T>(
    ctx: { credentials: CloudCredentials; client: ConsoleApiClient; accessToken: string },
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return await ctx.client.requestJson<T>(method, path, body, ctx.accessToken);
    } catch (error) {
      if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
      const refreshed = await refreshCredentialsForStore({
        client: ctx.client,
        credentials: ctx.credentials,
        write: this.writeCredentials,
        delete: this.deleteCredentials,
      });
      ctx.credentials = refreshed;
      ctx.accessToken = refreshed.accessToken;
      return ctx.client.requestJson<T>(method, path, body, refreshed.accessToken);
    }
  }
}

export function createConsoleSyncBridge(deps?: ConsoleSyncBridgeDeps): ConsoleSyncBridge {
  return new ConsoleSyncBridge(deps);
}

interface SyncTarget {
  projectRef?: string;
  projectId?: string;
  scope?: "organization";
}

function toUploadEvent(record: SyncOutboxRecord, target: SyncTarget) {
  return {
    id: record.id,
    eventId: record.eventId,
    originInstallationId: record.originInstallationId,
    domain: record.domain,
    eventType: record.eventType,
    entityType: record.entityType,
    entityId: record.entityId,
    entityRevision: record.entityRevision,
    idempotencyKey: record.idempotencyKey,
    occurredAt: new Date(record.occurredAt).toISOString(),
    payload: record.payload,
    evidenceRefs: record.evidenceRefs,
    schemaVersion: record.schemaVersion,
    ...target,
  };
}

function interpretUploadResponse(
  items: SyncOutboxRecord[],
  response: ConsoleSyncUploadResponse,
): { ackedIds: string[]; failedIds: string[]; cursor: string | null } {
  if (!Array.isArray(response.events)) {
    return {
      ackedIds: [],
      failedIds: items.map((item) => item.id),
      cursor: null,
    };
  }

  const byEventId = new Map(response.events.filter((event) => event.eventId).map((event) => [event.eventId!, event]));
  const ackedIds: string[] = [];
  const failedIds: string[] = [];
  let cursor: string | null = null;

  for (const item of items) {
    const event = byEventId.get(item.eventId);
    if (event?.accepted === true || event?.duplicate === true) {
      ackedIds.push(item.id);
      if (event.sequence !== undefined && event.sequence !== null) cursor = String(event.sequence);
      continue;
    }
    failedIds.push(item.id);
  }

  return { ackedIds, failedIds, cursor };
}

function normalizeRemoteEvent(event: RemoteSyncEvent) {
  const remoteEventId = event.remoteEventId ?? event.eventId ?? event.id;
  if (!remoteEventId) throw new CloudAuthError("PAYLOAD_INVALID", "Remote sync event is missing event id.");
  const domain = event.domain ?? "unknown";
  const eventType = event.eventType ?? event.type;
  if (!eventType) throw new CloudAuthError("PAYLOAD_INVALID", "Remote sync event is missing event type.");
  return {
    remoteSequence: event.remoteSequence ?? event.sequence ?? null,
    remoteEventId,
    domain,
    eventType,
    entityType: event.entityType ?? "unknown",
    entityId: event.entityId ?? remoteEventId,
    payload: event.payload ?? {},
  };
}

function resolveSyncTarget(options: SyncBridgeBatchOptions): SyncTarget {
  const projectRef = options.projectRef ?? options.project;
  if (projectRef) return { projectRef };
  if (options.projectId) return { projectId: options.projectId };
  return { scope: options.scope ?? "organization" };
}

function appendTargetParams(params: URLSearchParams, target: SyncTarget): void {
  if (target.projectRef) params.set("projectRef", target.projectRef);
  else if (target.projectId) params.set("projectId", target.projectId);
  else params.set("scope", target.scope ?? "organization");
}

function cursorKey(domain: string | undefined, target: SyncTarget): string {
  const scope = target.projectRef
    ? `projectRef:${target.projectRef}`
    : target.projectId
      ? `projectId:${target.projectId}`
      : "organization";
  return [scope, domain ?? "all"].join(":");
}

function bridgeErrorCode(error: unknown): string {
  if (isCloudAuthError(error)) return error.code;
  return (
    sanitizeSyncError(error)
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .slice(0, 80) || "SYNC_FAILED"
  );
}

function isRetryableBridgeError(error: unknown): boolean {
  if (!isCloudAuthError(error)) return true;
  return error.code === "RATE_LIMITED" || error.code === "SERVER_UNAVAILABLE" || error.code === "AUTH_PENDING";
}
