import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, closeRouterDb } from "../router/router-db.js";
import { tickSignals } from "./tick.js";
import {
  dbGetSignalById,
  dbGetTickState,
  dbListPendingOutbox,
  dbListSignalEvents,
  dbListSignalSurfaces,
  dbRecordTickRun,
  dbReserveSignalSurface,
  dbWriteSignalObservation,
} from "./signal-db.js";
import { ackSignal, muteSignal } from "./service.js";
import { raiseSignal } from "./service.js";
import { setDiskProbeForTests } from "./probes.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-tick-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
});

afterEach(() => {
  setDiskProbeForTests(null);
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function seedPageSignal(now: number) {
  return raiseSignal({
    key: "daemon.test",
    kind: "fact",
    producerId: "test.code",
    producerClass: "code",
    producerType: "code",
    scopeType: "install",
    scopeId: "install",
    targetSessions: ["test-session"],
    severity: "page",
    title: "Daemon is down",
    detail: "test condition",
    clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
    cooldownMs: 3_600_000,
    renotifyAfterMs: 60_000,
    escalateAfterMs: 0,
    maxSurfaces: 3,
    ttlMs: 86_400_000,
    now,
  }).signal;
}

describe("signals tick", () => {
  it("is a dry run by default", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    dbRecordTickRun({ now: now - 60_000, tickIntervalMs: 5 * 60_000 });
    dbWriteSignalObservation({ signalId: signal.id, observedAt: now - 60_000 });
    let pages = 0;
    let prompts = 0;
    const result = await tickSignals({
      now,
      runWatchers: false,
      publishPrompt: async () => {
        prompts += 1;
      },
      sendPage: async () => {
        pages += 1;
        return "sent";
      },
    });
    expect(result.executed).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(pages).toBe(0);
    expect(prompts).toBe(0);
    expect(dbListSignalSurfaces(signal.id)).toHaveLength(0);
  });

  it("delivers one page line and one prompt on execute", async () => {
    const now = Date.now();
    seedPageSignal(now);
    let pages = 0;
    let prompts = 0;
    const result = await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {
        prompts += 1;
      },
      sendPage: async () => {
        pages += 1;
        return "sent";
      },
    });
    expect(result.executed).toBe(true);
    expect(result.escalated).toBe(1);
    expect(pages).toBe(1);
    expect(prompts).toBe(1);
  });

  it("does not repeat inside cooldown", async () => {
    const now = Date.now();
    seedPageSignal(now);
    const deps = {
      runWatchers: false,
      publishPrompt: async () => {},
      sendPage: async () => "sent" as const,
    };
    await tickSignals({ ...deps, now, execute: true });
    const second = await tickSignals({ ...deps, now: now + 60_000, execute: true });
    expect(second.escalated).toBe(0);
    expect(second.candidates).toHaveLength(0);
  });

  it("escalates a piggyback fact as a nudge instead of ignoring its timeout", async () => {
    const now = Date.now();
    raiseSignal({
      key: "test.piggyback-escalation",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      severity: "piggyback",
      title: "Piggyback fact due",
      clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
      escalateAfterMs: 0,
      now,
    });
    let payload: Record<string, unknown> | undefined;
    const result = await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async (_session, next) => {
        payload = next;
      },
      sendPage: async () => "sent",
    });
    expect(result.escalated).toBe(1);
    expect(payload?.deliveryBarrier).toBe("after_response");
    expect((payload?._signal as { severity?: string } | undefined)?.severity).toBe("nudge");
  });

  it("raises a disk signal from the watcher and clears it after grace", async () => {
    const now = Date.now();
    let value = 9.2;
    setDiskProbeForTests(() => ({
      fields: { path: "/", free_pct: value, free_bytes: 9_200_000_000, total_bytes: 100_000_000_000 },
      checkedAt: now,
    }));
    let pages = 0;
    const deps = {
      publishPrompt: async () => {},
      sendPage: async () => {
        pages += 1;
        return "sent" as const;
      },
    };
    const first = await tickSignals({ ...deps, now, execute: true });
    expect(first.watchers[0]?.raised).toBe(true);
    expect(pages).toBe(1);

    value = 25;
    const second = await tickSignals({ ...deps, now: now + 11 * 60_000, execute: true });
    expect(second.resolved).toBe(0);
    const third = await tickSignals({ ...deps, now: now + 22 * 60_000, execute: true });
    expect(third.resolved).toBe(1);
    expect(pages).toBe(1);
  });

  it("does not escalate on a stale observation, and says why", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now - 60 * 60_000);
    // Last successful tick 30 min ago: more than 2 × the 5 min interval.
    dbRecordTickRun({ now: now - 30 * 60_000, tickIntervalMs: 5 * 60_000 });
    dbWriteSignalObservation({ signalId: signal.id, observedAt: now - 30 * 60_000 });
    const result = await tickSignals({ now, runWatchers: false });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toEqual([{ id: signal.id, sessionName: "test-session", reason: "stale" }]);
  });

  it("does not escalate when the last evaluation failed", async () => {
    const now = Date.now();
    raiseSignal({
      key: "probe.error",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      severity: "page",
      title: "Disk",
      clearWhen: { type: "probe", probe: "host.disk", expr: "free_pct >= 20", recheck_ms: 60_000, grace_ms: 0 },
      escalateAfterMs: 0,
      now,
    });
    setDiskProbeForTests(() => {
      throw new Error("statfs unavailable");
    });
    let prompts = 0;
    const result = await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {
        prompts += 1;
      },
      sendPage: async () => "sent",
    });
    expect(prompts).toBe(0);
    expect(result.skipped[0]?.reason).toBe("unknown");
    expect(result.resolved).toBe(0);
  });

  it("with signals.oob_enabled=false sends no OOB", async () => {
    const now = Date.now();
    seedPageSignal(now);
    dbSetSetting("signals.oob_enabled", "false");
    let prompts = 0;
    const result = await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {
        prompts += 1;
      },
    });
    expect(prompts).toBe(0);
    expect(result.skipped[0]?.reason).toBe("oob_disabled");
  });

  it("holds a due nudge when the daily budget is exhausted", async () => {
    const now = Date.now();
    dbSetSetting("signals.surface_budget_per_day", "1");
    raiseSignal({
      key: "test.nudge.one",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      severity: "nudge",
      title: "First nudge",
      clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
      escalateAfterMs: 0,
      now,
    });
    const deps = { runWatchers: false, publishPrompt: async () => {} };
    const first = await tickSignals({ ...deps, now, execute: true });
    expect(first.escalated).toBe(1);
    raiseSignal({
      key: "test.nudge.two",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["test-session"],
      severity: "nudge",
      title: "Second nudge",
      clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
      escalateAfterMs: 0,
      now: now + 1_000,
    });
    let prompts = 0;
    const second = await tickSignals({
      runWatchers: false,
      now: now + 2_000,
      execute: true,
      publishPrompt: async () => {
        prompts += 1;
      },
    });
    expect(prompts).toBe(0);
    expect(second.skipped.some((item) => item.reason === "budget")).toBe(true);
  });

  it("lets a fresh page fact bypass the budget, audited", async () => {
    const now = Date.now();
    dbSetSetting("signals.surface_budget_per_day", "1");
    dbSetSetting("signals.oob_budget_per_day", "1");
    const signal = seedPageSignal(now);
    const result = await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {},
      sendPage: async () => "sent",
    });
    expect(result.escalated).toBe(1);
    expect(dbListSignalSurfaces(signal.id)[0]?.budgetBypass).toBe(true);
    expect(dbListSignalEvents(signal.id).some((event) => event.type === "signal.budget_bypass")).toBe(true);
  });

  it("keeps a failed publish pending under the same key, then fails it and returns the unit", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    const keys: string[] = [];
    const failing = async (_session: string, _payload: Record<string, unknown>, options?: { messageId?: string }) => {
      keys.push(options?.messageId ?? "");
      throw new Error("nats down");
    };
    const deps = { runWatchers: false, publishPrompt: failing, sendPage: async () => "sent" as const };
    const first = await tickSignals({ ...deps, now, execute: true });
    expect(first.escalated).toBe(0);
    expect(first.outbox.retried).toBe(1);
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["pending"]);
    expect(dbGetSignalById(signal.id)?.surfaceCount).toBe(0);
    expect(dbGetSignalById(signal.id)?.state).toBe("open");

    await tickSignals({ ...deps, now: now + 60_000, execute: true });
    await tickSignals({ ...deps, now: now + 120_000, execute: true });
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed"]);
    expect(dbListPendingOutbox()).toHaveLength(0);
    expect(dbGetSignalById(signal.id)?.escalationCount).toBe(0);
  });

  it("releases a reservation the operator muted while it waited", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    const deps = {
      runWatchers: false,
      publishPrompt: async () => {
        throw new Error("nats down");
      },
      sendPage: async () => "sent" as const,
    };
    await tickSignals({ ...deps, now, execute: true });
    muteSignal({ idOrKey: signal.id, forMs: 3_600_000, now: now + 1_000 });
    let prompts = 0;
    const second = await tickSignals({
      runWatchers: false,
      now: now + 60_000,
      execute: true,
      publishPrompt: async () => {
        prompts += 1;
      },
    });
    expect(prompts).toBe(0);
    expect(second.outbox.failed).toBe(1);
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed"]);
  });

  it("holds a piggyback reservation while an OOB delivery of the same signal is pending", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    await tickSignals({
      runWatchers: false,
      now,
      execute: true,
      publishPrompt: async () => {
        throw new Error("nats down");
      },
      sendPage: async () => "sent" as const,
    });
    const current = dbGetSignalById(signal.id)!;
    const outcome = dbReserveSignalSurface({
      signalId: current.id,
      expectedVersion: current.version,
      route: "piggyback",
      severity: "piggyback",
      sessionName: "test-session",
      idempotencyKey: () => "piggyback-during-oob",
      decide: () => ({ ok: true }),
      actorId: "test",
      now: now + 1_000,
    });
    expect(outcome).toEqual({ skipped: "pending" });
  });

  it("never resends a delivered page line and stops recreating an exhausted delivery", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    let pages = 0;
    const keys = new Set<string>();
    const deps = {
      runWatchers: false,
      publishPrompt: async (_session: string, _payload: Record<string, unknown>, options?: { messageId?: string }) => {
        keys.add(options?.messageId ?? "");
        throw new Error("nats down");
      },
      sendPage: async () => {
        pages += 1;
        return "sent" as const;
      },
    };
    for (let tick = 0; tick < 15; tick += 1) {
      await tickSignals({ ...deps, now: now + tick * 61_000, execute: true });
    }
    expect(pages).toBe(1);
    // At most MAX_ESCALATIONS_PER_EPISODE delivery rows, each failed after its attempts.
    expect(keys.size).toBe(3);
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
    const last = await tickSignals({ ...deps, now: now + 16 * 61_000, execute: true });
    expect(last.skipped.map((item) => item.reason)).toContain("escalation_cap");
  });

  it("releases a pending retry once the operator disables OOB", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    const failing = {
      runWatchers: false,
      publishPrompt: async () => {
        throw new Error("nats down");
      },
      sendPage: async () => "sent" as const,
    };
    await tickSignals({ ...failing, now, execute: true });
    dbSetSetting("signals.oob_enabled", "false");
    let prompts = 0;
    const second = await tickSignals({
      runWatchers: false,
      now: now + 60_000,
      execute: true,
      publishPrompt: async () => {
        prompts += 1;
      },
    });
    expect(prompts).toBe(0);
    expect(second.outbox.failed).toBe(1);
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed"]);
  });

  it("releases a pending retry the operator acknowledged, and keeps the ack", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    await tickSignals({
      runWatchers: false,
      now,
      execute: true,
      publishPrompt: async () => {
        throw new Error("nats down");
      },
      sendPage: async () => "sent" as const,
    });
    ackSignal({ idOrKey: signal.id, now: now + 1_000 });
    let prompts = 0;
    await tickSignals({
      runWatchers: false,
      now: now + 30_000,
      execute: true,
      publishPrompt: async () => {
        prompts += 1;
      },
    });
    expect(prompts).toBe(0);
    expect(dbGetSignalById(signal.id)?.state).toBe("acknowledged");
  });

  it("derives escalation_count from the sent OOB rows", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    await tickSignals({
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {},
      sendPage: async () => "sent",
    });
    const stored = dbGetSignalById(signal.id)!;
    const sentOob = dbListSignalSurfaces(signal.id).filter(
      (row) => row.status === "sent" && row.route !== "piggyback",
    ).length;
    expect(stored.escalationCount).toBe(sentOob);
    expect(stored.escalationCount).toBe(1);
    expect(stored.state).toBe("surfaced");
  });

  it("escalates at most once across two concurrent ticks", async () => {
    const now = Date.now();
    seedPageSignal(now);
    let prompts = 0;
    const deps = {
      now,
      execute: true,
      runWatchers: false,
      publishPrompt: async () => {
        prompts += 1;
      },
      sendPage: async () => "sent" as const,
    };
    await Promise.all([tickSignals(deps), tickSignals(deps)]);
    expect(prompts).toBe(1);
  });

  it("advances the freshness anchor only on a tick without error and persists stale_after", async () => {
    const now = Date.now();
    await tickSignals({ now, execute: true, runWatchers: false });
    expect(dbGetTickState().lastSuccessfulTickAt).toBe(now);
    expect(dbGetTickState().staleAfterMs).toBe(10 * 60_000);
    expect(dbGetTickState().staleAfterSource).toBe("default");

    setDiskProbeForTests(() => {
      throw new Error("statfs unavailable");
    });
    const failed = await tickSignals({ now: now + 300_000, execute: true });
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(dbGetTickState().lastSuccessfulTickAt).toBe(now);
    expect(dbGetTickState().lastTickAt).toBe(now + 300_000);

    dbSetSetting("signals.stale_after_ms", "900000");
    setDiskProbeForTests(null);
    await tickSignals({ now: now + 600_000, execute: true, runWatchers: false });
    expect(dbGetTickState().staleAfterMs).toBe(900_000);
    expect(dbGetTickState().staleAfterSource).toBe("setting");
  });

  it("records the evaluation in the observation cache, not on the record version", async () => {
    const now = Date.now();
    const signal = seedPageSignal(now);
    dbSetSetting("signals.oob_enabled", "false");
    await tickSignals({ now, execute: true, runWatchers: false });
    const stored = dbGetSignalById(signal.id)!;
    expect(stored.lastEvalAt).toBe(now);
    expect(stored.version).toBe(signal.version);
  });
});
