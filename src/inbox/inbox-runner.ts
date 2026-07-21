/**
 * Console agent-inbox local poller.
 *
 * Pulse-first poll loop:
 *   1. Resolve credentials with the required `console.inbox.*` scopes.
 *   2. Upsert the global subscription on Console.
 *   3. Cheap pulse with conditional headers. 304/204 -> sleep.
 *   4. On generation change, lease a batch via `/api/cli/inbox/poll`.
 *   5. Persist each item locally, publish its canonical and normalized watch
 *      subjects, flush NATS, then ack delivered. Local persistence happens
 *      before publish so a crash between publish and ack leaves the mirror.
 *   6. Apply backoff on transport/auth errors. AUTH_REQUIRED /
 *      INSTALLATION_REVOKED parks the subscription until `ravi login` runs.
 *
 * Contract reference: `.ravi/specs/cli/inbox/SPEC.md` and
 * `.ravi/specs/watch/SPEC.md`.
 */

import { randomUUID } from "node:crypto";
import { ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { RaviMailClient } from "../mail/client.js";
import {
  annotateConsoleMailPayloadWithLocalIngest,
  ingestConsoleMailReceivedEvent,
} from "../mailbox/console-ingest.js";
import { flushNats, publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import { watchEventFromInboxPayload } from "../watch/events.js";
import {
  ackInboxItems as ackInboxItemsRemote,
  fetchInboxPulse,
  pollInboxItems,
  upsertGlobalInboxSubscription,
} from "./inbox-client.js";
import {
  acquireInboxPollLock,
  countPendingItems,
  ensureSubscriptionRow,
  getItemByItemId,
  getSubscriptionByOrg,
  inboxPollLockKey,
  listSubscriptions,
  markItemAcked,
  markItemDelivered,
  markSubscriptionPolled,
  reconcileDeliveredItemsAckedThroughSequence,
  releaseInboxPollLock,
  renewInboxPollLock,
  setSubscriptionEnabled,
  updateSubscriptionRemoteId,
  upsertDeliveredItem,
} from "./inbox-db.js";
import { enrichMailMessageReceivedPayload, withMailEnrichmentFailure } from "./mail-enrichment.js";
import { INBOX_NATS_SUBJECT, type ConsoleInboxItem, type InboxNatsPayload } from "./types.js";

const log = logger.child("inbox:runner");

const REQUIRED_SCOPES = [
  "console.inbox.read",
  "console.inbox.subscribe",
  "console.inbox.deliver",
  "console.inbox.ack",
] as const;

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const ERROR_BACKOFF_INITIAL_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;
const PAUSED_RECHECK_MS = 60_000;
const POLL_BATCH_LIMIT = 25;
const MAIL_ENRICHMENT_ATTEMPTS = 5;
const MAIL_ENRICHMENT_INITIAL_DELAY_MS = 500;
const POLL_LOCK_TTL_MS = 120_000;
const POLL_LOCK_RENEW_MS = 30_000;

interface RunnerOptions {
  intervalMs?: number;
  nats?: InboxNatsPublishDependencies;
}

interface InboxNatsPublishDependencies {
  publish: (subject: string, payload: Record<string, unknown>) => Promise<void>;
  flush: () => Promise<void>;
}

class InboxPollLeaseLostError extends Error {
  constructor(message = "Inbox poll lease was lost.", options?: ErrorOptions) {
    super(message, options);
    this.name = "InboxPollLeaseLostError";
  }
}

class IncompleteInboxAckError extends Error {
  constructor(requested: number, acked: number) {
    super(`Console acknowledged ${acked} of ${requested} inbox items.`);
    this.name = "IncompleteInboxAckError";
  }
}

interface OrgState {
  localId: string;
  consoleUrl: string;
  installationId: string;
  organizationId: string;
  /** Remote subscription id from Console; null until first sync. */
  remoteId: string | null;
  lastEtag: string | null;
}

export class InboxRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private states = new Map<string, OrgState>();
  private intervalMs: number;
  private currentBackoffMs = 0;
  private readonly lockOwnerId = randomUUID();
  private readonly natsDependencies: InboxNatsPublishDependencies;
  private tickInFlight: Promise<void> | null = null;

  constructor(options: RunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.natsDependencies = options.nats ?? { publish, flush: flushNats };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting inbox runner");
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("Stopped inbox runner");
  }

  /** Foreground one-shot. Returns when a single tick completes. */
  async tickOnce(): Promise<void> {
    await this.runTick();
  }

  /** Coalesce overlapping timer/foreground calls on this runner instance. */
  private runTick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const current = (async () => {
      try {
        await this.tick();
      } finally {
        this.tickInFlight = null;
      }
    })();
    this.tickInFlight = current;
    return current;
  }

  private scheduleTick(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick().catch((err) => {
        log.error("Inbox runner tick failed", { error: errMessage(err) });
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    let nextDelay = this.intervalMs;
    let activeLockKey: string | null = null;
    let lockRenewalTimer: ReturnType<typeof setInterval> | null = null;
    let pollLockLost = false;
    let invalidateEtagOnError: OrgState | null = null;

    try {
      const credentials = readCloudCredentials();
      if (!credentials) {
        nextDelay = PAUSED_RECHECK_MS;
        return;
      }
      if (!hasInboxScopes(credentials)) {
        log.debug("Skipping inbox tick: credentials lack inbox scopes", {
          scopes: credentials.scopes,
        });
        nextDelay = PAUSED_RECHECK_MS;
        return;
      }
      const organizationId = credentials.organization?.id;
      if (!organizationId) {
        log.debug("Skipping inbox tick: credentials missing organization id");
        nextDelay = PAUSED_RECHECK_MS;
        return;
      }

      const row = ensureSubscriptionRow({
        consoleUrl: credentials.consoleUrl,
        organizationId,
        installationId: credentials.installationId,
      });
      if (!row.enabled) {
        nextDelay = PAUSED_RECHECK_MS;
        return;
      }

      activeLockKey = inboxPollLockKey(row.consoleUrl, row.organizationId);
      if (
        !acquireInboxPollLock({
          lockKey: activeLockKey,
          ownerId: this.lockOwnerId,
          ttlMs: POLL_LOCK_TTL_MS,
        })
      ) {
        log.debug("Skipping inbox tick: another process owns the poll lease", {
          consoleUrl: row.consoleUrl,
          organizationId: row.organizationId,
        });
        activeLockKey = null;
        return;
      }

      const requirePollLock = (): void => {
        if (pollLockLost || !activeLockKey) {
          throw new InboxPollLeaseLostError();
        }
        try {
          if (
            !renewInboxPollLock({
              lockKey: activeLockKey,
              ownerId: this.lockOwnerId,
              ttlMs: POLL_LOCK_TTL_MS,
            })
          ) {
            pollLockLost = true;
            throw new InboxPollLeaseLostError();
          }
        } catch (error) {
          pollLockLost = true;
          if (error instanceof InboxPollLeaseLostError) throw error;
          throw new InboxPollLeaseLostError("Inbox poll lease renewal failed.", { cause: error });
        }
      };
      lockRenewalTimer = setInterval(() => {
        if (pollLockLost || !activeLockKey) return;
        try {
          if (
            !renewInboxPollLock({
              lockKey: activeLockKey,
              ownerId: this.lockOwnerId,
              ttlMs: POLL_LOCK_TTL_MS,
            })
          ) {
            pollLockLost = true;
          }
        } catch (error) {
          pollLockLost = true;
          log.warn("Inbox poll lease renewal errored", {
            consoleUrl: row.consoleUrl,
            organizationId: row.organizationId,
            error: errMessage(error),
          });
        }
        if (pollLockLost) {
          log.warn("Inbox poll lease renewal failed", {
            consoleUrl: row.consoleUrl,
            organizationId: row.organizationId,
          });
        }
      }, POLL_LOCK_RENEW_MS);
      lockRenewalTimer.unref?.();

      const state =
        this.states.get(row.id) ??
        ({
          localId: row.id,
          consoleUrl: row.consoleUrl,
          installationId: row.installationId,
          organizationId: row.organizationId,
          remoteId: row.subscriptionId,
          lastEtag: null,
        } satisfies OrgState);
      // ensureSubscriptionRow already cleared subscription_id on rotation;
      // mirror that in the in-memory state so we re-upsert the remote sub.
      if (state.installationId !== row.installationId) {
        state.installationId = row.installationId;
        state.remoteId = row.subscriptionId;
        state.lastEtag = null;
      }
      this.states.set(row.id, state);

      const client = new ConsoleApiClient({ consoleUrl: row.consoleUrl });
      let effectiveLastSequence = row.lastSequence ?? 0;

      const adoptRemoteSubscription = (
        subscriptionId: string | null,
        options: { resetCursor: boolean; resetEtag: boolean },
      ): void => {
        requirePollLock();
        state.remoteId = subscriptionId;
        if (options.resetEtag) state.lastEtag = null;
        updateSubscriptionRemoteId(row.id, subscriptionId, {
          resetCursor: options.resetCursor,
        });
        if (options.resetCursor) effectiveLastSequence = 0;
      };

      if (!state.remoteId) {
        const { subscription } = await this.withAutoRefresh(client, credentials, (token) =>
          upsertGlobalInboxSubscription(client, token, {
            installationName: credentials.installationId,
          }),
        );
        adoptRemoteSubscription(subscription?.id ?? null, {
          resetCursor: false,
          resetEtag: false,
        });
      }

      const pulse = await this.withAutoRefresh(client, credentials, (token) =>
        fetchInboxPulse(client, token, {
          generation: row.lastGeneration,
          lastDeliveredSequence: row.lastSequence,
          etag: state.lastEtag,
        }),
      );

      // Once a fresh pulse has returned, every downstream failure must force a
      // fresh pulse on the next tick. Keeping its ETag after an incomplete
      // poll/publish/ack cycle can turn the retry into an endless 304 loop.
      if (pulse.pulse) invalidateEtagOnError = state;
      requirePollLock();
      if (pulse.pulse) {
        state.lastEtag = pulse.etag;
      } else if (pulse.etag) {
        state.lastEtag = pulse.etag;
      }

      if (pulse.status === 304 || pulse.status === 204) {
        markSubscriptionPolled(row.id, { success: true, status: "active" });
        this.currentBackoffMs = 0;
        return;
      }

      const payload = pulse.pulse;
      if (!payload) {
        markSubscriptionPolled(row.id, { success: true, status: "active" });
        this.currentBackoffMs = 0;
        return;
      }

      const generation = payload.watermark.generation;
      let activeSubscription = payload.subscription;

      if (state.remoteId && !activeSubscription) {
        log.info("Inbox remote subscription missing; recreating global subscription", {
          consoleUrl: row.consoleUrl,
          previousSubscriptionId: state.remoteId,
        });
        const { subscription } = await this.withAutoRefresh(client, credentials, (token) =>
          upsertGlobalInboxSubscription(client, token, {
            installationName: credentials.installationId,
          }),
        );
        activeSubscription = subscription ?? null;
        adoptRemoteSubscription(activeSubscription?.id ?? null, {
          resetCursor: true,
          resetEtag: true,
        });
      }

      if (!state.remoteId && activeSubscription?.id) {
        adoptRemoteSubscription(activeSubscription.id, {
          resetCursor: false,
          resetEtag: false,
        });
      } else if (state.remoteId && activeSubscription?.id && activeSubscription.id !== state.remoteId) {
        // Server returned a different active subscription than the one
        // we have locally. Happens after a CLI re-login that rotated the
        // installation; the previous subscription is pinned to the old
        // installation. Adopt the new id and reset cursor + etag.
        log.info("Inbox subscription drift detected", {
          consoleUrl: row.consoleUrl,
          previousSubscriptionId: state.remoteId,
          nextSubscriptionId: activeSubscription.id,
        });
        adoptRemoteSubscription(activeSubscription.id, {
          resetCursor: true,
          resetEtag: true,
        });
      }

      const subscriptionCursor = activeSubscription?.lastDeliveredSequence ?? null;
      const hasPendingRemoteItems =
        subscriptionCursor !== null && subscriptionCursor < payload.watermark.latestSequence;

      // Adopt cursor when Console reports we are ahead of our local record.
      const remoteCursorIsAhead = subscriptionCursor !== null && subscriptionCursor > effectiveLastSequence;
      const cursorUpdate = remoteCursorIsAhead ? { lastSequence: subscriptionCursor } : {};
      if (subscriptionCursor !== null) {
        requirePollLock();
        const reconciled = reconcileDeliveredItemsAckedThroughSequence({
          consoleUrl: row.consoleUrl,
          organizationId: row.organizationId,
          sequence: subscriptionCursor,
        });
        if (reconciled > 0) {
          log.info("Reconciled locally delivered inbox items from Console cursor", {
            consoleUrl: row.consoleUrl,
            organizationId: row.organizationId,
            subscriptionCursor,
            reconciled,
          });
        }
      }

      if (!payload.changed && !hasPendingRemoteItems) {
        // Caught up: it's safe to mark generation locally because there
        // is nothing pending to deliver.
        markSubscriptionPolled(row.id, {
          generation,
          success: true,
          status: "active",
          ...cursorUpdate,
        });
        this.currentBackoffMs = 0;
        return;
      }

      // Server reported pending items. Save cursor progress now, but defer
      // the generation bump until the poll+publish+ack cycle has succeeded.
      // Otherwise a silent failure here would leave the daemon with
      // last_generation matching server, locking pulse into 304 forever.
      markSubscriptionPolled(row.id, {
        success: true,
        status: "active",
        ...cursorUpdate,
      });

      const poll = await this.withAutoRefresh(client, credentials, (token) =>
        pollInboxItems(client, token, {
          limit: POLL_BATCH_LIMIT,
          subscriptionId: state.remoteId,
        }),
      );
      requirePollLock();

      const acks: Array<{
        itemId: string;
        status: "delivered";
        leaseId?: string;
      }> = [];
      const baseSequence = subscriptionCursor ?? effectiveLastSequence;
      const deliveryResults: Array<{ sequence: number; delivered: boolean }> = [];

      for (const item of poll.items) {
        requirePollLock();
        const handled = await this.handleItem({
          consoleUrl: row.consoleUrl,
          organizationId: row.organizationId,
          installationId: row.installationId,
          remoteSubscriptionId: state.remoteId ?? poll.subscription.id,
          item,
          pollId: poll.pollId,
          client,
          credentials,
          assertPollLock: requirePollLock,
        });
        if (handled.delivered) {
          acks.push({
            itemId: item.itemId,
            status: "delivered",
            ...(item.lease?.id ? { leaseId: item.lease.id } : {}),
          });
        }
        deliveryResults.push({ sequence: item.sequence, delivered: handled.delivered });
      }

      // An empty poll does not mean completion when the pulse still reports a
      // remote cursor behind the watermark (for example, another lease has not
      // expired yet). Keep generation/ETag retryable in that case.
      let remoteAckSucceeded = poll.items.length === 0 && !hasPendingRemoteItems;
      if (acks.length > 0) {
        try {
          requirePollLock();
          const ackResult = await this.withAutoRefresh(client, credentials, (token) =>
            ackInboxItemsRemote(client, token, {
              acks,
              subscriptionId: state.remoteId,
            }),
          );
          if (!isCompleteInboxAck(ackResult, acks.length)) {
            throw new IncompleteInboxAckError(acks.length, ackResult.acked);
          }
          // Do not commit local ack/cursor state after another owner has taken over.
          requirePollLock();
          const ackedAt = Date.now();
          for (const ack of acks) {
            const localItem = getItemByItemId(row.consoleUrl, row.organizationId, ack.itemId);
            if (localItem) markItemAcked(localItem.id, ackedAt);
          }
          remoteAckSucceeded = true;
        } catch (error) {
          if (error instanceof InboxPollLeaseLostError) throw error;
          log.warn("Inbox ack failed; will retry on next tick", { error: errMessage(error) });
        }
      }

      const deliveryProgress = computeInboxDeliveryProgress(baseSequence, deliveryResults, remoteAckSucceeded);
      requirePollLock();
      const lastSequence = Math.max(deliveryProgress.lastSequence, effectiveLastSequence);
      const needsContinuation = poll.hasMore || lastSequence < payload.watermark.latestSequence;
      const deliveryIncomplete = deliveryProgress.hadDeliveryFailure || needsContinuation;
      if (deliveryIncomplete) {
        state.lastEtag = null;
      }
      markSubscriptionPolled(row.id, {
        ...(deliveryIncomplete ? {} : { generation }),
        lastSequence,
        success: true,
        status: "active",
      });

      this.currentBackoffMs = 0;
      // `hasMore` guarantees another page is immediately available. A cursor
      // still behind the watermark with no page can mean another lease is
      // active, so keep it retryable without a zero-delay Console hot loop.
      if (poll.hasMore) {
        nextDelay = 0;
      }
    } catch (error) {
      if (invalidateEtagOnError) invalidateEtagOnError.lastEtag = null;
      if (error instanceof InboxPollLeaseLostError) {
        log.warn("Inbox poll lease lost; another runner may continue delivery", { error: error.message });
        nextDelay = this.intervalMs;
      } else {
        nextDelay = this.handleError(error);
      }
    } finally {
      if (lockRenewalTimer) clearInterval(lockRenewalTimer);
      try {
        if (activeLockKey) releaseInboxPollLock(activeLockKey, this.lockOwnerId);
      } catch (error) {
        log.warn("Inbox poll lease release failed", { error: errMessage(error) });
      } finally {
        if (this.running) this.scheduleTick(nextDelay);
      }
    }
  }

  private async handleItem(input: {
    consoleUrl: string;
    organizationId: string;
    installationId: string;
    remoteSubscriptionId: string;
    item: ConsoleInboxItem;
    pollId: string;
    client: ConsoleApiClient;
    credentials: CloudCredentials;
    assertPollLock: () => void;
  }): Promise<{ delivered: boolean }> {
    input.assertPollLock();
    const alreadyDelivered = getItemByItemId(input.consoleUrl, input.organizationId, input.item.itemId);
    if (alreadyDelivered && alreadyDelivered.deliveredAt !== null) {
      // Console is retrying only the ack. Preserve and reuse the exact durable
      // envelope already flushed locally; enrichment and ingestion can have
      // side effects and must not run again for an ack-only retry.
      log.debug("Retrying only the Console ack for an already-delivered inbox item", {
        itemId: input.item.itemId,
        sequence: input.item.sequence,
      });
      return { delivered: true };
    }

    const localDeliveredAt = new Date().toISOString();
    const natsPayload: InboxNatsPayload = {
      version: 1,
      eventId: input.item.itemId,
      sequence: input.item.sequence,
      dedupeKey: input.item.dedupeKey,
      eventType: input.item.eventType,
      category: input.item.category,
      severity: input.item.severity,
      sensitivity: input.item.sensitivity,
      title: input.item.title,
      summary: input.item.summary,
      organization: input.item.organization,
      project: input.item.project,
      source: input.item.source,
      actor: input.item.actor,
      target: input.item.target,
      payload: input.item.payload,
      links: input.item.links,
      delivery: {
        subscriptionId: input.remoteSubscriptionId,
        installationId: input.installationId,
        pollId: input.pollId,
        leaseId: input.item.lease?.id ?? null,
        localDeliveredAt,
      },
      occurredAt: input.item.occurredAt,
      createdAt: input.item.createdAt,
    };

    const enrichedNatsPayload = await this.enrichLocalPayload(input, natsPayload);
    input.assertPollLock();

    // 1. Persist locally before publish so a crash leaves a durable replay row.
    const { row: localItem, created } = upsertDeliveredItem({
      consoleUrl: input.consoleUrl,
      organizationId: input.organizationId,
      subscriptionId: input.remoteSubscriptionId,
      itemId: input.item.itemId,
      sequence: input.item.sequence,
      eventType: input.item.eventType,
      category: input.item.category,
      severity: input.item.severity,
      dedupeKey: input.item.dedupeKey,
      natsSubject: INBOX_NATS_SUBJECT,
      natsPayloadJson: JSON.stringify(enrichedNatsPayload),
      deliveredAt: null,
    });

    // Guard against re-publish when Console retries delivery of an item we
    // already published locally (e.g. ack landed but server cycled the
    // lease, or the daemon restarted between publish and ack). The
    // durable mirror remembers `delivered_at`; if it's set, we already
    // emitted to NATS and should only re-ack server-side.
    if (!created && localItem.deliveredAt) {
      log.debug("Skipping duplicate NATS publish for already-delivered inbox item", {
        itemId: input.item.itemId,
        sequence: input.item.sequence,
      });
      return { delivered: true };
    }

    // 2. Publish every local subject and wait for server confirmation.
    try {
      await publishInboxNatsEvents(
        {
          payload: enrichedNatsPayload,
          inboxItemId: localItem.id,
          beforePublish: input.assertPollLock,
        },
        this.natsDependencies,
      );
    } catch (error) {
      if (error instanceof InboxPollLeaseLostError) throw error;
      log.error("Failed to publish inbox event to NATS", {
        itemId: input.item.itemId,
        error: errMessage(error),
      });
      return { delivered: false };
    }

    // 3. Mark delivered locally so we can ack to Console.
    input.assertPollLock();
    markItemDelivered(localItem.id, Date.now());
    return { delivered: true };
  }

  private async enrichLocalPayload(
    input: {
      item: ConsoleInboxItem;
      client: ConsoleApiClient;
      credentials: CloudCredentials;
    },
    natsPayload: InboxNatsPayload,
  ): Promise<InboxNatsPayload> {
    if (input.item.eventType !== "mail.message.received") return natsPayload;
    const mailClient = new RaviMailClient(input.client);
    let lastError: unknown = null;
    let enrichedPayload: InboxNatsPayload | null = null;
    for (let attempt = 1; attempt <= MAIL_ENRICHMENT_ATTEMPTS; attempt += 1) {
      try {
        enrichedPayload = await enrichMailMessageReceivedPayload(
          natsPayload,
          (messageId, payloadKind) =>
            this.withAutoRefresh(input.client, input.credentials, (token) =>
              mailClient.readMessage(token, messageId, { payloadKind }),
            ),
          (messageId) =>
            this.withAutoRefresh(input.client, input.credentials, (token) =>
              mailClient.listMessageAttachments(token, messageId),
            ),
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAIL_ENRICHMENT_ATTEMPTS) {
          await sleep(MAIL_ENRICHMENT_INITIAL_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }

    if (enrichedPayload) {
      return this.ingestLocalMailPayload(enrichedPayload);
    }

    log.warn("Mail inbox payload enrichment failed; publishing metadata-only payload", {
      itemId: input.item.itemId,
      attempts: MAIL_ENRICHMENT_ATTEMPTS,
      error: errMessage(lastError),
    });
    return this.ingestLocalMailPayload(withMailEnrichmentFailure(natsPayload, "mail_read_failed"));
  }

  private ingestLocalMailPayload(natsPayload: InboxNatsPayload): InboxNatsPayload {
    const ingest = ingestConsoleMailReceivedEvent(natsPayload);
    if (ingest.status === "skipped") {
      log.warn("Mail inbox payload was not ingested into local mailbox", {
        itemId: natsPayload.eventId,
        reason: ingest.reason,
      });
    }
    return annotateConsoleMailPayloadWithLocalIngest(natsPayload, ingest);
  }

  private async withAutoRefresh<T>(
    client: ConsoleApiClient,
    credentials: CloudCredentials,
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(credentials.accessToken);
    } catch (error) {
      if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
    }

    const refreshed = await refreshCredentialsForStore({
      client,
      credentials,
      write: writeCloudCredentials,
      delete: deleteCloudCredentials,
    });
    Object.assign(credentials, refreshed);
    return call(refreshed.accessToken);
  }

  private handleError(error: unknown): number {
    if (isCloudAuthError(error)) {
      if (
        error.code === "AUTH_REQUIRED" ||
        error.code === "INSTALLATION_REVOKED" ||
        error.code === "CREDENTIALS_INVALID"
      ) {
        log.warn("Inbox runner paused (auth required)", { code: error.code });
        for (const sub of listSubscriptions()) {
          markSubscriptionPolled(sub.id, {
            errorCode: error.code,
            status: "paused",
          });
        }
        return PAUSED_RECHECK_MS;
      }
      log.warn("Inbox runner error", { code: error.code, message: error.message });
    } else {
      log.warn("Inbox runner transport error", { error: errMessage(error) });
    }

    const code = isCloudAuthError(error) ? error.code : "TRANSPORT_ERROR";
    for (const sub of listSubscriptions()) {
      markSubscriptionPolled(sub.id, { errorCode: code, status: "errored" });
    }

    this.currentBackoffMs =
      this.currentBackoffMs === 0
        ? ERROR_BACKOFF_INITIAL_MS
        : Math.min(this.currentBackoffMs * 2, ERROR_BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * (this.currentBackoffMs * 0.2));
    return this.currentBackoffMs + jitter;
  }
}

function hasInboxScopes(credentials: CloudCredentials): boolean {
  const scopes = new Set(credentials.scopes ?? []);
  for (const required of REQUIRED_SCOPES) {
    if (!scopes.has(required)) return false;
  }
  return true;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function computeInboxDeliveryProgress(
  baseSequence: number,
  items: Array<{ sequence: number; delivered: boolean }>,
  remoteAckSucceeded = true,
): { lastSequence: number; hadDeliveryFailure: boolean } {
  if (!remoteAckSucceeded) {
    return { lastSequence: baseSequence, hadDeliveryFailure: true };
  }

  let lastSequence = baseSequence;
  let blockedByFailure = false;

  const ordered = [...items].sort((left, right) => left.sequence - right.sequence);
  for (const item of ordered) {
    // A stale duplicate at or behind the authoritative cursor cannot move it.
    if (item.sequence <= lastSequence) continue;

    const isNextSequence = item.sequence === lastSequence + 1;
    if (blockedByFailure || !item.delivered || !isNextSequence) {
      blockedByFailure = true;
      continue;
    }
    lastSequence = item.sequence;
  }
  return { lastSequence, hadDeliveryFailure: blockedByFailure };
}

export function isCompleteInboxAck(result: { acked: number }, requested: number): boolean {
  return Number.isInteger(result.acked) && requested > 0 && result.acked === requested;
}

export async function publishInboxNatsEvents(
  input: {
    payload: InboxNatsPayload;
    inboxItemId?: number | string | null;
    canonicalSubject?: string;
    beforePublish?: () => void | Promise<void>;
  },
  dependencies: InboxNatsPublishDependencies = { publish, flush: flushNats },
): Promise<string[]> {
  const subjects: string[] = [];
  const canonicalSubject = input.canonicalSubject?.trim() || INBOX_NATS_SUBJECT;

  await input.beforePublish?.();
  await dependencies.publish(canonicalSubject, input.payload as unknown as Record<string, unknown>);
  subjects.push(canonicalSubject);

  const watchEvent = watchEventFromInboxPayload(input.payload, { inboxItemId: input.inboxItemId });
  if (watchEvent) {
    await input.beforePublish?.();
    await dependencies.publish(watchEvent.subject, watchEvent as unknown as Record<string, unknown>);
    subjects.push(watchEvent.subject);
  }

  await dependencies.flush();
  return subjects;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Singleton wiring
// ----------------------------------------------------------------------------

let singleton: InboxRunner | null = null;

export function getInboxRunner(): InboxRunner {
  if (!singleton) singleton = new InboxRunner();
  return singleton;
}

export async function startInboxRunner(): Promise<void> {
  await getInboxRunner().start();
}

export async function stopInboxRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}

// ----------------------------------------------------------------------------
// CLI helpers (foreground operations)
// ----------------------------------------------------------------------------

/** Toggle inbox polling for the current Console+org. */
export function setEnabledForCurrentOrg(enabled: boolean): { changed: boolean } {
  const credentials = readCloudCredentials();
  if (!credentials || !credentials.organization?.id) {
    return { changed: false };
  }
  const row = getSubscriptionByOrg(credentials.consoleUrl, credentials.organization.id);
  if (!row) {
    if (!enabled) return { changed: false };
    ensureSubscriptionRow({
      consoleUrl: credentials.consoleUrl,
      organizationId: credentials.organization.id,
      installationId: credentials.installationId,
    });
    return { changed: true };
  }
  const needsResume = enabled && (row.status !== "active" || row.lastErrorCode !== null || row.lastErrorAt !== null);
  if (row.enabled === enabled && !needsResume) return { changed: false };
  setSubscriptionEnabled(row.id, enabled);
  return { changed: true };
}

/** Snapshot used by `ravi inbox status`. */
export function getStatusSnapshot() {
  const credentials = readCloudCredentials();
  const subscriptions = listSubscriptions().map((sub) => ({
    ...sub,
    pending: countPendingItems({
      consoleUrl: sub.consoleUrl,
      organizationId: sub.organizationId,
    }),
  }));
  return {
    credentialsPresent: Boolean(credentials),
    organizationId: credentials?.organization?.id ?? null,
    consoleUrl: credentials?.consoleUrl ?? null,
    scopesPresent: credentials ? hasInboxScopes(credentials) : false,
    requiredScopes: REQUIRED_SCOPES,
    subscriptions,
  };
}

/** Run a single poll cycle inline (used by `ravi inbox poll --once`). */
export async function runSingleTick(): Promise<void> {
  const runner = new InboxRunner();
  await runner.tickOnce();
}
