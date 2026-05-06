import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const RAVI_STATE_DIR_KEY = "RAVI_STATE_DIR";
let originalStateDir: string | undefined;

beforeEach(() => {
  originalStateDir = process.env[RAVI_STATE_DIR_KEY];
  const tmp = mkdtempSync(join(tmpdir(), "ravi-metrics-test-"));
  process.env[RAVI_STATE_DIR_KEY] = tmp;
  // Reset cached singleton across each test by clearing the global handle.
  const g = globalThis as { __raviRouterDbState?: unknown };
  g.__raviRouterDbState = undefined;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env[RAVI_STATE_DIR_KEY];
  else process.env[RAVI_STATE_DIR_KEY] = originalStateDir;
  const g = globalThis as { __raviRouterDbState?: unknown };
  g.__raviRouterDbState = undefined;
});

describe("rollupDailyMetrics", () => {
  it("aggregates cost_events and session_events into per-(agent,date,model) rows", async () => {
    const { getDb } = await import("../router/router-db.js");
    const { rollupDailyMetrics, getDailyMetrics } = await import("./rollup.js");

    const db = getDb();
    // Seed a single day: 2026-04-15 UTC has two cost rows and matching turn outcomes.
    const dayStart = Date.parse("2026-04-15T12:00:00.000Z");
    db.prepare(
      `INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd, total_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("agent:dev:main", "dev", "gpt-5.5", 100, 50, 0, 0, 0.0001, 0.001, 0, 0.0011, dayStart);
    db.prepare(
      `INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd, total_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("agent:dev:main", "dev", "gpt-5.5", 200, 75, 1000, 0, 0.0002, 0.0015, 0, 0.0017, dayStart + 60_000);

    const insertEvent = db.prepare(`
      INSERT INTO session_events
      (session_key, session_name, agent_id, run_id, turn_id, seq, event_type, event_group, status, timestamp, model, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn1",
      1,
      "turn.complete",
      "turn",
      "complete",
      dayStart + 30_000,
      "gpt-5.5",
      12_345,
      dayStart + 30_000,
    );
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn2",
      1,
      "turn.failed",
      "turn",
      "failed",
      dayStart + 90_000,
      "gpt-5.5",
      5_000,
      dayStart + 90_000,
    );
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn1",
      2,
      "tool.start",
      "tool",
      "running",
      dayStart + 31_000,
      null,
      null,
      dayStart + 31_000,
    );
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn1",
      3,
      "tool.end",
      "tool",
      "complete",
      dayStart + 32_000,
      null,
      1_000,
      dayStart + 32_000,
    );
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn2",
      4,
      "tool.start",
      "tool",
      "running",
      dayStart + 91_000,
      null,
      null,
      dayStart + 91_000,
    );
    insertEvent.run(
      "agent:dev:main",
      "dev",
      "dev",
      "run1",
      "turn2",
      5,
      "tool.end",
      "tool",
      "failed",
      dayStart + 92_000,
      null,
      50,
      dayStart + 92_000,
    );

    const result = rollupDailyMetrics({ since: "2026-04-15", through: "2026-04-15" });
    expect(result.dates).toEqual(["2026-04-15"]);
    expect(result.rowsWritten).toBe(2); // dev+gpt-5.5 (cost+turns) and dev+<all> (tool counts)

    const rows = getDailyMetrics({ agentId: "dev", since: "2026-04-15", through: "2026-04-15" });
    const costRow = rows.find((r) => r.model === "gpt-5.5");
    expect(costRow).toBeTruthy();
    expect(costRow?.inputTokens).toBe(300);
    expect(costRow?.outputTokens).toBe(125);
    expect(costRow?.cacheReadTokens).toBe(1000);
    expect(costRow?.totalCostUsd).toBeCloseTo(0.0028, 4);
    expect(costRow?.costEventCount).toBe(2);
    expect(costRow?.turnsComplete).toBe(1);
    expect(costRow?.turnsFailed).toBe(1);
    expect(costRow?.totalDurationMs).toBe(17_345);

    const toolRow = rows.find((r) => r.model === "<all>");
    expect(toolRow).toBeTruthy();
    expect(toolRow?.toolCalls).toBe(2);
    expect(toolRow?.toolErrors).toBe(1);
  });

  it("is idempotent — re-running for the same day overwrites without duplicating", async () => {
    const { getDb } = await import("../router/router-db.js");
    const { rollupDailyMetrics, getDailyMetrics } = await import("./rollup.js");

    const dayStart = Date.parse("2026-04-16T12:00:00.000Z");
    const db = getDb();
    db.prepare(
      `INSERT INTO cost_events (session_key, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd, cache_cost_usd, total_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("agent:main:main", "main", "opus", 1, 2, 0, 0, 0, 0, 0, 0.5, dayStart);

    const first = rollupDailyMetrics({ since: "2026-04-16", through: "2026-04-16" });
    const second = rollupDailyMetrics({ since: "2026-04-16", through: "2026-04-16" });
    expect(first.rowsWritten).toBe(second.rowsWritten);

    const rows = getDailyMetrics({ since: "2026-04-16", through: "2026-04-16" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalCostUsd).toBeCloseTo(0.5);
  });
});
