/**
 * Centralized close of all SQLite database handles owned by Ravi.
 *
 * Call from `daemon.ts` shutdown so WAL/SHM files get a clean wind-down on
 * graceful exit. Each close runs in its own try-catch — a failure in one
 * subsystem must not block the others.
 */

import { close as closeChatDb } from "../db.js";
import { closeContacts } from "../contacts.js";
import { closeCredentialsDb } from "../credentials/store.js";
import { closeDevinDb } from "../devin/store.js";
import { closeVoiceDb } from "../voice/store.js";
import { closeInsightsDb } from "../insights/insight-db.js";
import { closeKnowledgeDb } from "../knowledge/store/db.js";
import { closeSessionAdapterStore } from "../adapters/adapter-db.js";
import { closeSessionStore } from "../router/sessions.js";
import { closeRouterDb } from "../router/router-db.js";
import { closeSessionGoalStore } from "../runtime/session-goals.js";
import { logger } from "../utils/logger.js";

const log = logger.child("db:close-all");

interface CloseStep {
  name: string;
  close: () => void;
}

const CLOSE_STEPS: CloseStep[] = [
  // Order: dependents first, then base router/chat DBs. closeSessionStore and
  // closeSessionGoalStore only clear cached prepared statements, so they have
  // to run before closeRouterDb (which closes the underlying Database).
  { name: "session-store", close: closeSessionStore },
  { name: "session-goal-store", close: closeSessionGoalStore },
  { name: "session-adapter-store", close: closeSessionAdapterStore },
  { name: "contacts", close: closeContacts },
  { name: "credentials", close: closeCredentialsDb },
  { name: "chat", close: closeChatDb },
  { name: "devin", close: closeDevinDb },
  { name: "voice", close: closeVoiceDb },
  { name: "insights", close: closeInsightsDb },
  { name: "knowledge", close: closeKnowledgeDb },
  { name: "router", close: closeRouterDb },
];

export function closeAllRaviDbs(steps: readonly CloseStep[] = CLOSE_STEPS): void {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      step.close();
    } catch (cause) {
      failures.push(new Error(`Database ${step.name} failed to close`, { cause }));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Ravi database shutdown failed", { cause: failures[0] });
  log.info("all ravi db handles closed");
}
