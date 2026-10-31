import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbSetSetting, getDb } from "../router/router-db.js";
import { getOrCreateSession, updateSessionName } from "../router/sessions.js";
import { deliverSignalOutboxRow, reserveSignalOob } from "./oob.js";
import { raiseSignal, muteSignal, updateSignal } from "./service.js";
import {
  dbGetSignalById,
  dbGetOutboxRow,
  dbGetTickState,
  dbListSignalSurfaces,
  dbRecordTickRun,
  dbWriteSignalObservation,
  resetSignalSchemaCacheForTests,
} from "./signal-db.js";
import { resolveSignalTargetSessions, signalIsInSessionScope, readSessionSignalContext } from "./subjects.js";
import { tickSignals } from "./tick.js";

let stateDir: string | null = null;
let now: number;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-signals-review-");
  now = Date.now();
  dbSetSetting("signals.enabled", "true");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function page() {
  const signal = raiseSignal({
    key: "review.page",
    kind: "fact",
    producerId: "review",
    scopeType: "install",
    scopeId: "install",
    targetSessions: ["ops"],
    severity: "page",
    title: "Needs attention",
    clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
    now,
  }).signal;
  dbRecordTickRun({ now, tickIntervalMs: 300_000 });
  dbWriteSignalObservation({ signalId: signal.id, observedAt: now });
  return signal;
}

function pending() {
  const signal = page();
  const reservation = reserveSignalOob({
    signal,
    sessionName: "ops",
    routeSeverity: "page",
    freshEvaluation: true,
    now,
  });
  if (!reservation.reserved) throw new Error("reservation failed");
  return { signal, outboxId: reservation.outboxId };
}

