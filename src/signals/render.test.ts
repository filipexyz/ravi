import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, closeRouterDb } from "../router/router-db.js";
import { commitRenderedSignals, releaseRenderedSignals, renderSignalsForTurn } from "./render.js";
import { listSignals, raiseSignal } from "./service.js";
import { setDiskProbeForTests } from "./probes.js";
import {
  dbGetSignalById,
  dbListSignalEvents,
  dbListSignalSurfaces,
  dbOverwriteSignalForTests,
  dbRecordTickRun,
  dbWriteSignalObservation,
} from "./signal-db.js";

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
    scopeType: "install",
    scopeId: "install",
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

function surfaces(signalId: string) {
  return dbListSignalSurfaces(signalId).map((row) => row.status);
}

describe("signals render", () => {
  it("adds a fenced block, reserves a pending surface and consumes it only on commit", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(result.surfacedIds).toEqual([signal.id]);
    expect(result.suffix).toContain("<ravi-signals");
    expect(result.suffix).toContain("Disk free below 15%");
    expect(result.suffix).toContain("ravi signals ack");
    expect(result.budget.used).toBe(1);
    expect(surfaces(signal.id)).toEqual(["pending"]);
    // A pending reservation consumes nothing.
    expect(dbGetSignalById(signal.id)?.surfaceCount).toBe(0);
    expect(dbGetSignalById(signal.id)?.state).toBe("open");

    commitRenderedSignals(result.reservations, now);
    expect(surfaces(signal.id)).toEqual(["sent"]);
    expect(dbGetSignalById(signal.id)?.surfaceCount).toBe(1);
    expect(dbGetSignalById(signal.id)?.state).toBe("surfaced");
  });

  it("releases the reservation of a turn that never started: no unit, no cooldown", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    const first = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(releaseRenderedSignals(first.reservations, "turn preparation failed", now)).toBe(1);
    expect(surfaces(signal.id)).toEqual(["failed"]);
    expect(dbGetSignalById(signal.id)?.surfaceCount).toBe(0);
    const second = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now: now + 1_000 });
    expect(second.surfacedIds).toEqual([signal.id]);
  });

  it("does not surface the same signal twice inside cooldown", () => {
    const now = Date.now();
    raiseDisk(now);
    const first = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    commitRenderedSignals(first.reservations, now);
    const second = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now: now + 1_000 });
    expect(second.suffix).toBe("");
    expect(second.skipped.some((item) => item.reason === "cooldown")).toBe(true);
  });

  it("never runs a probe on the turn path", () => {
    const now = Date.now();
    raiseDisk(now);
    let probes = 0;
    setDiskProbeForTests(() => {
      probes += 1;
      return { fields: { free_pct: 25 }, checkedAt: now };
    });
    renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(probes).toBe(0);
  });

  it("renders unknown with the stored error and timestamp of a failed evaluation", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    dbWriteSignalObservation({ signalId: signal.id, observedAt: now - 120_000, error: "statfs unavailable" });
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    const at = new Date(now - 120_000).toISOString().slice(11, 16);
    expect(result.suffix).toContain(`status=unknown (probe error at ${at}Z: statfs unavailable)`);
    expect(result.suffix).not.toContain("healthy");
  });

  it("labels a stale observation and still renders it", () => {
    const now = Date.now();
    const signal = raiseDisk(now - 60 * 60_000);
    dbRecordTickRun({ now: now - 30 * 60_000, tickIntervalMs: 5 * 60_000 });
    dbWriteSignalObservation({ signalId: signal.id, observedAt: now - 30 * 60_000 });
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    const observed = new Date(now - 30 * 60_000).toISOString().slice(11, 16);
    expect(result.surfacedIds).toEqual([signal.id]);
    expect(result.suffix).toContain(`status=stale observed ${observed}Z`);
  });

  it("reports the stored observation, not now, when fresh", () => {
    const now = Date.now();
    const signal = raiseDisk(now);
    dbRecordTickRun({ now: now - 60_000, tickIntervalMs: 5 * 60_000 });
    dbWriteSignalObservation({ signalId: signal.id, observedAt: now - 60_000 });
    const later = now + 30_000;
    const rendered = renderSignalsForTurn({ sessionName: "test-session", sessionKey: "test-session", now: later });
    const observed = new Date(now - 60_000).toISOString().slice(11, 16);
    expect(rendered.suffix).toContain(`status=fresh observed ${observed}Z`);
  });

  it("clamps a judgment stored above its class ceiling, with an audited transition", () => {
    const now = Date.now();
    const { signal } = raiseSignal({
      key: "task.stalled.demo",
      kind: "judgment",
      producerId: "task-observer:test",
      producerClass: "task-observer",
      producerType: "agent",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      severity: "piggyback",
      title: "Task stalled",
      clearWhen: { type: "decay", after_ms: 3_600_000 },
      now,
    });
    const record = dbGetSignalById(signal.id)!;
    record.severity = "interrupt";
    // Direct legacy write, bypassing service validation.
    dbOverwriteSignalForTests(record);
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now });
    expect(result.suffix).toContain("| piggyback |");
    expect(dbGetSignalById(signal.id)?.severity).toBe("piggyback");
    expect(
      dbListSignalEvents(signal.id).some((event) => event.type === "signal.ceiling_clamped" && event.version),
    ).toBe(true);
  });

  it("expires a signal whose ttl elapsed instead of surfacing it", () => {
    const now = Date.now();
    const signal = raiseDisk(now - 2 * 86_400_000);
    const rendered = renderSignalsForTurn({ sessionName: "test-session", sessionKey: "test-session", now });
    expect(rendered.suffix).toBe("");
    expect(dbGetSignalById(signal.id)?.state).toBe("expired");
    expect(dbGetSignalById(signal.id)?.closeReason).toBe("ttl");
  });

  it("renders decay as an absolute deadline counted from opened_at", () => {
    const openedAt = Date.parse("2026-10-26T03:00:00.000Z");
    raiseSignal({
      key: "judgment.decay",
      kind: "judgment",
      producerId: "agent:main",
      producerClass: "agent",
      producerType: "agent",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      title: "Contact cooled",
      clearWhen: { type: "decay", after_ms: 72 * 3_600_000 },
      now: openedAt,
    });
    const rendered = renderSignalsForTurn({
      sessionName: "test-session",
      enabled: true,
      now: openedAt + 5 * 3_600_000,
    });
    expect(rendered.suffix).toContain("decay at 2026-10-29T03:00:00.000Z");
  });

  it("accounts every selected signal as surfaced or skipped, and counts only this turn's rows", () => {
    const now = Date.now();
    dbSetSetting("signals.surface_budget_per_day", "2");
    for (let index = 0; index < 5; index += 1) {
      raiseSignal({
        key: `test.many.${index}`,
        kind: "fact",
        producerId: "test.code",
        producerClass: "code",
        producerType: "code",
        scopeType: "install",
        scopeId: "install",
        targetSessions: [index === 4 ? "other-session" : "test-session"],
        title: `Fact ${index}`,
        clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
        now: now + index,
      });
    }
    const result = renderSignalsForTurn({ sessionName: "test-session", enabled: true, now: now + 10 });
    const selected = new Set(listSignals({ state: "non_terminal" }).map((signal) => signal.id));
    const accounted = new Set([...result.surfacedIds, ...result.skipped.map((item) => item.id)]);
    expect(accounted).toEqual(selected);
    expect(result.surfacedIds.length + result.skipped.length).toBe(selected.size);
    expect(result.budget.used).toBe(result.reservations.length);
    expect(result.budget.used).toBe(2);
    expect(result.budget.daily).toBe(2);
    expect(result.skipped.filter((item) => item.reason === "budget")).toHaveLength(2);
    expect(result.skipped.filter((item) => item.reason === "out_of_scope")).toHaveLength(1);
  });
});
