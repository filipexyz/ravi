import { deepStrictEqual, strictEqual } from "node:assert";
import { cpus, loadavg } from "node:os";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../src/test/ravi-state.js";
import { dbListContexts, getDb } from "../src/router/router-db.js";

const historicalRows = 25_000;
const activeRows = 6;
const repetitions = 7;
const legacySql = `SELECT * FROM contexts
  WHERE (revoked_at IS NULL OR revoked_at = 0 OR revoked_at > ?)
    AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?)
  ORDER BY created_at DESC`;

const stateDir = await createIsolatedRaviState("ravi-active-context-benchmark-");
try {
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO contexts
    (context_id, context_key, kind, capabilities_json, metadata_json, created_at, expires_at, revoked_at)
    VALUES (?, ?, 'turn-runtime', '[]', ?, ?, ?, ?)`);
  const metadata = JSON.stringify({ fixture: "synthetic", payload: "x".repeat(2_000) });
  db.transaction(() => {
    for (let index = 0; index < historicalRows; index++) {
      insert.run(`old-${index}`, `test-old-key-${index}`, metadata, now - index, now - 1, null);
    }
    for (let index = 0; index < activeRows; index++) {
      insert.run(
        `live-${index}`,
        `test-live-key-${index}`,
        metadata,
        now - historicalRows - index,
        [null, 0, now + 3_600_000][index % 3]!,
        index < 3 ? null : now + 3_600_000,
      );
    }
  })();

  // Capture the production query so the benchmark cannot drift to a separate candidate implementation.
  const prepare = db.prepare;
  let currentSql = "";
  Object.defineProperty(db, "prepare", {
    configurable: true,
    writable: true,
    value(sql: string) {
      currentSql = sql;
      return prepare.call(db, sql);
    },
  });
  try {
    strictEqual(dbListContexts().length, activeRows);
  } finally {
    Object.defineProperty(db, "prepare", { configurable: true, writable: true, value: prepare });
  }
  strictEqual(currentSql.includes("FROM contexts"), true);

  const statements = { legacy: db.prepare(legacySql), current: db.prepare(currentSql) };
  const expected = statements.legacy.all(now, now);
  strictEqual(expected.length, activeRows);
  const timings: Record<keyof typeof statements, number[]> = { legacy: [], current: [] };
  let failures = 0;
  for (let pair = 0; pair < repetitions; pair++) {
    const order: Array<keyof typeof statements> = pair % 2 === 0 ? ["legacy", "current"] : ["current", "legacy"];
    for (const variant of order) {
      const start = performance.now();
      const rows = statements[variant].all(now, now);
      timings[variant].push(performance.now() - start);
      try {
        deepStrictEqual(rows, expected);
      } catch {
        failures++;
      }
    }
  }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)],
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      runsMs: values,
    };
  };
  console.log(
    JSON.stringify(
      {
        dataset: { historicalRows, activeRows, metadataChars: metadata.length },
        environment: { cpus: cpus().length, loadAverage: loadavg() },
        scope: "Materialized SQL query only; warmed cache; no model, queue or channel time",
        repetitions,
        failures,
        legacy: summarize(timings.legacy),
        current: summarize(timings.current),
        plans: {
          legacy: db.prepare(`EXPLAIN QUERY PLAN ${legacySql}`).all(now, now),
          current: db.prepare(`EXPLAIN QUERY PLAN ${currentSql}`).all(now, now),
        },
      },
      null,
      2,
    ),
  );
  strictEqual(failures, 0, "Both variants must return identical complete records");
} finally {
  await cleanupIsolatedRaviState(stateDir);
}
