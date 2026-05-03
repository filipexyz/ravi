/**
 * Ephemeral Session Cleanup Runner
 *
 * Periodically checks for expiring/expired ephemeral sessions.
 * - 10 minutes before expiry: sends warning to session
 * - On expiry: aborts SDK subprocess, deletes session
 */

import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { getExpiringSessions, getExpiredSessions } from "../router/sessions.js";
import { dbCleanupMessageMeta, dbCleanupExpiredSessions } from "../router/router-db.js";
import { rollupDailyMetrics } from "../metrics/rollup.js";

const log = logger.child("ephemeral");

/** How often to check for expiring sessions (ms) */
const CHECK_INTERVAL_MS = 60_000; // 1 minute

/** How far ahead to look for sessions to warn (ms) */
const WARN_AHEAD_MS = 10 * 60_000; // 10 minutes

/** How often to run the daily-metrics rollup (ms) */
const ROLLUP_INTERVAL_MS = 60 * 60_000; // 1 hour

/** Track which sessions we already warned */
const warned = new Set<string>();

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let rollupTimer: ReturnType<typeof setInterval> | null = null;
let lastRollupAt = 0;
let running = false;

/**
 * Run a single cleanup cycle:
 * 1. Warn sessions expiring in the next 10 minutes
 * 2. Delete sessions that have expired
 */
async function tick(): Promise<void> {
  try {
    // 1. Warn sessions expiring soon (but not yet expired)
    const expiring = getExpiringSessions(WARN_AHEAD_MS);
    for (const session of expiring) {
      const key = session.sessionKey;
      if (warned.has(key)) continue;

      const sessionName = session.name ?? key;
      const minutesLeft = Math.max(1, Math.round(((session.expiresAt ?? 0) - Date.now()) / 60_000));

      const prompt = `[System] Inform: ⏳ Esta sessão efêmera "${sessionName}" expira em ~${minutesLeft} minutos. Para agir, use os comandos CLI:
- Estender +5h: ravi sessions extend ${sessionName}
- Tornar permanente: ravi sessions keep ${sessionName}
- Excluir agora: ravi sessions delete ${sessionName}
Sem ação = sessão será excluída automaticamente.`;

      try {
        await publishSessionPrompt(sessionName, { prompt });
        warned.add(key);
        log.info("Sent ephemeral warning", { sessionName, minutesLeft });
      } catch (err) {
        log.warn("Failed to send ephemeral warning", { sessionName, error: err });
      }
    }

    // 2. Abort and delete expired sessions
    const expired = getExpiredSessions();
    for (const session of expired) {
      // Abort SDK subprocess first
      try {
        await nats.emit("ravi.session.abort", {
          sessionKey: session.sessionKey,
          sessionName: session.name,
          source: "ephemeral-runner",
          action: "expire-session",
          reason: "ephemeral_session_expired",
          actor: "system",
        });
      } catch {
        // Ignore abort errors — session may not be active
      }
      warned.delete(session.sessionKey);
    }
    // Bulk-delete all expired ephemeral sessions (catches any stragglers too)
    const deletedCount = dbCleanupExpiredSessions();
    if (deletedCount > 0) {
      log.info("Deleted expired ephemeral sessions", { count: deletedCount });
    }

    // 3. Cleanup old message metadata (>7 days)
    const cleaned = dbCleanupMessageMeta();
    if (cleaned > 0) {
      log.info("Cleaned up old message metadata", { count: cleaned });
    }
  } catch (err) {
    log.error("Ephemeral cleanup tick failed", err);
  }
}

function rollupTick(): void {
  const now = Date.now();
  if (now - lastRollupAt < ROLLUP_INTERVAL_MS / 2) return;
  lastRollupAt = now;
  try {
    const result = rollupDailyMetrics();
    if (result.rowsWritten > 0) {
      log.info("Daily metrics rollup", { dayCount: result.dates.length, rowsWritten: result.rowsWritten });
    }
  } catch (err) {
    log.error("Daily metrics rollup failed", err);
  }
}

export async function startEphemeralRunner(): Promise<void> {
  if (running) return;
  running = true;

  log.info("Starting ephemeral session cleanup runner");

  // Run first tick immediately
  await tick();
  // Kick off an initial rollup so a freshly-restarted daemon backfills any
  // missing days from the last shutdown without waiting an hour.
  rollupTick();

  // Then run periodically
  intervalTimer = setInterval(tick, CHECK_INTERVAL_MS);
  rollupTimer = setInterval(rollupTick, ROLLUP_INTERVAL_MS);

  log.info("Ephemeral runner started", {
    checkIntervalMs: CHECK_INTERVAL_MS,
    rollupIntervalMs: ROLLUP_INTERVAL_MS,
  });
}

export async function stopEphemeralRunner(): Promise<void> {
  if (!running) return;
  running = false;

  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }

  warned.clear();
  log.info("Ephemeral runner stopped");
}
