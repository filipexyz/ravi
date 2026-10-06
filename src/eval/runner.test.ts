import { describe, expect, it } from "bun:test";
import { type OwnTurnText, readTurnResponse } from "./runner.js";

describe("readTurnResponse", () => {
  it("waits for the transcript to persist this run's reply", async () => {
    const reads: OwnTurnText[] = [
      { readable: true, text: null },
      { readable: true, text: null },
      { readable: true, text: "EVAL_OK" },
    ];
    const text = await readTurnResponse(
      { sessionName: "eval-smoke", historyCursor: 0, readOwnTurnText: () => reads.shift() ?? reads[0]! },
      2_000,
    );
    expect(text).toBe("EVAL_OK");
  });

  it("returns empty instead of falling back to history when the transcript is readable", async () => {
    // History rows after the cursor may belong to a turn that was already
    // running; a readable transcript without text must not reach them.
    const text = await readTurnResponse(
      {
        sessionName: "eval-smoke",
        historyCursor: 0,
        readOwnTurnText: () => ({ readable: true, text: null }),
      },
      150,
    );
    expect(text).toBe("");
  });

  it("keeps waiting for a fresh session's transcript instead of using history", async () => {
    // The daemon emits turn.complete before it persists a new session's
    // runtime session ID, so the transcript appears only a moment later.
    const reads: OwnTurnText[] = [
      { readable: false, pending: true },
      { readable: false, pending: true },
      { readable: true, text: null },
      { readable: true, text: "FRESH_OK" },
    ];
    const text = await readTurnResponse(
      { sessionName: "eval-fresh", historyCursor: 0, readOwnTurnText: () => reads.shift() ?? reads[0]! },
      2_000,
    );
    expect(text).toBe("FRESH_OK");
  });
});
