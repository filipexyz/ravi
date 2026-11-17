import { getDb, getRaviDbPath } from "../router/router-db.js";

/**
 * Small receipt store for task mutations invoked with `--idempotency-key`.
 * A replay with the same `(task_id, key)` returns the previous result and the
 * caller must not emit a second event.
 */
export interface TaskOperationReceipt<T = unknown> {
  result: T;
  createdAt: number;
}

let schemaDbPath: string | null = null;

function ensureReceiptSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaDbPath === dbPath) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_operation_receipts (
      task_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, idempotency_key)
    );
  `);
  schemaDbPath = dbPath;
}

export function readTaskOperationReceipt<T = unknown>(
  taskId: string,
  idempotencyKey: string,
): TaskOperationReceipt<T> | null {
  const key = idempotencyKey.trim();
  if (!key) return null;
  ensureReceiptSchema();
  const row = getDb()
    .prepare("SELECT result_json, created_at FROM task_operation_receipts WHERE task_id = ? AND idempotency_key = ?")
    .get(taskId, key) as { result_json: string; created_at: number } | undefined;
  if (!row) return null;
  try {
    return { result: JSON.parse(row.result_json) as T, createdAt: row.created_at };
  } catch {
    return null;
  }
}

export function writeTaskOperationReceipt(
  taskId: string,
  idempotencyKey: string,
  result: unknown,
  now = Date.now(),
): void {
  const key = idempotencyKey.trim();
  if (!key) return;
  ensureReceiptSchema();
  getDb()
    .prepare(
      `INSERT INTO task_operation_receipts (task_id, idempotency_key, result_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, idempotency_key) DO NOTHING`,
    )
    .run(taskId, key, JSON.stringify(result ?? null), now);
}
