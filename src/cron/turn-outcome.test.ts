import { describe, expect, it } from "bun:test";
import { buildCronTurnOutcomeState, parseCronTurnOutcome, parseRuntimeSessionName } from "./turn-outcome.js";

const cronProvenance = (jobId: string) => ({
  origin: "cron",
  background: true,
  automationOriginated: true,
  automationId: `cron:${jobId}`,
  reason: "prompt._cron",
});

describe("parseRuntimeSessionName", () => {
  it("extracts the session token from runtime subjects", () => {
    expect(parseRuntimeSessionName("ravi.session.main.runtime")).toBe("main");
    expect(parseRuntimeSessionName("ravi.session.main-cron-daily.runtime")).toBe("main-cron-daily");
  });

  it("rejects other subjects", () => {
    expect(parseRuntimeSessionName("ravi.session.main.response")).toBeUndefined();
    expect(parseRuntimeSessionName("ravi.session..runtime")).toBeUndefined();
    expect(parseRuntimeSessionName("ravi.cron.trigger")).toBeUndefined();
  });
});

describe("parseCronTurnOutcome", () => {
  it("ignores non-terminal runtime events", () => {
    for (const type of ["assistant.message", "tool.start", "status", "silent", "text.delta"]) {
      expect(parseCronTurnOutcome({ topic: "ravi.session.main.runtime", data: { type } })).toBeNull();
    }
    expect(parseCronTurnOutcome({ topic: "ravi.session.main.runtime", data: null })).toBeNull();
    expect(parseCronTurnOutcome({ topic: "ravi.session.main.runtime", data: "turn.failed" })).toBeNull();
  });

  it("ignores terminal events on non-runtime subjects", () => {
    expect(parseCronTurnOutcome({ topic: "ravi.session.main.response", data: { type: "turn.failed" } })).toBeNull();
  });

  it("maps a failed cron turn with provider error and provenance", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.attention.runtime",
      data: {
        type: "turn.failed",
        provider: "codex",
        error: "400 The requested model 'gpt-5.3-codex-spark' is not supported.",
        recoverable: true,
        _turnProvenance: cronProvenance("481e4008"),
      },
    });

    expect(outcome).toEqual({
      kind: "failed",
      sessionName: "attention",
      provenance: "cron",
      jobId: "481e4008",
      error: "400 The requested model 'gpt-5.3-codex-spark' is not supported.",
    });
  });

  it("maps a completed cron turn", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: { type: "turn.complete", provider: "claude", _turnProvenance: cronProvenance("dee1d25e") },
    });

    expect(outcome).toMatchObject({ kind: "complete", provenance: "cron", jobId: "dee1d25e" });
    expect(outcome?.error).toBeUndefined();
  });

  it("maps an interrupted cron turn with its reason", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: {
        type: "turn.interrupted",
        reason: "provider_transport_failure",
        _turnProvenance: cronProvenance("dc4a989e"),
      },
    });

    expect(outcome).toMatchObject({
      kind: "interrupted",
      provenance: "cron",
      jobId: "dc4a989e",
      reason: "provider_transport_failure",
    });
  });

  it("reads structured error objects", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: { type: "turn.failed", error: { message: "boom", code: 400 }, _turnProvenance: cronProvenance("j1") },
    });
    expect(outcome?.error).toBe("boom");
  });

  it("truncates very long error strings", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: { type: "turn.failed", error: "x".repeat(5000), _turnProvenance: cronProvenance("j1") },
    });
    expect(outcome?.error?.length).toBeLessThan(2100);
    expect(outcome?.error?.endsWith("... [truncated]")).toBe(true);
  });

  it("marks non-cron provenance as other", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: {
        type: "turn.failed",
        error: "nope",
        _turnProvenance: { origin: "human", background: false, automationOriginated: false, reason: "contact" },
      },
    });
    expect(outcome).toMatchObject({ kind: "failed", provenance: "other" });
    expect(outcome?.jobId).toBeUndefined();
  });

  it("does not treat trigger automation ids as cron jobs", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: {
        type: "turn.complete",
        _turnProvenance: { origin: "trigger", automationId: "trigger:abc", background: true, reason: "x" },
      },
    });
    expect(outcome).toMatchObject({ provenance: "other" });
  });

  it("reports missing provenance for pre-turn failures", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: { type: "turn.failed", error: "Runtime failed to start", recoverable: false },
    });
    expect(outcome).toEqual({
      kind: "failed",
      sessionName: "main",
      provenance: "none",
      error: "Runtime failed to start",
    });
  });

  it("keeps cron provenance without a job id distinguishable", () => {
    const outcome = parseCronTurnOutcome({
      topic: "ravi.session.main.runtime",
      data: { type: "turn.complete", _turnProvenance: { origin: "cron", background: true, reason: "prompt._cron" } },
    });
    expect(outcome).toMatchObject({ provenance: "cron" });
    expect(outcome?.jobId).toBeUndefined();
  });
});

describe("buildCronTurnOutcomeState", () => {
  it("records ok with duration for completed turns", () => {
    expect(buildCronTurnOutcomeState({ kind: "complete" }, { dispatchedAt: 1_000, now: 4_500 })).toEqual({
      lastStatus: "ok",
      lastDurationMs: 3_500,
    });
  });

  it("records error with the runtime error for failed turns", () => {
    expect(
      buildCronTurnOutcomeState({ kind: "failed", error: "400 model not supported" }, { dispatchedAt: 10, now: 20 }),
    ).toEqual({
      lastStatus: "error",
      lastError: "400 model not supported",
      lastDurationMs: 10,
    });
  });

  it("falls back to a generic message when a failure has no error text", () => {
    expect(buildCronTurnOutcomeState({ kind: "failed" })).toMatchObject({
      lastStatus: "error",
      lastError: "Agent turn failed",
    });
    expect(buildCronTurnOutcomeState({ kind: "failed", reason: "first_terminal_won" })).toMatchObject({
      lastError: "Agent turn failed (first_terminal_won)",
    });
  });

  it("records interrupted turns as errors with the reason", () => {
    expect(buildCronTurnOutcomeState({ kind: "interrupted", reason: "provider_interrupted" })).toMatchObject({
      lastStatus: "error",
      lastError: "Agent turn interrupted (provider_interrupted)",
    });
    expect(buildCronTurnOutcomeState({ kind: "interrupted", error: "socket closed" })).toMatchObject({
      lastError: "Agent turn interrupted: socket closed",
    });
  });

  it("omits duration when the dispatch time is unknown", () => {
    const state = buildCronTurnOutcomeState({ kind: "complete" });
    expect(state.lastDurationMs).toBeUndefined();
    expect("lastDurationMs" in state).toBe(false);
  });

  it("never reports a negative duration", () => {
    expect(buildCronTurnOutcomeState({ kind: "complete" }, { dispatchedAt: 5_000, now: 4_000 }).lastDurationMs).toBe(0);
  });
});
