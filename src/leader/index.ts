/**
 * Distributed Leader Election via NATS JetStream KV
 *
 * Uses NATS KV store as a distributed lock for daemon coordination.
 * Only one daemon per role runs the associated work (e.g. heartbeat, cron runners).
 *
 * How it works:
 *   1. Daemon tries to `create` a KV key with its own ID (atomic — fails if key exists)
 *   2. Success → this daemon is leader, starts runners
 *   3. Failure → another daemon is leader, skips runners and watches for vacancy
 *   4. Leader renews TTL periodically (keepalive)
 *   5. If leader dies, KV entry expires → another daemon wins `create` and takes over
 *
 * TTL is configured via the KV bucket's max_age. Each renewal conditionally updates
 * the revision acquired by this daemon, so an expired leader cannot overwrite its
 * successor. The TTL is set at the bucket level.
 */

import { StringCodec, type KV } from "nats";
import { getNats } from "../nats.js";
import { logger } from "../utils/logger.js";

const log = logger.child("leader");
const sc = StringCodec();

/** KV bucket name for all leader elections */
const LEADER_BUCKET = "ravi-leader";

/** How long a leader lease lasts (seconds). If not renewed, another daemon takes over. */
const LEASE_TTL_S = 30;

/** How often the leader renews its lease. Must be < LEASE_TTL_S. */
const RENEWAL_INTERVAL_MS = 10_000; // 10s

let kv: KV | null = null;

interface OwnedLeadershipLease {
  readonly role: string;
  onLeadershipLost: LeadershipLostHandler | undefined;
  revision: number;
  renewalTimer: ReturnType<typeof setInterval> | null;
  renewalInFlight: Promise<void> | null;
  releaseInFlight: Promise<void> | null;
  releasing: boolean;
  lost: boolean;
}

let ownedLease: OwnedLeadershipLease | null = null;

export type LeadershipLostHandler = (error: unknown) => void | Promise<void>;

/** Unique ID for this daemon instance */
export const daemonId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Ensure the NATS KV bucket for leader elections exists.
 * Called once during daemon startup.
 */
async function ensureLeaderBucket(): Promise<KV> {
  if (kv) return kv;

  const nc = getNats();
  const js = nc.jetstream();

  try {
    // Try to bind to existing bucket
    kv = await js.views.kv(LEADER_BUCKET, {
      ttl: LEASE_TTL_S * 1000, // ms
    });
  } catch {
    // Create bucket with TTL
    kv = await js.views.kv(LEADER_BUCKET, {
      ttl: LEASE_TTL_S * 1000,
      history: 1,
    });
  }

  return kv;
}

/**
 * Try to acquire leadership for a role.
 *
 * Returns true if this daemon is now leader.
 * Returns false if another daemon already holds the lease.
 */
export async function tryAcquireLeadership(role: string): Promise<boolean> {
  const store = await ensureLeaderBucket();

  try {
    // `create` is atomic — succeeds only if key doesn't exist
    const revision = await store.create(role, sc.encode(daemonId));
    ownedLease = {
      role,
      onLeadershipLost: undefined,
      revision,
      renewalTimer: null,
      renewalInFlight: null,
      releaseInFlight: null,
      releasing: false,
      lost: false,
    };
    log.info("Acquired leadership", { role, daemonId });
    return true;
  } catch {
    // Key exists — another daemon is leader
    const entry = await store.get(role).catch(() => null);
    const currentLeader = entry ? sc.decode(entry.value) : "unknown";
    log.info("Leadership already held", { role, currentLeader, daemonId });
    return false;
  }
}

/**
 * Start renewing leadership for a role every RENEWAL_INTERVAL_MS.
 * Call this after successfully acquiring leadership.
 *
 * The renewal uses a revision-conditional update. Any ambiguous failure forfeits
 * the local lease because retrying could overwrite a successor after TTL expiry.
 */
export function startLeadershipRenewal(role: string, onLeadershipLost?: LeadershipLostHandler): void {
  const lease = ownedLease;
  if (!lease || lease.role !== role || lease.lost || lease.releasing) {
    log.warn("Cannot renew leadership without an owned lease", { role, daemonId });
    return;
  }
  if (lease.renewalTimer) return;
  lease.onLeadershipLost = onLeadershipLost;

  lease.renewalTimer = setInterval(() => {
    if (ownedLease !== lease || lease.lost || lease.releasing || lease.renewalInFlight) return;
    const renewal = renewLeadershipLease(lease);
    lease.renewalInFlight = renewal;
    void renewal.finally(() => {
      if (lease.renewalInFlight === renewal) lease.renewalInFlight = null;
    });
    return renewal;
  }, RENEWAL_INTERVAL_MS);

  log.debug("Leadership renewal started", { role, intervalMs: RENEWAL_INTERVAL_MS });
}

