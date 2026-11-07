import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { getRaviDbPath } from "../router/router-db.js";
import { prError, type PublicationPhase, type PublicationPlan, PUBLICATION_TIMEOUT_MS } from "./contracts.js";

export interface PublicationJournal {
  publicationId: string;
  attemptId: string;
  record(
    phase: PublicationPhase,
    state: "intent" | "confirmed" | "failed" | "uncertain",
    detail?: Record<string, string | number | boolean | null>,
  ): void;
  close(): void;
}

/** Lazily opened AFTER --execute. The existing runtime DB owns both audit and the local lease. */
export function openPublicationJournal(
  plan: PublicationPlan,
  provenance: Record<string, string | null>,
  database?: Database,
): PublicationJournal {
  let db: Database;
  try {
    db = database ?? new Database(getRaviDbPath(), { readwrite: true, create: false });
    // A separate connection makes intent durable before network IO without changing the runtime connection.
    if (!database) db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
  } catch {
    throw prError("PUBLICATION_AUDIT_FAILED", "Cannot open the existing runtime audit database.");
  }
  const publicationId = `prpub_${createHash("sha256")
    .update(JSON.stringify([plan.repo, plan.head, plan.base, plan.localSha]))
    .digest("hex")
    .slice(0, 24)}`;
  const attemptId = randomUUID();
  const key = `${plan.repo}:${plan.head}`;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS pr_publication_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, publication_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      phase TEXT NOT NULL, state TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pr_publication_events_lookup ON pr_publication_events(publication_id, id);
      CREATE TABLE IF NOT EXISTS pr_publication_leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    const lock = db
      .query(`INSERT INTO pr_publication_leases(resource,owner,expires_at) VALUES (?,?,?)
      ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE pr_publication_leases.expires_at < ?`)
      .run(key, attemptId, Date.now() + PUBLICATION_TIMEOUT_MS + 30_000, Date.now());
    if (!lock.changes)
      throw prError("PUBLICATION_BUSY", "Another publication is active for this repository and branch.", {
        retryable: true,
      });
  } catch (error) {
    if (!database) db.close();
    if (error instanceof Error && "code" in error && error.code === "PUBLICATION_BUSY") throw error;
    throw prError("PUBLICATION_AUDIT_FAILED", "Could not persist publication intent; no remote mutation was started.");
  }
  const journal: PublicationJournal = {
    publicationId,
    attemptId,
    record(phase, state, detail = {}) {
      try {
        const lease = db.query("SELECT owner,expires_at FROM pr_publication_leases WHERE resource=?").get(key) as {
          owner: string;
          expires_at: number;
        } | null;
        if (!lease || lease.owner !== attemptId || lease.expires_at <= Date.now()) throw new Error("lease lost");
        db.query(
          "INSERT INTO pr_publication_events(publication_id,attempt_id,phase,state,detail_json,created_at) VALUES (?,?,?,?,?,?)",
        ).run(publicationId, attemptId, phase, state, JSON.stringify(detail), Date.now());
      } catch {
        throw prError(
          "PUBLICATION_AUDIT_FAILED",
          "Publication audit could not be persisted. Reconcile remote state before retrying.",
        );
      }
    },
    close() {
      try {
        db.query("DELETE FROM pr_publication_leases WHERE resource=? AND owner=?").run(key, attemptId);
      } catch {
        // A stale lease expires. Cleanup must not erase a confirmed result or the original partial error.
      } finally {
        if (!database) db.close();
      }
    },
  };
  try {
    journal.record("preflight", "confirmed", {
      ...provenance,
      repo: plan.repo,
      head: plan.head,
      base: plan.base,
      sha: plan.localSha,
      tree: plan.treeSha,
    });
  } catch (error) {
    journal.close();
    throw error;
  }
  return journal;
}
