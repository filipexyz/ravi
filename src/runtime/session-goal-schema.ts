import type { Database } from "bun:sqlite";

/** Rebuild the old CHECK constraint without losing goal accounting or local links. */
export function ensureSessionGoalStatusSchema(database: Database): void {
  database
    .transaction(() => {
      const row = database.query("SELECT sql FROM sqlite_master WHERE name = 'session_goals'").get() as {
        sql: string;
      } | null;
      if (!row || row.sql.includes("'usage_limited'")) return;
      database.exec(`
      CREATE TABLE session_goals_next (
        session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','budget_limited','usage_limited','blocked','complete')),
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        task_id TEXT,
        project_id TEXT,
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_goals_next SELECT session_key, goal_id, objective, status, token_budget,
        tokens_used, time_used_seconds, task_id, project_id, blocked_reason, created_at, updated_at FROM session_goals;
      DROP TABLE session_goals;
      ALTER TABLE session_goals_next RENAME TO session_goals;
      CREATE INDEX idx_session_goals_status ON session_goals(status);
      CREATE INDEX idx_session_goals_task ON session_goals(task_id);
      CREATE INDEX idx_session_goals_project ON session_goals(project_id);
    `);
    })
    .immediate();
}
