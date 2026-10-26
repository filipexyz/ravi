import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, closeRouterDb } from "../router/router-db.js";
import { renderSignalsForTurn } from "./render.js";
import { raiseSignal } from "./service.js";
import { setDiskProbeForTests } from "./probes.js";
import { dbGetSignalById, dbUpdateSignal } from "./signal-db.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-render-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
  setDiskProbeForTests(() => ({
    fields: { path: "/", free_pct: 9.2, free_bytes: 9_200_000_000, total_bytes: 100_000_000_000 },
    checkedAt: Date.now(),
  }));
});

afterEach(() => {
  setDiskProbeForTests(null);
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function raiseDisk(now: number, targetSessions = ["test-session"]) {
  return raiseSignal({
    key: "host.disk.free",
    kind: "fact",
    producerId: "signals.watch.disk",
    producerClass: "code",
    producerType: "code",
    scopeType: "fleet",
    scopeId: "fleet",
    targetSessions,
    severity: "piggyback",
    title: "Disk free below 15%",
    detail: "/ has 9.2% free",
    clearWhen: { type: "probe", probe: "host.disk", expr: "free_pct >= 20", recheck_ms: 300_000, grace_ms: 600_000 },
    cooldownMs: 3_600_000,
    maxSurfaces: 3,
    ttlMs: 86_400_000,
    now,
  }).signal;
}

describe("signals render", () => {
  it("adds a fenced block and persists one surface", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(result.surfacedIds).toEqual([signal.id]);
    expect(result.suffix).toContain("<ravi-signals");
    expect(result.suffix).toContain("Disk free below 15%");
    expect(result.suffix).toContain("ravi signals ack");
    expect(dbGetSignalById(signal.id)?.surfaceCount).toBe(1);
  });

  it("does not surface the same signal twice inside cooldown", () => {
    const now = Date.now();
    raiseDisk(now);
    renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    const second = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now: now + 1_000 });
    expect(second.suffix).toBe("");
    expect(second.skipped.some((item) => item.reason === "cooldown")).toBe(true);
  });

  it("resolves when the probe clears after grace", () => {
    const now = Date.now();
    const signal = raiseDisk(now - 20 * 60_000);
    setDiskProbeForTests(() => ({
      fields: { path: "/", free_pct: 25, free_bytes: 25_000_000_000, total_bytes: 100_000_000_000 },
      checkedAt: now,
    }));
    const first = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(first.suffix).toContain("<ravi-signals");
    expect(dbGetSignalById(signal.id)?.state).not.toBe("resolved");
    const second = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now: now + 11 * 60_000 });
    expect(second.suffix).toBe("");
    const record = dbGetSignalById(signal.id);
    expect(record?.state).toBe("resolved");
    expect(record?.closeReason).toBe("probe");
  });

  it("renders unknown, not healthy, on probe error", () => {
    const now = Date.now();
    raiseDisk(now);
    setDiskProbeForTests(() => {
      throw new Error("statfs unavailable");
    });
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(result.suffix).toContain("unknown (probe error)");
    expect(result.suffix).not.toContain("healthy");
  });

  it("clamps a judgment stored above its class ceiling", () => {
    const now = Date.now();
    const { signal } = raiseSignal({
      key: "task.stalled.demo",
      kind: "judgment",
      producerId: "task-observer:test",
      producerClass: "task-observer",
      producerType: "agent",
      scopeType: "fleet",
      scopeId: "fleet",
      targetSessions: ["test-session"],
      severity: "piggyback",
      title: "Task stalled",
      clearWhen: { type: "decay", after_ms: 3_600_000 },
      now,
    });
    const record = dbGetSignalById(signal.id)!;
    record.severity = "interrupt";
    // Direct legacy write, bypassing service validation.
    dbUpdateSignal(record);
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(result.suffix).toContain("| piggyback |");
    expect(dbGetSignalById(signal.id)?.severity).toBe("piggyback");
  });

  it("expires a signal whose ttl elapsed instead of surfacing it", () => {
    const now = Date.now();
    const signal = raiseDisk(now - 2 * 86_400_000);
    const rendered = renderSignalsForTurn({ sessionName: "test-session", sessionKey: "test-session", now });
    expect(rendered.suffix).toBe("");
    expect(dbGetSignalById(signal.id)?.state).toBe("expired");
    expect(dbGetSignalById(signal.id)?.closeReason).toBe("ttl");
  });

  it("reports the last measurement, not now, when no recheck is due", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    const stored = dbGetSignalById(signal.id)!;
    stored.lastEvalAt = now - 60_000;
    stored.lastEvalError = null;
    dbUpdateSignal(stored);
    const later = now + 30_000;
    const rendered = renderSignalsForTurn({ sessionName: "test-session", sessionKey: "test-session", now: later });
    const observed = new Date(now - 60_000).toISOString().slice(11, 16);
    expect(rendered.suffix).toContain(`observed ${observed}Z`);
  });
});
