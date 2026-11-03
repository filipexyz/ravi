/**
 * Scheduled maintenance (`scheduled()`, wrangler cron every 5 minutes).
 *
 * Each task is idempotent and independent: one failing task is logged
 * (error name only, never payloads) and the others still run.
 */

import { backfillConnectionIdentity } from "./account-identity";
import { runCalendarSync, type CalendarSyncReport } from "./calendar-sync";
import {
  retryPendingRevoke,
  revokeAndShred,
  shredAfterGivingUp,
  type LifecycleDeps,
  type RevokeOutcome,
} from "./connection-lifecycle";
import {
  completeRevocationOutbox,
  deleteExpiredTurnReads,
  expireStaleApprovals,
  expireStaleConsentRequests,
  expireStalePendingGrants,
  failRevocationOutbox,
  failStaleClaimedPendingGrants,
  findProviderConnectionById,
  insertAuditEvent,
  isLiveConnectionStatus,
  leaseDueRevocationOutbox,
  listIdentityBackfillCandidates,
  listRevokePendingConnections,
  reclassifyLegacyProjectConnections,
  recordRevocationOutboxFailure,
  type MaintenanceScope,
  type ProviderConnectionRecord,
  type RevocationOutboxRecord,
} from "./db";

export const SCHEDULED_REVOKE_RETRY_LIMIT = 25;
export const SCHEDULED_IDENTITY_BACKFILL_LIMIT = 50;
export const OUTBOX_BATCH_LIMIT = 25;
/** Failed attempts after which an outbox row's credentials are shredded anyway. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** The next attempt waits this long times the attempts so far. */
export const OUTBOX_BACKOFF_SECONDS = 5 * 60;
// Long enough that an overlapping run never takes a row being processed.
const OUTBOX_LEASE_SECONDS = 10 * 60;

export interface ScheduledDeps extends LifecycleDeps {
  scope?: MaintenanceScope;
  /** Needed to store a refreshed token; calendar sync is skipped without it. */
  dekKeyVersion?: number;
  fetchImpl?: typeof fetch;
}

export interface ScheduledReport {
  reclassified: number;
  outbox: OutboxReport;
  revokeRetries: { revoked: number; retry: number; gaveUp: number; failed: number };
  expired: { pendingGrants: number; staleClaims: number; approvals: number; consentRequests: number };
  turnReadsDeleted: number;
  identityBackfilled: number;
  calendar: CalendarSyncReport | null;
  failedTasks: string[];
}

export async function runScheduledMaintenance(deps: ScheduledDeps): Promise<ScheduledReport> {
  const scope = deps.scope ?? {};
  const report: ScheduledReport = {
    reclassified: 0,
    outbox: { processed: 0, done: 0, retry: 0, failed: 0 },
    revokeRetries: { revoked: 0, retry: 0, gaveUp: 0, failed: 0 },
    expired: { pendingGrants: 0, staleClaims: 0, approvals: 0, consentRequests: 0 },
    turnReadsDeleted: 0,
    identityBackfilled: 0,
    calendar: null,
    failedTasks: [],
  };

  await runTask(report, "reclassify_legacy_project_rows", async () => {
    report.reclassified = await reclassifyLegacyProjectConnections(deps.db, scope);
  });
  await runTask(report, "revocation_outbox", async () => {
    report.outbox = await processRevocationOutbox(deps);
  });
  await runTask(report, "retry_revoke_pending", async () => {
    const rows = await listRevokePendingConnections(deps.db, SCHEDULED_REVOKE_RETRY_LIMIT, scope);
    for (const row of rows) {
      try {
        const outcome = await retryPendingRevoke(deps, row);
        if (outcome === "revoked") report.revokeRetries.revoked += 1;
        else if (outcome === "gave_up") report.revokeRetries.gaveUp += 1;
        else report.revokeRetries.retry += 1;
      } catch (error) {
        report.revokeRetries.failed += 1;
        logTaskError("retry_revoke_pending_row", error);
      }
    }
  });
  await runTask(report, "expire_pending_grants", async () => {
    report.expired.pendingGrants = await expireStalePendingGrants(deps.db, scope);
  });
  await runTask(report, "fail_stale_claimed_grants", async () => {
    report.expired.staleClaims = await failStaleClaimedPendingGrants(deps.db, scope);
  });
  await runTask(report, "expire_approvals", async () => {
    report.expired.approvals = await expireStaleApprovals(deps.db, scope);
  });
  await runTask(report, "expire_consent_requests", async () => {
    report.expired.consentRequests = await expireStaleConsentRequests(deps.db, scope);
  });
  await runTask(report, "delete_expired_turn_reads", async () => {
    report.turnReadsDeleted = await deleteExpiredTurnReads(deps.db, scope);
  });
  await runTask(report, "identity_backfill", async () => {
    const rows = await listIdentityBackfillCandidates(deps.db, SCHEDULED_IDENTITY_BACKFILL_LIMIT, scope);
    for (const row of rows) {
      try {
        if (await backfillConnectionIdentity(deps, row)) report.identityBackfilled += 1;
      } catch (error) {
        logTaskError("identity_backfill_row", error);
      }
    }
  });

  if (deps.dekKeyVersion !== undefined) {
    const dekKeyVersion = deps.dekKeyVersion;
    await runTask(report, "calendar_sync", async () => {
      report.calendar = await runCalendarSync({ ...deps, dekKeyVersion });
    });
  }

  return report;
}

