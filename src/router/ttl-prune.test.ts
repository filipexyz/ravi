import { afterEach, describe, expect, it } from "bun:test";
import { recordSessionBlob } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbPruneStaleRows, getDb, type DbPruneBatchInfo } from "./router-db.js";
import { getOrCreateSession } from "./sessions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 200 * DAY;

let stateDir: string | null = null;

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function countTable(table: string): number {
  return Number((getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

function insertSessionEvents(timestamps: number[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_events (session_key, seq, event_type, event_group, timestamp, created_at)
    VALUES ('agent:dev:ttl', ?, 'turn.complete', 'runtime', ?, ?)
  `);
  for (const [index, timestamp] of timestamps.entries()) {
    stmt.run(index + 1, timestamp, timestamp);
  }
}

function insertMessageMeta(createdAts: number[]): void {
  const stmt = getDb().prepare(
    "INSERT INTO message_metadata (message_id, chat_id, created_at) VALUES (?, 'chat-ttl', ?)",
  );
  for (const [index, createdAt] of createdAts.entries()) {
    stmt.run(`msg-${index}-${createdAt}`, createdAt);
  }
}

function insertAuditLog(timestamps: number[]): void {
  const stmt = getDb().prepare(
    "INSERT INTO audit_log (action, entity, entity_id, actor, ts) VALUES ('prune-test', 'session', ?, 'test', ?)",
  );
  for (const [index, ts] of timestamps.entries()) {
    stmt.run(`entity-${index}`, ts);
  }
}

function insertCostEvents(createdAts: number[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO cost_events (
      session_key, agent_id, model, input_tokens, output_tokens,
      input_cost_usd, output_cost_usd, total_cost_usd, created_at
    ) VALUES ('agent:dev:ttl', 'dev', 'sonnet', 1, 1, 0, 0, 0, ?)
  `);
  for (const createdAt of createdAts) {
    stmt.run(createdAt);
  }
}

describe("dbPruneStaleRows batched TTL deletes", () => {
  it("keeps dry-run counts and deletes only rows past TTL", async () => {
    stateDir = await createIsolatedRaviState("ravi-ttl-prune-dry-live-");
    insertSessionEvents([1, 2, NOW - DAY]);
    insertMessageMeta([1, NOW - DAY]);
    insertAuditLog([1, NOW - DAY]);
    insertCostEvents([1, NOW - DAY]);
    recordSessionBlob({ kind: "adapter_request", contentText: "stale-blob", createdAt: 1 });
    recordSessionBlob({ kind: "adapter_request", contentText: "fresh-blob", createdAt: NOW - DAY });
    getOrCreateSession("agent:dev:ttl-expired", "dev", stateDir, { name: "ttl-expired" });
    getOrCreateSession("agent:dev:ttl-keep", "dev", stateDir, { name: "ttl-keep" });
    getDb()
      .prepare("UPDATE sessions SET ephemeral = 1, expires_at = 1 WHERE session_key = ?")
      .run("agent:dev:ttl-expired");

    const dryRun = await dbPruneStaleRows({ dryRun: true, now: NOW });
    expect(dryRun.sessionEvents).toBe(2);
    expect(dryRun.sessionTraceBlobs).toBe(1);
    expect(dryRun.messageMetadata).toBe(1);
    expect(dryRun.auditLog).toBe(1);
    expect(dryRun.costEvents).toBe(1);
    expect(dryRun.expiredSessions).toBe(1);
    expect(countTable("session_events")).toBe(3);

    const live = await dbPruneStaleRows({ now: NOW, yieldBetweenBatches: false, walCheckpoint: true });
    expect(live).toMatchObject({
      sessionEvents: 2,
      sessionTraceBlobs: 1,
      messageMetadata: 1,
      auditLog: 1,
      costEvents: 1,
      expiredSessions: 1,
      walCheckpointed: true,
    });
    expect(countTable("session_events")).toBe(1);
    expect(countTable("session_trace_blobs")).toBe(1);
    expect(countTable("message_metadata")).toBe(1);
    expect(countTable("audit_log")).toBe(1);
    expect(countTable("cost_events")).toBe(1);
    expect(
      getDb()
        .prepare("SELECT session_key FROM sessions WHERE session_key LIKE 'agent:dev:ttl-%' ORDER BY session_key")
        .all(),
    ).toEqual([{ session_key: "agent:dev:ttl-keep" }]);
  });

  it("deletes a large backlog in bounded batches and commits each batch", async () => {
    stateDir = await createIsolatedRaviState("ravi-ttl-prune-batches-");
    insertSessionEvents(Array.from({ length: 7 }, (_, index) => index + 1));

    const db = getDb();
    const commits: number[] = [];
    const preparedDeletes: string[] = [];
    const originalExec = db.exec.bind(db);
    const originalPrepare = db.prepare.bind(db);
    db.exec = ((sql: string) => {
      if (sql === "COMMIT") commits.push(Date.now());
      return originalExec(sql);
    }) as typeof db.exec;
    db.prepare = (sql: string) => {
      if (/DELETE FROM session_events/i.test(sql)) preparedDeletes.push(sql);
      return originalPrepare(sql);
    };

    const batches: DbPruneBatchInfo[] = [];
    const result = await dbPruneStaleRows({
      now: NOW,
      batchSize: 2,
      yieldBetweenBatches: false,
      onBatch: (info) => {
        if (info.table === "session_events") batches.push(info);
      },
    });

    expect(result.sessionEvents).toBe(7);
    expect(batches.map((batch) => batch.deleted)).toEqual([2, 2, 2, 1]);
    expect(batches.every((batch) => batch.deleted <= 2)).toBe(true);
    expect(preparedDeletes.length).toBeGreaterThan(0);
    expect(preparedDeletes.every((sql) => sql.includes("LIMIT ?"))).toBe(true);
    expect(preparedDeletes.some((sql) => /^DELETE FROM session_events WHERE timestamp < \?$/.test(sql.trim()))).toBe(
      false,
    );
    expect(commits.length).toBeGreaterThanOrEqual(4);
    expect(countTable("session_events")).toBe(0);
  });

  it("yields between full batches so the event loop can run", async () => {
    stateDir = await createIsolatedRaviState("ravi-ttl-prune-yield-");
    insertSessionEvents([1, 2, 3, 4, 5]);

    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks += 1;
    }, 5);
    const yields: number[] = [];
    try {
      const result = await dbPruneStaleRows({
        now: NOW,
        batchSize: 2,
        yieldBetweenBatches: async () => {
          yields.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 15));
        },
      });
      expect(result.sessionEvents).toBe(5);
      expect(yields.length).toBe(2);
      expect(timerTicks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });
});
