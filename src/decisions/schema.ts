import type { Database } from "bun:sqlite";

/** Run only as part of opening the DB. No provider calls or production-specific repair. */
export function migrateDecisions(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        origin_type TEXT NOT NULL CHECK(origin_type IN ('task','thread')),
        origin_id TEXT NOT NULL,
        chat_id TEXT,
        session_key TEXT,
        key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','answered','superseded')),
        owner_type TEXT NOT NULL CHECK(owner_type IN ('human','agent','unassigned')),
        owner_id TEXT,
        ask TEXT NOT NULL, asked_by TEXT, asked_at INTEGER NOT NULL,
        answer TEXT, answered_by TEXT, answered_at INTEGER,
        blocks INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK(origin_type = 'task' OR (chat_id IS NOT NULL AND session_key IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_open
        ON decisions(origin_type,origin_id,key) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS decisions_origin ON decisions(origin_type,origin_id,asked_at);
      CREATE TABLE IF NOT EXISTS decision_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL REFERENCES decisions(id),
        type TEXT NOT NULL, actor TEXT, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_deliveries (
        id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions(id),
        kind TEXT NOT NULL CHECK(kind IN ('question','answer')),
        revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        claim_id TEXT, claim_until INTEGER,
        last_error TEXT, delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(decision_id,kind,revision)
      );
    `);
    const legacy = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='task_decisions'").get();
    if (!legacy) return;
    // Strict insert: an unexpected collision rolls the entire migration back.
    db.exec(`INSERT INTO decisions (
      id,origin_type,origin_id,key,status,owner_type,owner_id,ask,asked_by,asked_at,
      answer,answered_by,answered_at,blocks,created_at,updated_at
    ) SELECT id,'task',task_id,key,status,owner_type,owner_id,ask,asked_by,asked_at,
      answer,answered_by,answered_at,blocks,created_at,updated_at FROM task_decisions`);
    // Preserve the original table's full row as migration evidence; task_events remains untouched.
    const rows = db.query("SELECT * FROM task_decisions").all() as Array<Record<string, unknown>>;
    const insert = db.prepare(
      "INSERT INTO decision_history(decision_id,type,actor,snapshot_json,created_at) VALUES (?,'migrated',?,?,?)",
    );
    for (const row of rows)
      insert.run(String(row.id), row.asked_by as string | null, JSON.stringify(row), Number(row.created_at));
    db.exec("DROP TABLE task_decisions");
  }).immediate();
}
