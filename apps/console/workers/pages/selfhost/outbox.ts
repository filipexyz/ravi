import { Database } from "bun:sqlite";
import type { PagesUsageQueueMessage } from "../src/index";

/** Single-instance durable at-least-once queue. Events already carry idempotency keys. */
export class UsageOutbox {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database, private readonly deliver: (messages: PagesUsageQueueMessage[]) => Promise<void>, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS pages_usage_outbox (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0
    )`);
  }
  async send(message: PagesUsageQueueMessage): Promise<void> {
    const now = this.now();
    this.db.query("INSERT INTO pages_usage_outbox(id,payload,created_at,next_at) VALUES(?,?,?,?)").run(crypto.randomUUID(), JSON.stringify(message), now, now);
  }
  start() {
    this.timer = setInterval(() => void this.flush().catch(() => console.error("pages_usage_outbox_flush_failed")), 2000);
    this.timer.unref();
    void this.flush().catch(() => console.error("pages_usage_outbox_flush_failed"));
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  counts(): { pending: number; failed: number } {
    const rows = this.db.query("SELECT failed, COUNT(*) as count FROM pages_usage_outbox GROUP BY failed").all() as { failed: number; count: number }[];
    return { pending: rows.find((row) => row.failed === 0)?.count ?? 0, failed: rows.find((row) => row.failed === 1)?.count ?? 0 };
  }
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = this.db.query("SELECT id,payload,attempts FROM pages_usage_outbox WHERE failed=0 AND next_at<=? ORDER BY created_at LIMIT 25").all(this.now()) as { id: string; payload: string; attempts: number }[];
      if (!rows.length) return;
      try {
        await this.deliver(rows.map((row) => JSON.parse(row.payload) as PagesUsageQueueMessage));
        this.db.transaction(() => { for (const row of rows) this.db.query("DELETE FROM pages_usage_outbox WHERE id=?").run(row.id); })();
      } catch {
        this.db.transaction(() => {
          for (const row of rows) {
            const attempts = row.attempts + 1;
            this.db.query("UPDATE pages_usage_outbox SET attempts=?,next_at=?,failed=? WHERE id=?").run(attempts, this.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 12)), attempts >= 100 ? 1 : 0, row.id);
          }
        })();
        console.warn("pages_usage_delivery_retry", { count: rows.length });
      }
    } finally { this.running = false; }
  }
}
