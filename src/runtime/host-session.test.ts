import { describe, expect, it } from "bun:test";
import { isExplicitLocalRuntimeAbort, isProviderEndedAfterCompletedTools } from "./host-session.js";

describe("isProviderEndedAfterCompletedTools", () => {
  it("recovers after tools and materialized output even when the host labeled provider_interrupted", () => {
    expect(
      isProviderEndedAfterCompletedTools(
        { internalAbortReason: "provider_interrupted", toolRunning: false },
        { startedTool: true, materializedOutput: true },
      ),
    ).toBe(true);
  });

  it("does not recover an explicit local abort after tools", () => {
    expect(isExplicitLocalRuntimeAbort("explicit_abort")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("explicit_abort_deferred")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("crash_recovery_ownership_lost")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("provider_interrupted")).toBe(false);
    expect(
      isProviderEndedAfterCompletedTools(
        { internalAbortReason: "explicit_abort", toolRunning: false },
        { startedTool: true, materializedOutput: true },
      ),
    ).toBe(false);
  });

  it("recovers a completed-tool turn without materialized text when there is no local abort", () => {
    expect(
      isProviderEndedAfterCompletedTools({ toolRunning: false }, { startedTool: true, materializedOutput: false }),
    ).toBe(true);
  });

  it("does not report intentional steering after completed tools as provider failure", () => {
    for (const materializedOutput of [false, true]) {
      expect(
        isProviderEndedAfterCompletedTools(
          { toolRunning: false, currentTurnSuperseded: true },
          { startedTool: true, materializedOutput },
        ),
      ).toBe(false);
    }
  });

  it("does not recover text-only interrupts", () => {
    expect(
      isProviderEndedAfterCompletedTools({ toolRunning: false }, { startedTool: false, materializedOutput: true }),
    ).toBe(false);
  });
});
