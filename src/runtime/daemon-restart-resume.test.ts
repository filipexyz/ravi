import { describe, expect, it } from "bun:test";
import {
  CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY,
  buildDaemonRestartResumePrompt,
  resolveCrashRecoveryRestartResumeDecision,
  resolveCrashRecoveryRestartResumeMode,
} from "./daemon-restart-resume.js";

describe("daemon restart crash-recovery resume mode", () => {
  it("keeps legacy snapshots without live instrumentation compatible", () => {
    expect(resolveCrashRecoveryRestartResumeMode()).toBe("continue");
    expect(resolveCrashRecoveryRestartResumeMode({ reason: "legacy snapshot" })).toBe("continue");
  });

  it("fails closed for invalid or missing mode on an instrumented live snapshot", () => {
    expect(
      resolveCrashRecoveryRestartResumeMode({
        live: true,
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "unknown",
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: null,
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: undefined,
      }),
    ).toBe("skip");
  });

  it("accepts only the three explicit modes", () => {
    for (const mode of ["continue", "pending_only", "skip"] as const) {
      expect(
        resolveCrashRecoveryRestartResumeMode({
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: mode,
        }),
      ).toBe(mode);
    }
  });

  it("never builds a prompt for skip mode", () => {
    expect(
      buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-test",
        reason: "test",
        sessionKey: "session-test",
        mode: "skip",
      }),
    ).toBeNull();
  });

  it("fails closed when the caller snapshot is missing or outside resume eligibility", () => {
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        metadata: { [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue" },
        snapshotPresent: true,
        snapshotEligible: false,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "ineligible_snapshot" });
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        snapshotPresent: false,
        snapshotEligible: false,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "missing_snapshot" });
  });
});
