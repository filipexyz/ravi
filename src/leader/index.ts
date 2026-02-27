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
 * TTL is configured via the KV bucket's max_age. Key is recreated on each renewal
 * using `put` (update — doesn't fail if already exists, just resets TTL implicitly
 * by updating the value). The TTL is set at the bucket level.
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
let renewalTimer: ReturnType<typeof setInterval> | null = null;

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
    await store.create(role, sc.encode(daemonId));
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
 * The renewal uses `put` to update the key (resets TTL on the value revision).
 * If renewal fails, logs a warning but keeps trying.
 */
export function startLeadershipRenewal(role: string): void {
  if (renewalTimer) return;

  renewalTimer = setInterval(async () => {
    try {
      const store = await ensureLeaderBucket();
      await store.put(role, sc.encode(daemonId));
      log.debug("Leadership renewed", { role, daemonId });
    } catch (err) {
      log.warn("Failed to renew leadership", { role, daemonId, error: err });
    }
  }, RENEWAL_INTERVAL_MS);

  log.debug("Leadership renewal started", { role, intervalMs: RENEWAL_INTERVAL_MS });
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
export async function watchForLeadershipVacancy(
  role: string,
  onVacancy: () => Promise<void>,
): Promise<void> {
  log.info("Polling for leadership vacancy", { role, pollIntervalMs: RENEWAL_INTERVAL_MS });

  (async () => {
    while (true) {
      await new Promise((r) => setTimeout(r, RENEWAL_INTERVAL_MS));

      try {
        const store = await ensureLeaderBucket();
        const entry = await store.get(role).catch(() => null);

        if (!entry) {
          // Key is gone — leader's TTL expired (or leader cleanly released it)
          log.info("Leadership vacancy detected (key missing), attempting takeover", { role });
          const won = await tryAcquireLeadership(role);
          if (won) {
            startLeadershipRenewal(role);
            await onVacancy();
            return; // Done polling — we're now leader
          }
          // Lost the race — another daemon won; continue polling in case it also dies
        }
      } catch (err) {
        log.warn("Leadership poll error, will retry", { role, error: err });
      }
    }
  })();
}

/**
 * Release leadership and stop renewal timer.
 * Called during graceful shutdown.
 */
export async function releaseLeadership(role: string): Promise<void> {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }

  try {
    const store = await ensureLeaderBucket();
    await store.delete(role);
    log.info("Leadership released", { role, daemonId });
  } catch (err) {
    log.warn("Failed to release leadership", { role, error: err });
  }
}