export interface OutboxReport {
  processed: number;
  done: number;
  retry: number;
  failed: number;
}

/**
 * `connector_revocation_outbox` (member removed, installation revoked,
 * organization disabled): for each due row, revoke at the provider under
 * the shared-account rule, shred the credentials and close the connection
 * as `revoked_by_operator`. A failure is retried 5 min × attempts later;
 * after `OUTBOX_MAX_ATTEMPTS` the credentials are shredded anyway and the
 * row is marked `failed`. A connection its owner reconnected since it was
 * queued is left alone (the row is `done`).
 */
export async function processRevocationOutbox(deps: ScheduledDeps): Promise<OutboxReport> {
  const report: OutboxReport = { processed: 0, done: 0, retry: 0, failed: 0 };
  const rows = await leaseDueRevocationOutbox(deps.db, {
    limit: OUTBOX_BATCH_LIMIT,
    leaseSeconds: OUTBOX_LEASE_SECONDS,
    scope: deps.scope,
  });
  for (const row of rows) {
    report.processed += 1;
    try {
      report[await processOutboxRow(deps, row)] += 1;
    } catch (error) {
      logTaskError("revocation_outbox_row", error);
    }
  }
  return report;
}

/**
 * The Console suspends a connection in the same transaction that queues
 * it, so a queued connection that is `active` again was reconnected by its
 * owner since (a removed member added back): the new grant is theirs and
 * is never revoked. Checked again on the locked row before acting.
 */
function outboxStillApplies(connection: ProviderConnectionRecord): boolean {
  return isLiveConnectionStatus(connection.status) && connection.status !== "active";
}

async function processOutboxRow(
  deps: ScheduledDeps,
  row: RevocationOutboxRecord,
): Promise<"done" | "retry" | "failed"> {
  const connection = await findProviderConnectionById(deps.db, row.providerConnectionId, row.organizationId);
  // Already disconnected (or gone), or reconnected since: nothing to revoke.
  if (!connection || !outboxStillApplies(connection)) {
    await completeRevocationOutbox(deps.db, row.id);
    return "done";
  }

  let outcome: RevokeOutcome;
  try {
    outcome = await revokeAndShred(deps, connection, {
      origin: "operator",
      requestId: null,
      actorType: "system",
      actorId: null,
      onProviderFailure: "keep",
      auditMetadata: { outboxReason: row.reason },
      onlyIf: outboxStillApplies,
    });
  } catch (error) {
    logTaskError("revocation_outbox_revoke", error);
    outcome = { kind: "provider_failed", attempts: 0, errorCode: "internal_error" };
  }
  if (outcome.kind !== "provider_failed") {
    await completeRevocationOutbox(deps.db, row.id);
    return "done";
  }

  const attempts = await recordRevocationOutboxFailure(deps.db, {
    id: row.id,
    errorCode: outcome.errorCode,
    backoffSeconds: OUTBOX_BACKOFF_SECONDS,
  });
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "system",
    actorId: null,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.revoke.provider_failed",
    requestId: null,
    metadata: { origin: "operator", outboxReason: row.reason, attempts, errorCode: outcome.errorCode },
  });
  if (attempts < OUTBOX_MAX_ATTEMPTS) return "retry";

  const shredded = await shredAfterGivingUp(deps, connection, {
    origin: "operator",
    onlyIf: outboxStillApplies,
    auditMetadata: { outboxReason: row.reason, attempts, errorCode: outcome.errorCode },
  });
  if (!shredded) {
    // Reconnected (or closed) while the provider kept failing.
    await completeRevocationOutbox(deps.db, row.id);
    return "done";
  }
  await failRevocationOutbox(deps.db, row.id);
  return "failed";
}

async function runTask(report: ScheduledReport, name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    report.failedTasks.push(name);
    logTaskError(name, error);
  }
}

function logTaskError(task: string, error: unknown): void {
  console.error("ravi-connectors scheduled task failed", {
    task,
    name: error instanceof Error ? error.name : "unknown",
    code: (error as { code?: unknown })?.code ?? null,
  });
}
