/**
 * Daemon runner for `ravi link`.
 *
 * - Polls the Console for the link requests this install is waiting on. On
 *   approval it caches the binding (ids only) and confirms in the private
 *   chat and in the chat where the person asked; on denial or expiry it tells
 *   the person in the private chat.
 * - Every few minutes it re-checks cached bindings against the Console, so a
 *   revoke on the Console reaches this install without waiting for the cache
 *   to expire, and a live binding does not silently drop after the cache TTL.
 *
 * Several daemons may share one database: each transition is claimed with a
 * conditional update, so every confirmation is sent once.
 */

import {
  deleteCachedActorBinding,
  listCachedActorBindings,
  readCachedActorBinding,
  writeCachedActorBinding,
} from "../cloud-auth/actor-bindings.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import type { ActorBinding } from "../cloud-auth/types.js";
import { logger } from "../utils/logger.js";
import {
  createChannelLinkMessenger,
  linkApprovedDmText,
  linkApprovedOriginText,
  linkDeniedDmText,
  linkExpiredDmText,
  type LinkChatTarget,
  type LinkMessenger,
} from "./link-dm.js";
import {
  completeLocalLinkRequest,
  listPendingLocalLinkRequests,
  pruneLocalLinkRequests,
  type LocalLinkRequest,
} from "./link-requests-db.js";
import { withCloudSession, type IdentityLinkDeps } from "./link-service.js";

const log = logger.child("identity:link-watcher");

const ACTIVE_INTERVAL_MS = 3_000;
const IDLE_INTERVAL_MS = 15_000;
const REVALIDATE_INTERVAL_MS = 10 * 60_000;
/** A request still pending this long after it expired is given up locally. */
const ABANDON_AFTER_EXPIRY_MS = 60 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export type LinkWatcherDeps = IdentityLinkDeps;

/** Check every pending request once. Returns how many are still pending. */
export async function processPendingLinkRequests(deps: LinkWatcherDeps = {}): Promise<number> {
  const pending = listPendingLocalLinkRequests();
  if (pending.length === 0) return 0;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const messenger = deps.messenger ?? createChannelLinkMessenger();

  try {
    await withCloudSession(deps, async (client, credentials) => {
      for (const request of pending) {
        if (request.consoleUrl !== credentials.consoleUrl || request.installationId !== credentials.installationId) {
          // Created under another Console session; it cannot be polled from this one.
          abandonIfStale(request, now());
          continue;
        }

        let status;
        try {
          status = await client.getLinkRequest(request.id, credentials.accessToken);
        } catch (error) {
          if (isCloudAuthError(error) && error.code === "NOT_FOUND") {
            completeLocalLinkRequest(request.id, "failed", now());
            continue;
          }
          if (isCloudAuthError(error) && error.code === "AUTH_EXPIRED") throw error;
          log.warn("Link request poll failed", { requestId: request.id, error: errorText(error) });
          continue;
        }

        switch (status.request.status) {
          case "pending":
            break;
          case "approved": {
            if (!status.binding) {
              // The Console omits the binding only once it is no longer active
              // (revoked right after approval), so there is nothing to confirm.
              log.warn("Approved link request has no active binding", { requestId: request.id });
              completeLocalLinkRequest(request.id, "approved", now());
              break;
            }
            // Claim the request before caching: an unlink that cancelled it while
            // this poll was in flight must not see the binding come back.
            if (completeLocalLinkRequest(request.id, "approved", now())) {
              writeCachedActorBinding(status.binding, env);
              await confirmApproved(messenger, request);
            }
            break;
          }
          case "denied":
            if (completeLocalLinkRequest(request.id, "denied", now())) {
              await notify(messenger, request.dm, linkDeniedDmText(), request.id);
            }
            break;
          case "expired":
            if (completeLocalLinkRequest(request.id, "expired", now())) {
              await notify(messenger, request.dm, linkExpiredDmText(), request.id);
            }
            break;
          case "cancelled":
            completeLocalLinkRequest(request.id, "cancelled", now());
            break;
        }
      }
    });
  } catch (error) {
    log.debug("Link request poll skipped", { error: errorText(error) });
    for (const request of pending) abandonIfStale(request, now());
  }

  return listPendingLocalLinkRequests().length;
}

