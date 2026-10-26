import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, closeRouterDb } from "../router/router-db.js";
import { tickSignals } from "./tick.js";
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
    scopeType: "fleet",
    scopeId: "fleet",
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
    seedPageSignal(now);
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
      scopeType: "fleet",
      scopeId: "fleet",
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
});
