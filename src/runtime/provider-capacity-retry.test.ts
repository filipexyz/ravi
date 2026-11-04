import { describe, expect, test } from "bun:test";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import {
  decideProviderCapacityRetry,
  PROVIDER_CAPACITY_EXHAUSTED_REASON,
  type ProviderCapacityRetryState,
} from "./provider-capacity-retry.js";

const capacity = classifyRuntimeCredentialFailure({ runtimeProvider: "codex", httpStatus: 503 });

describe("provider capacity retry budget", () => {
  test("retries transient HTTP capacity with exponential equal jitter and stops after three retries", () => {
    let state: ProviderCapacityRetryState | undefined;
    let now = 10_000;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const decision = decideProviderCapacityRetry({ signal: capacity, state, now, random: () => 0.5 });
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") throw new Error("Expected retry");
      delays.push(decision.delayMs);
      state = decision.state;
      now += decision.delayMs;
    }
    expect(delays).toEqual([750, 1_500, 3_000]);
    if (!state) throw new Error("Expected retry budget state");
    expect(decideProviderCapacityRetry({ signal: capacity, state, now })).toEqual({
      action: "exhausted",
      state,
      reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
    });
  });

  test("Retry-After is a floor and cannot exceed the elapsed budget", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      httpStatus: 429,
      headers: { "Retry-After": "12" },
    });
    expect(decideProviderCapacityRetry({ signal, now: 1_000, random: () => 0 })).toEqual({
      action: "retry",
      state: { startedAt: 1_000, retries: 1 },
      delayMs: 12_000,
    });
    expect(decideProviderCapacityRetry({ signal, state: { startedAt: 1_000, retries: 1 }, now: 20_000 }).action).toBe(
      "exhausted",
    );
  });

  test("provider attempt duration consumes the budget, independent of retry count", () => {
    expect(
      decideProviderCapacityRetry({
        signal: capacity,
        state: { startedAt: 1_000, retries: 1 },
        now: 31_000,
      }).action,
    ).toBe("exhausted");
    expect(
      decideProviderCapacityRetry({
        signal: capacity,
        state: { startedAt: 1_000, retries: 1 },
        now: 30_500,
        random: () => 0,
      }).action,
    ).toBe("exhausted");
  });

  test("jitter never schedules an immediate retry", () => {
    for (const sample of [0, 1, -1, 2, Number.NaN]) {
      const decision = decideProviderCapacityRetry({ signal: capacity, now: 0, random: () => sample });
      expect(decision.action).toBe("retry");
      if (decision.action === "retry") {
        expect(decision.delayMs).toBeGreaterThanOrEqual(500);
        expect(decision.delayMs).toBeLessThanOrEqual(1_000);
      }
    }
  });

  test("ordinary 400, authentication, quota and free text do not start capacity retry", () => {
    const inputs = [
      { httpStatus: 400, message: "Invalid request" },
      { httpStatus: 401, message: "Invalid token" },
      { httpStatus: 429, providerCode: "insufficient_quota", message: "Exceeded your current quota" },
      { message: "Selected model is at capacity. Please try a different model." },
      { message: "overloaded" },
    ];
    for (const input of inputs) {
      const signal = classifyRuntimeCredentialFailure({ runtimeProvider: "codex", ...input });
      expect(decideProviderCapacityRetry({ signal })).toEqual({ action: "not_capacity" });
    }
    expect(decideProviderCapacityRetry({ signal: undefined })).toEqual({ action: "not_capacity" });
  });
});