function stopLeadershipRenewal(lease: OwnedLeadershipLease): void {
  if (!lease.renewalTimer) return;
  clearInterval(lease.renewalTimer);
  lease.renewalTimer = null;
}

async function markLeadershipLost(lease: OwnedLeadershipLease, error: unknown): Promise<void> {
  lease.lost = true;
  stopLeadershipRenewal(lease);
  if (ownedLease === lease) ownedLease = null;
  try {
    await lease.onLeadershipLost?.(error);
  } catch (callbackError) {
    log.error("Leadership loss handler failed", { role: lease.role, daemonId, error: callbackError });
  }
}

async function renewLeadershipLease(lease: OwnedLeadershipLease): Promise<void> {
  try {
    const store = await ensureLeaderBucket();
    if (ownedLease !== lease || lease.lost || lease.releasing) return;
    lease.revision = await store.update(lease.role, sc.encode(daemonId), lease.revision);
    log.debug("Leadership renewed", { role: lease.role, daemonId, revision: lease.revision });
  } catch (err) {
    await markLeadershipLost(lease, err);
    log.warn("Leadership lease lost while renewing", { role: lease.role, daemonId, error: err });
  }
}

/**
 * Watch for leadership vacancy on a role by polling.
 *
 * NATS KV TTL expiry does NOT emit DEL/PURGE events — the key simply disappears.
 * Polling with kv.get() is the only reliable way to detect expired leases.
 *
 * Poll interval is set to RENEWAL_INTERVAL_MS so we detect vacancies within
 * one renewal cycle (≤ 10s after the leader's lease expires).
 */
export interface LeadershipVacancyWatcher {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  cancel(): void;
}

export interface LeadershipVacancyWatchOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onLeadershipLost?: LeadershipLostHandler;
}

function waitForLeadershipPoll(signal: AbortSignal, pollIntervalMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, pollIntervalMs);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function watchForLeadershipVacancy(
  role: string,
  onVacancy: () => Promise<void>,
  options: LeadershipVacancyWatchOptions = {},
): LeadershipVacancyWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? RENEWAL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("pollIntervalMs must be a finite non-negative number");
  }
  log.info("Polling for leadership vacancy", { role, pollIntervalMs });

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const done = (async () => {
    while (!controller.signal.aborted) {
      if (!(await waitForLeadershipPoll(controller.signal, pollIntervalMs))) return;

      let leadershipVacant = false;
      try {
        const store = await ensureLeaderBucket();
        if (controller.signal.aborted) return;
        const entry = await store.get(role).catch(() => null);
        if (controller.signal.aborted) return;
        leadershipVacant = !entry;
      } catch (err) {
        if (!controller.signal.aborted) log.warn("Leadership poll error, will retry", { role, error: err });
        continue;
      }

      if (!leadershipVacant) continue;

      // Key is gone — leader's TTL expired (or leader cleanly released it)
      log.info("Leadership vacancy detected (key missing), attempting takeover", { role });
      let won: boolean;
      try {
        won = await tryAcquireLeadership(role);
      } catch (err) {
        if (!controller.signal.aborted) log.warn("Leadership takeover error, will retry", { role, error: err });
        continue;
      }
      if (controller.signal.aborted) {
        if (won) await releaseLeadership(role);
        return;
      }
      if (!won) continue;

      startLeadershipRenewal(role, options.onLeadershipLost);
      try {
        await onVacancy();
      } catch (err) {
        await releaseLeadership(role);
        throw err;
      }
      if (controller.signal.aborted) {
        await releaseLeadership(role);
      }
      return; // Done polling — takeover either completed or was compensated.
    }
  })().finally(() => options.signal?.removeEventListener("abort", abort));
  return {
    signal: controller.signal,
    done,
    cancel: abort,
  };
}

/**
 * Release leadership and stop renewal timer.
 * Called during graceful shutdown.
 */
export async function releaseLeadership(role: string): Promise<void> {
  const lease = ownedLease;
  if (!lease || lease.role !== role || lease.lost) return;
  if (lease.releaseInFlight) return lease.releaseInFlight;

  lease.releasing = true;
  stopLeadershipRenewal(lease);
  const release = releaseOwnedLeadership(lease);
  lease.releaseInFlight = release;
  return release;
}

async function releaseOwnedLeadership(lease: OwnedLeadershipLease): Promise<void> {
  try {
    await lease.renewalInFlight;
    if (lease.lost || ownedLease !== lease) return;
    const store = await ensureLeaderBucket();
    await store.delete(lease.role, { previousSeq: lease.revision });
    log.info("Leadership released", { role: lease.role, daemonId, revision: lease.revision });
  } catch (err) {
    log.warn("Failed to release leadership", { role: lease.role, error: err });
  } finally {
    if (ownedLease === lease) ownedLease = null;
  }
}
