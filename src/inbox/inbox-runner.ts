/**
 * Console agent-inbox local poller.
 *
 * Pulse-first poll loop:
 *   1. Resolve credentials with the required `console.inbox.*` scopes.
 *   2. Upsert the global subscription on Console.
 *   3. Cheap pulse with conditional headers. 304/204 -> sleep.
 *   4. On generation change, lease a batch via `/api/cli/inbox/poll`.
 *   5. Persist each item locally, publish `ravi.console.inbox.item` to NATS,
 *      then ack delivered. Local persistence happens before publish so a crash
 *      between publish and ack still leaves the durable mirror.
 *   6. Apply backoff on transport/auth errors. AUTH_REQUIRED /
 *      INSTALLATION_REVOKED parks the subscription until `ravi login` runs.
 *
 * Contract reference: `.ravi/specs/console/agent-inbox/local-polling/SPEC.md`
 * in the Console repo.
 */

import { ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import {
  ackInboxItems as ackInboxItemsRemote,
  fetchInboxPulse,
  pollInboxItems,
  upsertGlobalInboxSubscription,
} from "./inbox-client.js";
import {
  countPendingItems,
  ensureSubscriptionRow,
  getItemByItemId,
  getSubscriptionByOrg,
  listSubscriptions,
  markItemAcked,
  markItemDelivered,
  markSubscriptionPolled,
  setSubscriptionEnabled,
  updateSubscriptionRemoteId,
  upsertDeliveredItem,
} from "./inbox-db.js";
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

interface RunnerOptions {
  intervalMs?: number;
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

class InboxRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private states = new Map<string, OrgState>();
  private intervalMs: number;
  private currentBackoffMs = 0;

  constructor(options: RunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
    await this.tick();
  }

  private scheduleTick(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => {
        log.error("Inbox runner tick failed", { error: errMessage(err) });
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    let nextDelay = this.intervalMs;

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
      if (!row.enabled || row.status === "paused") {
        nextDelay = PAUSED_RECHECK_MS;
        return;
      }

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

      if (!state.remoteId) {
        const { subscription } = await this.withAutoRefresh(client, credentials, (token) =>
          upsertGlobalInboxSubscription(client, token, {
            installationName: credentials.installationId,
          }),
        );
        state.remoteId = subscription?.id ?? null;
        if (state.remoteId) {
          updateSubscriptionRemoteId(row.id, state.remoteId);
        }
      }

      const pulse = await this.withAutoRefresh(client, credentials, (token) =>
        fetchInboxPulse(client, token, {
          generation: row.lastGeneration,
          lastDeliveredSequence: row.lastSequence,
          etag: state.lastEtag,
        }),
      );

      if (pulse.etag) state.lastEtag = pulse.etag;

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
      const subscriptionCursor = payload.subscription?.lastDeliveredSequence ?? null;

      if (!state.remoteId && payload.subscription?.id) {
        state.remoteId = payload.subscription.id;
        updateSubscriptionRemoteId(row.id, state.remoteId);
      } else if (state.remoteId && payload.subscription?.id && payload.subscription.id !== state.remoteId) {
        // Server returned a different active subscription than the one
        // we have locally. Happens after a CLI re-login that rotated the
        // installation; the previous subscription is pinned to the old
        // installation. Adopt the new id and reset cursor + etag.
        log.info("Inbox subscription drift detected", {
          consoleUrl: row.consoleUrl,
          previousSubscriptionId: state.remoteId,
          nextSubscriptionId: payload.subscription.id,
        });
        state.remoteId = payload.subscription.id;
        state.lastEtag = null;
        updateSubscriptionRemoteId(row.id, state.remoteId);
        markSubscriptionPolled(row.id, {
          success: true,
          status: "active",
          generation: payload.watermark.generation,
        });
      }

      // Adopt cursor when Console reports we are ahead of our local record.
      const cursorUpdate =
        subscriptionCursor !== null && subscriptionCursor > (row.lastSequence ?? 0)
          ? { lastSequence: subscriptionCursor }
          : {};
      markSubscriptionPolled(row.id, {
        generation,
        success: true,
        status: "active",
        ...cursorUpdate,
      });

      if (!payload.changed) {
        this.currentBackoffMs = 0;
        return;
      }

      const poll = await this.withAutoRefresh(client, credentials, (token) =>
        pollInboxItems(client, token, {
          limit: POLL_BATCH_LIMIT,
          subscriptionId: state.remoteId,
        }),
      );

      const acks: Array<{
        itemId: string;
        status: "delivered";
        leaseId?: string;
      }> = [];
      let maxSequence = subscriptionCursor ?? row.lastSequence ?? 0;

      for (const item of poll.items) {
        const handled = await this.handleItem({
          consoleUrl: row.consoleUrl,
          organizationId: row.organizationId,
          installationId: row.installationId,
          remoteSubscriptionId: state.remoteId ?? poll.subscription.id,
          item,
          pollId: poll.pollId,
        });
        if (handled.delivered) {
          acks.push({
            itemId: item.itemId,
            status: "delivered",
            ...(item.lease?.id ? { leaseId: item.lease.id } : {}),
          });
        }
        if (item.sequence > maxSequence) maxSequence = item.sequence;
      }

      if (acks.length > 0) {
        try {
          await this.withAutoRefresh(client, credentials, (token) =>
            ackInboxItemsRemote(client, token, {
              acks,
              subscriptionId: state.remoteId,
            }),
          );
          const ackedAt = Date.now();
          for (const ack of acks) {
            const localItem = getItemByItemId(row.consoleUrl, row.organizationId, ack.itemId);
            if (localItem) markItemAcked(localItem.id, ackedAt);
          }
        } catch (error) {
          log.warn("Inbox ack failed; will retry on next tick", { error: errMessage(error) });
        }
      }

      markSubscriptionPolled(row.id, {
        generation,
        lastSequence: Math.max(maxSequence, row.lastSequence ?? 0),
        success: true,
        status: "active",
      });

      this.currentBackoffMs = 0;
      if (poll.hasMore) {
        nextDelay = 0;
      }
    } catch (error) {
      nextDelay = this.handleError(error);
    } finally {
      if (this.running) this.scheduleTick(nextDelay);
    }
  }

  private async handleItem(input: {
    consoleUrl: string;
    organizationId: string;
    installationId: string;
    remoteSubscriptionId: string;
    item: ConsoleInboxItem;
    pollId: string;
  }): Promise<{ delivered: boolean }> {
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

    const natsPayloadJson = JSON.stringify(natsPayload);

    // 1. Persist locally before publish so a crash leaves a durable replay row.
    const { row: localItem } = upsertDeliveredItem({
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
      natsPayloadJson,
      deliveredAt: null,
    });

    // 2. Publish to NATS.
    try {
      await publish(INBOX_NATS_SUBJECT, natsPayload as unknown as Record<string, unknown>);
    } catch (error) {
      log.error("Failed to publish inbox event to NATS", {
        itemId: input.item.itemId,
        error: errMessage(error),
      });
      return { delivered: false };
    }

    // 3. Mark delivered locally so we can ack to Console.
    markItemDelivered(localItem.id, Date.now());
    return { delivered: true };
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
  if (row.enabled === enabled) return { changed: false };
  setSubscriptionEnabled(row.id, enabled);
  return { changed: true };
}

/** Snapshot used by `ravi inbox status`. */
export function getStatusSnapshot() {
  const credentials = readCloudCredentials();
  const subscriptions = listSubscriptions().map((sub) => ({
    ...sub,
    pending: countPendingItems(sub.id),
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
