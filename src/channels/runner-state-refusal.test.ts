import { describe, expect, it } from "bun:test";
import { StateDatabaseError, StateNotPreparedError } from "../db/state-boundary.js";
import { pauseAfterRunnerStateRefusal, RUNNER_STATE_REFUSAL_PAUSE_MS } from "./runner.js";

describe("channels runner refused by the state guard", () => {
  // Without a pause PM2 restarted a refused runner at once, and every start ran
  // `pm2 jlist` again on a host where that query was already the bottleneck.
  it("pauses under PM2 before exiting, like the daemon's refused entry", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const refusal = new StateDatabaseError("Refusing the real Ravi state database");
    expect(await pauseAfterRunnerStateRefusal(refusal, { pm_id: "3" }, wait)).toBe(true);
    // Wrapped refusals count too.
    expect(
      await pauseAfterRunnerStateRefusal(new Error("start failed", { cause: refusal }), { pm_id: "3" }, wait),
    ).toBe(true);
    expect(waits).toEqual([RUNNER_STATE_REFUSAL_PAUSE_MS, RUNNER_STATE_REFUSAL_PAUSE_MS]);
    expect(RUNNER_STATE_REFUSAL_PAUSE_MS).toBe(30_000);
  });

  it("does not pause outside PM2 or for other errors", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    expect(await pauseAfterRunnerStateRefusal(new StateDatabaseError("refused"), {}, wait)).toBe(false);
    expect(await pauseAfterRunnerStateRefusal(new StateNotPreparedError("not ready"), { pm_id: "3" }, wait)).toBe(
      false,
    );
    expect(await pauseAfterRunnerStateRefusal(new Error("boom"), { pm_id: "3" }, wait)).toBe(false);
    expect(waits).toEqual([]);
  });
});
