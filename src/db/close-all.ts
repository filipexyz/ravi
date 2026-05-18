/**
 * Centralized close of all SQLite database handles owned by Ravi.
 *
 * Call from `daemon.ts` shutdown so WAL/SHM files get a clean wind-down on
 * graceful exit. Each close runs in its own try-catch — a failure in one
 * subsystem must not block the others.
 */

import { close as closeChatDb } from "../db.js";
import { closeContacts } from "../contacts.js";
import { closeDevinDb } from "../devin/store.js";
import { closeInsightsDb } from "../insights/insight-db.js";
import { closeSessionAdapterStore } from "../adapters/adapter-db.js";
import { closeSessionStore } from "../router/sessions.js";
import { closeRouterDb } from "../router/router-db.js";
import { logger } from "../utils/logger.js";

const log = logger.child("db:close-all");

interface CloseStep {
  name: string;
  close: () => void;
}

const CLOSE_STEPS: CloseStep[] = [
  // Order: dependents first, then base router/chat DBs. closeSessionStore only
  // clears cached prepared statements, so it has to run before closeRouterDb
  // (which closes the underlying Database).
  { name: "session-store", close: closeSessionStore },
  { name: "session-adapter-store", close: closeSessionAdapterStore },
  { name: "contacts", close: closeContacts },
  { name: "chat", close: closeChatDb },
  { name: "devin", close: closeDevinDb },
  { name: "insights", close: closeInsightsDb },
  { name: "router", close: closeRouterDb },
];

export function closeAllRaviDbs(): void {
  for (const step of CLOSE_STEPS) {
    try {
      step.close();
    } catch (err) {
      log.error("failed to close db handle", {
        db: step.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("all ravi db handles closed");
}
