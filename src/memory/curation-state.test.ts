import { describe, expect, it } from "bun:test";
import {
  advanceCurationCounter,
  markCurationMessageProcessed,
  preserveMemoryCurationState,
  readMemoryCurationState,
  writeMemoryCurationState,
} from "./curation-state.js";

describe("readMemoryCurationState (R1 / R1b resume-align)", () => {
  it("returns zero-initialized snapshot with requested cadence when state is absent", () => {
    const state = readMemoryCurationState({ runtimeSessionParams: undefined }, 10);
    expect(state).toEqual({ turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 });
  });

  it("reads existing state from runtimeSessionParams and prefers stored cadence", () => {
    const state = readMemoryCurationState(
      {
        runtimeSessionParams: {
          memoryCuration: { turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 5 },
        },
      },
      10,
    );
    expect(state).toEqual({ turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 5, lastCuratedMessageId: 0 });
  });

  it("R1b: preserved turnCount survives across restarts (state serialized on disk)", () => {
    const serialized = writeMemoryCurationState(
      { runtimeSessionParams: { unrelated: "keep-me" } },
      { turnCount: 3, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 },
    );
    // Simulate persistence + reload
    const reloaded = readMemoryCurationState({ runtimeSessionParams: serialized }, 10);
    expect(reloaded.turnCount).toBe(3);
    expect(reloaded.cadenceTurns).toBe(10);
    expect(serialized.unrelated).toBe("keep-me");
  });

  it("recovers gracefully from malformed stored values", () => {
    const state = readMemoryCurationState(
      {
        runtimeSessionParams: {
          memoryCuration: { turnCount: "not-a-number", lastCuratedTurn: -5, cadenceTurns: 0 },
        },
      },
      10,
    );
    expect(state.turnCount).toBe(0);
    expect(state.lastCuratedTurn).toBe(0);
    expect(state.cadenceTurns).toBe(10);
  });
});

describe("advanceCurationCounter", () => {
  it("does not fire on turns before reaching the cadence multiple", () => {
    let state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 3, lastCuratedMessageId: 0 };
    const fires: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const advanced = advanceCurationCounter(state);
      if (advanced.shouldCurate) {
        fires.push(advanced.next.turnCount);
      }
      state = advanced.next;
    }
    expect(fires).toEqual([3, 6]);
  });

  it("fires exactly once per cadence boundary and never twice at the same turn", () => {
    let state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 2, lastCuratedMessageId: 0 };
    const first = advanceCurationCounter(state);
    expect(first.shouldCurate).toBe(false);
    state = first.next;
    const second = advanceCurationCounter(state);
    expect(second.shouldCurate).toBe(true);
    expect(second.next.turnCount).toBe(2);
    expect(second.next.lastCuratedTurn).toBe(2);
    state = second.next;
    const third = advanceCurationCounter(state);
    expect(third.shouldCurate).toBe(false);
    expect(third.next.turnCount).toBe(3);
  });

  it("resume-aligned: restart mid-cycle keeps cadence phase (fires at turn N, not N + saved)", () => {
    // Session persisted at turn 7 with cadence 10.
    let state = { turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 };
    for (let i = 0; i < 2; i += 1) {
      state = advanceCurationCounter(state).next;
    }
    expect(state.turnCount).toBe(9);
    // Turn 10 fires — NOT turn 17 (the "N+restart-zeroed" bug).
    const fire = advanceCurationCounter(state);
    expect(fire.shouldCurate).toBe(true);
    expect(fire.next.turnCount).toBe(10);
  });

  it("clamps zero or negative cadence to 1 (fire every turn) instead of dividing by zero", () => {
    const state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 0, lastCuratedMessageId: 0 };
    const fire = advanceCurationCounter(state);
    expect(fire.next.cadenceTurns).toBe(1);
    expect(fire.shouldCurate).toBe(true);
  });

  it("never advances lastCuratedMessageId on its own — only markCurationMessageProcessed moves it", () => {
    let state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 2, lastCuratedMessageId: 40 };
    state = advanceCurationCounter(state).next;
    state = advanceCurationCounter(state).next;
    expect(state.lastCuratedMessageId).toBe(40);
  });
});

