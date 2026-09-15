/**
 * Codex liveness probe for `ravi storage cleanup`.
 *
 * Reads the Ravi database in **read-only** mode to answer whether a Codex
 * session id is referenced by a known Ravi session. It never creates or
 * migrates the database: if the file is missing, locked or errors, the answer
 * is "unknown" and the storage engine preserves the artifact (fail-closed).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { codexProcessRunning, type CodexProbe, type CodexSessionLiveness } from "./eligibility.js";

export function createRaviCodexProbe(env: NodeJS.ProcessEnv = process.env): CodexProbe {
  let connection: Database | null | undefined;

  const open = (): Database | null => {
    if (connection !== undefined) return connection;
    try {
      const path = join(getRaviStateDir(env), "ravi.db");
      connection = existsSync(path) ? new Database(path, { readonly: true }) : null;
    } catch {
      connection = null;
    }
    return connection;
  };

  return {
    processRunning: () => codexProcessRunning(),
    sessionLiveness: (sessionId: string): CodexSessionLiveness => {
      const db = open();
      if (!db) return "unknown";
      try {
        const row = db
          .query("SELECT 1 AS present FROM sessions WHERE sdk_session_id = ? OR runtime_session_display_id = ? LIMIT 1")
          .get(sessionId, sessionId);
        return row ? "live" : "not-live";
      } catch {
        return "unknown";
      }
    },
  };
}
