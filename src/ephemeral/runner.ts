/**
 * Ephemeral Session Cleanup Runner
 *
 * Periodically checks for expiring/expired ephemeral sessions.
 * - 10 minutes before expiry: sends warning to session
 * - On expiry: aborts SDK subprocess, deletes session
 */

import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import {
  getExpiringSessions,
  getExpiredSessions,
  deleteSessionByName,
  deleteSession,
} from "../router/sessions.js";
import { dbCleanupMessageMeta } from "../router/router-db.js";

const log = logger.child("ephemeral");

/** How often to check for expiring sessions (ms) */
const CHECK_INTERVAL_MS = 60_000; // 1 minute

/** How far ahead to look for sessions to warn (ms) */
const WARN_AHEAD_MS = 10 * 60_000; // 10 minutes

/** Track which sessions we already warned */
const warned = new Set<string>();

let intervalTimer: ReturnType<typeof setInterval> | null = null;
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
        await nats.emit(`ravi.session.${sessionName}.prompt`, { prompt });
        warned.add(key);
        log.info("Sent ephemeral warning", { sessionName, minutesLeft });
      } catch (err) {
        log.warn("Failed to send ephemeral warning", { sessionName, error: err });
      }
    }

    // 2. Delete expired sessions
    const expired = getExpiredSessions();
    for (const session of expired) {
      const sessionName = session.name ?? session.sessionKey;

      // Abort SDK subprocess first
      try {
        await nats.emit("ravi.session.abort", {
          sessionKey: session.sessionKey,
          sessionName: session.name,
        });
      } catch {
        // Ignore abort errors — session may not be active
      }

      // Delete from DB
      const deleted = session.name
        ? deleteSessionByName(session.name)
        : deleteSession(session.sessionKey);

      if (deleted) {
        warned.delete(session.sessionKey);
        log.info("Deleted expired ephemeral session", { sessionName });
      }
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

export async function startEphemeralRunner(): Promise<void> {
  if (running) return;
  running = true;

  log.info("Starting ephemeral session cleanup runner");

  // Run first tick immediately
  await tick();

  // Then run periodically
  intervalTimer = setInterval(tick, CHECK_INTERVAL_MS);

  log.info("Ephemeral runner started", { checkIntervalMs: CHECK_INTERVAL_MS });
}

export async function stopEphemeralRunner(): Promise<void> {
  if (!running) return;
  running = false;

  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }

  warned.clear();
  log.info("Ephemeral runner stopped");
}