describe("markCurationMessageProcessed (R27 incremental transcript read)", () => {
  it("advances lastCuratedMessageId so the next cycle only reads messages rows added after it", () => {
    const session = {
      runtimeSessionParams: {
        memoryCuration: { turnCount: 10, lastCuratedTurn: 10, cadenceTurns: 10, lastCuratedMessageId: 0 },
      },
    };
    const nextParams = markCurationMessageProcessed(session, 10, 137);
    const reloaded = readMemoryCurationState({ runtimeSessionParams: nextParams }, 10);
    expect(reloaded.lastCuratedMessageId).toBe(137);
    expect(reloaded.turnCount).toBe(10);
  });

  it("never regresses the watermark (max, not overwrite) if called with a smaller message id", () => {
    const session = {
      runtimeSessionParams: {
        memoryCuration: { turnCount: 20, lastCuratedTurn: 20, cadenceTurns: 10, lastCuratedMessageId: 200 },
      },
    };
    const nextParams = markCurationMessageProcessed(session, 10, 50);
    const reloaded = readMemoryCurationState({ runtimeSessionParams: nextParams }, 10);
    expect(reloaded.lastCuratedMessageId).toBe(200);
  });
});

describe("preserveMemoryCurationState (R1c — runtime must not clobber the cadence counter)", () => {
  it("reproduces the lost-update bug: provider params without memoryCuration would drop the counter", () => {
    // The runtime's turn.complete persist writes provider-authoritative params
    // that never include memoryCuration. This asserts the raw provider params
    // are the clobbering value the fix must guard against.
    const providerParams = { sessionId: "sdk-123", skillVisibility: { loaded: [] } };
    expect(providerParams).not.toHaveProperty("memoryCuration");
  });

  it("carries the hook-owned memoryCuration forward into the runtime's outgoing params", () => {
    const existing = {
      memoryCuration: { turnCount: 5, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 42 },
      skillVisibility: { loaded: ["a"] },
    };
    const incoming = { sessionId: "sdk-123", skillVisibility: { loaded: ["b"] } };
    const merged = preserveMemoryCurationState(existing, incoming);
    // Provider keys survive, and the counter is no longer dropped.
    expect(merged).toMatchObject({ sessionId: "sdk-123" });
    expect(merged?.memoryCuration).toEqual({
      turnCount: 5,
      lastCuratedTurn: 0,
      cadenceTurns: 10,
      lastCuratedMessageId: 42,
    });
    // Round-trips through the reader so cadence keeps accumulating.
    expect(readMemoryCurationState({ runtimeSessionParams: merged }, 10).turnCount).toBe(5);
  });

  it("preserves the counter even when the runtime writes empty/undefined params", () => {
    const existing = {
      memoryCuration: { turnCount: 3, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 },
    };
    const merged = preserveMemoryCurationState(existing, undefined);
    expect(readMemoryCurationState({ runtimeSessionParams: merged }, 10).turnCount).toBe(3);
  });

  it("is a no-op when there is no cadence state to preserve (cold start)", () => {
    const incoming = { sessionId: "sdk-1" };
    expect(preserveMemoryCurationState({ skillVisibility: {} }, incoming)).toBe(incoming);
    expect(preserveMemoryCurationState(undefined, incoming)).toBe(incoming);
  });

  it("does not let a stale/absent incoming counter overwrite the existing one", () => {
    // Provider params never carry memoryCuration, but guard the invariant that
    // the existing (hook-written) value wins over whatever incoming has.
    const existing = {
      memoryCuration: { turnCount: 9, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 },
    };
    const incoming = {
      memoryCuration: { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 10, lastCuratedMessageId: 0 },
    };
    const merged = preserveMemoryCurationState(existing, incoming);
    expect(readMemoryCurationState({ runtimeSessionParams: merged }, 10).turnCount).toBe(9);
  });
});