describe("signals review regressions", () => {
  it("releases a pending delivery after its target changes", async () => {
    const { signal, outboxId } = pending();
    raiseSignal({ ...signal, targetSessions: ["new-ops"], now: now + 1 });
    let sends = 0;
    const result = await deliverSignalOutboxRow({
      outboxId,
      tickState: dbGetTickState(),
      now: now + 2,
      publishPrompt: async () => {
        sends++;
      },
      sendPage: async () => {
        sends++;
        return "sent";
      },
    });
    expect(sends).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(dbListSignalSurfaces(signal.id)[0]?.status).toBe("failed");
  });

  it("releases a page reservation after a severity downgrade", async () => {
    const { signal, outboxId } = pending();
    updateSignal({ idOrKey: signal.id, severity: "ambient", now: now + 1 });
    let sends = 0;
    await deliverSignalOutboxRow({
      outboxId,
      tickState: dbGetTickState(),
      now: now + 2,
      publishPrompt: async () => {
        sends++;
      },
      sendPage: async () => {
        sends++;
        return "sent";
      },
    });
    expect(sends).toBe(0);
  });

  it("revalidates operator changes between page delivery and prompt publication", async () => {
    const { signal, outboxId } = pending();
    let prompts = 0;
    await deliverSignalOutboxRow({
      outboxId,
      tickState: dbGetTickState(),
      now: now + 2,
      sendPage: async () => {
        muteSignal({ idOrKey: signal.id, forMs: 60_000, now: now + 1 });
        return "sent";
      },
      publishPrompt: async () => {
        prompts++;
      },
    });
    expect(prompts).toBe(0);
    expect(dbGetSignalById(signal.id)?.state).toBe("muted");
    expect(dbGetOutboxRow(outboxId)?.pageStatus).toBe("sent");
  });

  it("claims an outbox row across concurrent drains and publishes typed origin", async () => {
    const { signal, outboxId } = pending();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const payloads: Record<string, unknown>[] = [];
    let pages = 0;
    const input = {
      outboxId,
      tickState: dbGetTickState(),
      now,
      sendPage: async () => {
        pages++;
        started();
        await gate;
        return "sent" as const;
      },
      publishPrompt: async (_session: string, payload: Record<string, unknown>) => {
        payloads.push(payload);
      },
    };
    const first = deliverSignalOutboxRow(input);
    await sending;
    const second = await deliverSignalOutboxRow(input);
    release();
    expect(second.outcome).toBe("skipped");
    expect((await first).outcome).toBe("sent");
    expect(pages).toBe(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?._turnOrigin).toMatchObject({
      producer: "signals",
      action: "escalate",
      principal: { type: "automation", id: `signal:${signal.id}` },
    });
  });

  it("does not advance the successful tick anchor after a failed clear-rule probe", async () => {
    const signal = raiseSignal({
      key: "review.probe",
      kind: "fact",
      producerId: "review",
      scopeType: "install",
      scopeId: "install",
      title: "Probe unavailable",
      clearWhen: { type: "probe", probe: "host.disk", expr: "free_pct >= 20", recheck_ms: 1000, grace_ms: 0 },
      now,
    }).signal;
    dbRecordTickRun({ now: now - 1000, tickIntervalMs: 300_000 });
    const result = await tickSignals({
      execute: true,
      runWatchers: false,
      now,
      probe: () => ({ checkedAt: now, fields: {}, error: "probe failed" }),
    });
    expect(result.errors).toEqual([{ id: signal.id, error: "probe failed" }]);
    expect(dbGetTickState().lastSuccessfulTickAt).toBe(now - 1000);
  });

  it("does not share tick ownership for concurrent calls with the same timestamp", async () => {
    page();
    let unblock!: () => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let pages = 0;
    const deps = {
      execute: true,
      runWatchers: false,
      now,
      sendPage: async () => {
        pages++;
        started();
        await gate;
        return "sent" as const;
      },
      publishPrompt: async () => {},
    };
    const first = tickSignals(deps);
    await sending;
    const second = tickSignals(deps);
    unblock();
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.executed)).toHaveLength(1);
    expect(pages).toBe(1);
  });

  it("pins agent judgments to the caller session instead of another session of the same agent", () => {
    const main = getOrCreateSession("agent:main:main", "main", "/tmp");
    updateSessionName(main.sessionKey, "main");
    const work = getOrCreateSession("agent:main:work", "main", "/tmp");
    updateSessionName(work.sessionKey, "work");
    const signal = raiseSignal({
      key: "review.judgment",
      kind: "judgment",
      producerId: "ignored",
      scopeType: "agent",
      scopeId: "main",
      caller: { isAgent: true, agentId: "main", sessionName: "work" },
      title: "Work context",
      clearWhen: { type: "decay", after_ms: 60_000 },
      now,
    }).signal;
    expect(resolveSignalTargetSessions(signal)).toEqual(["work"]);
    expect(signalIsInSessionScope(signal, readSessionSignalContext("main"))).toBe(false);
  });

  it("uses the same resolved targets for agent-scope render and explain", () => {
    getOrCreateSession("agent:main:main", "main", "/tmp");
    updateSessionName("agent:main:main", "main");
    getOrCreateSession("agent:main:work", "main", "/tmp");
    updateSessionName("agent:main:work", "work");
    const signal = raiseSignal({
      key: "review.agent",
      kind: "fact",
      producerId: "review",
      scopeType: "agent",
      scopeId: "main",
      title: "Main context",
      clearWhen: { type: "producer_resolve", ttl_ms: 60_000 },
      now,
    }).signal;
    expect(resolveSignalTargetSessions(signal)).toEqual(["main"]);
    expect(signalIsInSessionScope(signal, readSessionSignalContext("work"))).toBe(false);
  });

  it("resolves install scope to a real canonical session, never a bare agent id", () => {
    const signal = { ...page(), targetSessions: undefined };
    expect(resolveSignalTargetSessions(signal)).toEqual([]);
    const main = getOrCreateSession("agent:main:main", "main", "/tmp");
    updateSessionName(main.sessionKey, "operator-home");
    expect(resolveSignalTargetSessions(signal)).toEqual(["operator-home"]);
    dbSetSetting("signals.install_session", main.sessionKey);
    expect(resolveSignalTargetSessions(signal)).toEqual(["operator-home"]);
    dbSetSetting("signals.install_session", "missing");
    expect(resolveSignalTargetSessions(signal)).toEqual([]);
  });

  it("migrates cached observations from an existing signal store", () => {
    const signal = page();
    getDb().prepare("DELETE FROM signal_observations WHERE signal_id = ?").run(signal.id);
    getDb()
      .prepare("UPDATE signals SET last_eval_at = ?, last_eval_error = ?, clear_since = ? WHERE id = ?")
      .run(now - 1000, "historical failure", now - 2000, signal.id);
    getDb().prepare("DELETE FROM signal_meta WHERE key = 'observation_cache_migrated'").run();
    resetSignalSchemaCacheForTests();
    const migrated = dbGetSignalById(signal.id)!;
    expect(migrated.lastEvalAt).toBe(now - 1000);
    expect(migrated.lastEvalError).toBe("historical failure");
    expect(migrated.clearSince).toBe(now - 2000);
    getDb().prepare("DELETE FROM signal_observations WHERE signal_id = ?").run(signal.id);
    resetSignalSchemaCacheForTests();
    expect(dbGetSignalById(signal.id)?.lastEvalAt).toBeNull();
  });

  it("invalidates a cached evaluation atomically when evidence changes", () => {
    const signal = page();
    const changed = updateSignal({ idOrKey: signal.id, evidence: { source: "new condition" }, now: now + 1 });
    expect(changed.lastEvalAt).toBeNull();
    expect(dbGetSignalById(signal.id)?.lastEvalAt).toBeNull();
  });

  it("rejects a same-key raise that declares a different scope", () => {
    const signal = page();
    expect(() => raiseSignal({ ...signal, scopeType: "agent", scopeId: "other", now: now + 1 })).toThrow(
      "already belongs to scope",
    );
    expect(dbGetSignalById(signal.id)?.scopeType).toBe("install");
  });
});
