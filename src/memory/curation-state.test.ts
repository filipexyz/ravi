import { describe, expect, it } from "bun:test";
import { advanceCurationCounter, readMemoryCurationState, writeMemoryCurationState } from "./curation-state.js";

describe("readMemoryCurationState (R1 / R1b resume-align)", () => {
  it("returns zero-initialized snapshot with requested cadence when state is absent", () => {
    const state = readMemoryCurationState({ runtimeSessionParams: undefined }, 10);
    expect(state).toEqual({ turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 10 });
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
    expect(state).toEqual({ turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 5 });
  });

  it("R1b: preserved turnCount survives across restarts (state serialized on disk)", () => {
    const serialized = writeMemoryCurationState(
      { runtimeSessionParams: { unrelated: "keep-me" } },
      { turnCount: 3, lastCuratedTurn: 0, cadenceTurns: 10 },
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
    let state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 3 };
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
    let state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 2 };
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
    let state = { turnCount: 7, lastCuratedTurn: 0, cadenceTurns: 10 };
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
    const state = { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 0 };
    const fire = advanceCurationCounter(state);
    expect(fire.next.cadenceTurns).toBe(1);
    expect(fire.shouldCurate).toBe(true);
  });
});