function isSameBinding(current: ActorBinding | null, expected: ActorBinding): boolean {
  return (
    current !== null &&
    current.id === expected.id &&
    current.consoleUserId === expected.consoleUserId &&
    current.installationId === expected.installationId
  );
}

/**
 * Re-check cached bindings of the active installation against the Console.
 * A binding the Console no longer reports is removed; a live one gets a fresh
 * cache TTL. Bindings of other installations are left to expire.
 */
export async function revalidateCachedBindings(deps: LinkWatcherDeps = {}): Promise<{ kept: number; removed: number }> {
  const env = deps.env ?? process.env;
  const cached = listCachedActorBindings(env);
  const result = { kept: 0, removed: 0 };
  if (cached.length === 0) return result;

  try {
    await withCloudSession(deps, async (client, credentials) => {
      for (const binding of cached) {
        if (binding.installationId !== credentials.installationId) continue;
        try {
          const current = await client.resolveActorBinding({ contactId: binding.contactId }, credentials.accessToken);
          // An unlink or a new link may have changed the entry while this call was in flight.
          if (!isSameBinding(readCachedActorBinding(binding.contactId, env), binding)) continue;
          if (current && current.consoleUserId === binding.consoleUserId) {
            writeCachedActorBinding(current, env);
            result.kept += 1;
          } else {
            deleteCachedActorBinding(binding.contactId, env);
            result.removed += 1;
          }
        } catch (error) {
          if (isCloudAuthError(error) && error.code === "AUTH_EXPIRED") throw error;
          log.warn("Cached binding check failed", { error: errorText(error) });
        }
      }
    });
  } catch (error) {
    log.debug("Cached binding check skipped", { error: errorText(error) });
  }
  return result;
}

async function confirmApproved(messenger: LinkMessenger, request: LocalLinkRequest): Promise<void> {
  await notify(messenger, request.dm, linkApprovedDmText(request.consoleUrl), request.id);
  const origin = request.origin;
  if (!origin || origin.chatId === request.dm.chatId) return;
  const threadId = origin.threadId ?? (origin.channel === "slack" ? origin.sourceMessageId : undefined);
  await notify(
    messenger,
    {
      channel: origin.channel,
      accountId: origin.accountId,
      chatId: origin.chatId,
      ...(threadId ? { threadId } : {}),
    },
    linkApprovedOriginText(request.displayName),
    request.id,
  );
}

async function notify(messenger: LinkMessenger, target: LinkChatTarget, text: string, requestId: string) {
  try {
    await messenger.send(target, text);
  } catch (error) {
    log.warn("Link confirmation delivery failed", { requestId, channel: target.channel, error: errorText(error) });
  }
}

function abandonIfStale(request: LocalLinkRequest, now: number): void {
  if (request.expiresAt + ABANDON_AFTER_EXPIRY_MS < now) {
    completeLocalLinkRequest(request.id, "failed", now);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LinkRequestWatcher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRevalidateAt = 0;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly deps: LinkWatcherDeps = {}) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.schedule(ACTIVE_INTERVAL_MS);
  }

  /** Poll soon: a request was just created and the runner may be idling. */
  wake(): void {
    if (!this.running || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.schedule(ACTIVE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tickInFlight;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickInFlight = this.tick()
        .then((nextDelay) => this.schedule(nextDelay))
        .catch((error) => {
          log.error("Link watcher tick failed", { error: errorText(error) });
          this.schedule(IDLE_INTERVAL_MS);
        })
        .finally(() => {
          this.tickInFlight = null;
        });
    }, delay);
  }

  private async tick(): Promise<number> {
    const stillPending = await processPendingLinkRequests(this.deps);
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastRevalidateAt >= REVALIDATE_INTERVAL_MS) {
      this.lastRevalidateAt = now;
      await revalidateCachedBindings(this.deps);
      pruneLocalLinkRequests(now - RETENTION_MS);
    }
    return stillPending > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  }
}

let singleton: LinkRequestWatcher | null = null;

export async function startLinkRequestWatcher(): Promise<void> {
  singleton ??= new LinkRequestWatcher();
  await singleton.start();
}

export function wakeLinkRequestWatcher(): void {
  singleton?.wake();
}

export async function stopLinkRequestWatcher(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
  singleton = null;
}
