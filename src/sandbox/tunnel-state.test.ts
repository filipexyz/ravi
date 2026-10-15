import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { ensureSandboxSchema } from "./runs-db.js";
import {
  dbClearListenerArmed,
  dbClearTunnelDriftLatch,
  dbGetListenerArmed,
  dbLatchTunnelDrift,
  dbReadTunnelGateState,
  dbRecordTunnelPoll,
  dbSetListenerArmed,
  dbGetTunnelDriftLatch,
  evaluateTunnelGate,
  TUNNEL_POLL_MAX_AGE_MS,
  tunnelDriftLatchFilePath,
  writeTunnelDriftLatchFile,
} from "./tunnel-state.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-tunnel-state-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("tunnel gate state", () => {
  test("evaluateTunnelGate: latch, first poll, freshness", () => {
    const now = 1_000_000;
    expect(evaluateTunnelGate({ latch: null, lastPollAt: null }, now)).toEqual({
      open: false,
      reason: "no_successful_poll",
    });
    expect(evaluateTunnelGate({ latch: null, lastPollAt: now - TUNNEL_POLL_MAX_AGE_MS }, now)).toEqual({ open: true });
    expect(evaluateTunnelGate({ latch: null, lastPollAt: now - TUNNEL_POLL_MAX_AGE_MS - 1 }, now)).toEqual({
      open: false,
      reason: "poll_stale",
    });
    expect(evaluateTunnelGate({ latch: { at: 1, reason: "x" }, lastPollAt: now }, now)).toEqual({
      open: false,
      reason: "drift_latched",
    });
  });

  test("the latch keeps its first cause, drops the last poll and only an explicit clear removes it", () => {
    dbRecordTunnelPoll(500);
    expect(dbReadTunnelGateState()).toEqual({ latch: null, lastPollAt: 500 });
    expect(dbLatchTunnelDrift("config_version", 600)).toEqual({ at: 600, reason: "config_version" });
    expect(dbLatchTunnelDrift("poll_failed", 700)).toEqual({ at: 600, reason: "config_version" });
    expect(dbReadTunnelGateState()).toEqual({ latch: { at: 600, reason: "config_version" }, lastPollAt: null });
    dbClearTunnelDriftLatch();
    expect(dbReadTunnelGateState().latch).toBeNull();
  });

  test("an unparseable latch row still latches (fail closed)", () => {
    ensureSandboxSchema()
      .prepare(
        "INSERT INTO sandbox_listener_state (key, value, updated_at) VALUES ('tunnel.drift_latch', 'garbage', 1)",
      )
      .run();
    expect(dbReadTunnelGateState().latch).toEqual({ at: 0, reason: "unparseable" });
  });

  test("the armed record is cleared only by its owner", () => {
    dbSetListenerArmed({ pid: 4242, port: 7790, at: 1 });
    dbClearListenerArmed(1);
    expect(dbGetListenerArmed()).toEqual({ pid: 4242, port: 7790, at: 1 });
    dbClearListenerArmed(4242);
    expect(dbGetListenerArmed()).toBeNull();
  });

  test("the fallback latch file (~/.ravi/gateway) closes the gate without the row, keeps its first cause, and is cleared with the row", () => {
    const path = tunnelDriftLatchFilePath();
    expect(path).toBe(`${process.env.RAVI_STATE_DIR}/gateway/tunnel-drift.latch`);
    dbRecordTunnelPoll(Date.now());
    writeTunnelDriftLatchFile("config_version", 600);
    writeTunnelDriftLatchFile("poll_failed", 700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state = dbReadTunnelGateState();
    expect(state).toEqual({ latch: { at: 600, reason: "config_version" }, lastPollAt: null });
    expect(evaluateTunnelGate(state, Date.now())).toEqual({ open: false, reason: "drift_latched" });
    expect(dbGetTunnelDriftLatch()).toEqual({ at: 600, reason: "config_version" });

    // A file that does not parse is still a latch.
    writeFileSync(path, "garbage");
    expect(dbReadTunnelGateState().latch).toEqual({ at: 0, reason: "unparseable" });

    dbClearTunnelDriftLatch();
    expect(existsSync(path)).toBe(false);
    expect(dbReadTunnelGateState().latch).toBeNull();
  });
});
