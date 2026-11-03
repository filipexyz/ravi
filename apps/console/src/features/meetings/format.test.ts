import { describe, expect, test } from "bun:test";

import {
  canLeave,
  failureText,
  formatClock,
  formatDuration,
  isActive,
  meetingState,
  meetingSteps,
  meetingTitle,
  refreshInterval,
  retentionMonthOptions,
} from "./format";

const base = { ready: false, joinAt: null, failureReason: null, statusSubCode: null } as const;

describe("meetings format", () => {
  test("every state reads as words with a next step, and never names the vendor", () => {
    expect(meetingState({ ...base, status: "requested", joinAt: "2026-10-14T12:00:00Z" }).label).toBe("Scheduled");
    expect(meetingState({ ...base, status: "requested" }).label).toBe("Starting");
    expect(meetingState({ ...base, status: "waiting_room" })).toMatchObject({ label: "Waiting to be let in", tone: "warn" });
    expect(meetingState({ ...base, status: "recording" })).toMatchObject({ label: "Recording" });
    expect(meetingState({ ...base, status: "ended" }).label).toBe("Processing");
    expect(meetingState({ ...base, status: "done" }).label).toBe("Processing");
    expect(meetingState({ ...base, status: "done", ready: true })).toMatchObject({ label: "Ready", tone: "ok" });
    const failed = meetingState({ ...base, status: "failed", failureReason: "timeout_exceeded_waiting_room" });
    expect(failed).toMatchObject({ label: "No recording", hint: "Nobody let Ravi into the call." });
    for (const status of ["requested", "joining", "waiting_room", "in_call", "recording", "ended", "done", "failed"] as const) {
      const state = meetingState({ ...base, status, failureReason: "some_vendor_code" });
      expect(`${state.label} ${state.hint}`).not.toMatch(/recall|vendor|_/i);
    }
  });

  test("failures map to plain sentences, with a generic fallback", () => {
    expect(failureText("limit_exceeded")).toContain("limits");
    expect(failureText("bot_kicked_from_call")).toBe("Someone removed Ravi from the call.");
    expect(failureText("recording_permission_denied")).toBe("The call's host didn't let Ravi record.");
    expect(failureText("bot_kicked_from_waiting_room")).toBe("Nobody let Ravi into the call.");
    expect(failureText(null)).toBe("Ravi couldn't record this call.");
    expect(failureText("weird_code")).toBe("Ravi couldn't record this call.");
  });

  test("which bots still move and which can leave", () => {
    expect(isActive({ status: "recording", ready: false })).toBe(true);
    expect(isActive({ status: "ended", ready: false })).toBe(true);
    expect(isActive({ status: "done", ready: false })).toBe(true);
    expect(isActive({ status: "done", ready: true })).toBe(false);
    expect(isActive({ status: "failed", ready: false })).toBe(false);
    expect(canLeave({ status: "waiting_room" })).toBe(true);
    expect(canLeave({ status: "ended" })).toBe(false);
  });

  test("durations, clock times and titles", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(12 * 60 + 20)).toBe("12 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(null)).toBeNull();
    expect(formatClock(187)).toBe("03:07");
    expect(formatClock(3729)).toBe("1:02:09");
    expect(formatClock(null)).toBeNull();
    expect(meetingTitle({ title: null, meetingCode: "abc-defg-hij" })).toBe("Meet abc-defg-hij");
    expect(meetingTitle({ title: "Weekly", meetingCode: "abc-defg-hij" })).toBe("Weekly");
  });

  test("the steps say where the bot is, with the failure as a sentence", () => {
    const meeting = {
      ...base,
      createdAt: "2026-10-13T12:00:00Z",
      recordingStartedAt: null,
      endedAt: null,
      maxRecordingSeconds: 14_400,
    };
    const states = (input: Parameters<typeof meetingSteps>[0]) => meetingSteps(input).map((step) => `${step.key}:${step.state}`);
    expect(states({ ...meeting, status: "requested", joinAt: "2026-10-14T12:00:00Z" })).toEqual([
      "sent:done",
      "scheduled:current",
      "join:upcoming",
      "recording:upcoming",
      "processing:upcoming",
    ]);
    const waiting = meetingSteps({ ...meeting, status: "waiting_room" });
    expect(waiting.find((step) => step.state === "current")).toMatchObject({ key: "join", label: "Waiting to be let in" });
    const recording = meetingSteps({ ...meeting, status: "recording", recordingStartedAt: "2026-10-13T12:01:00Z" });
    expect(recording.find((step) => step.state === "current")).toMatchObject({ key: "recording", since: "2026-10-13T12:01:00Z" });
    expect(recording.find((step) => step.key === "recording")?.detail).toContain("4 h 00 min");
    expect(states({ ...meeting, status: "ended", recordingStartedAt: "2026-10-13T12:01:00Z" })).toEqual([
      "sent:done",
      "join:done",
      "recording:done",
      "processing:current",
    ]);
    const failed = meetingSteps({ ...meeting, status: "failed", failureReason: "bot_kicked_from_waiting_room" });
    expect(failed.at(-1)).toMatchObject({ state: "failed", detail: "Nobody let Ravi into the call." });
    for (const step of failed) expect(`${step.label} ${step.detail ?? ""}`).not.toMatch(/recall|_/i);
  });

  test("a bot scheduled for later is looked at rarely until its time nears", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const later = { ...base, status: "requested" as const, joinAt: "2026-10-14T12:00:00Z" };
    expect(refreshInterval(later, now)).toBe(60_000);
    expect(refreshInterval({ ...later, joinAt: "2026-10-13T12:01:00Z" }, now)).toBe(10_000);
    expect(refreshInterval({ ...base, status: "recording" }, now)).toBe(10_000);
    expect(refreshInterval({ ...base, status: "done", ready: true }, now)).toBe(false);
  });
});

describe("retentionMonthOptions", () => {
  test("1 to 36 months, with the current value among them", () => {
    expect(retentionMonthOptions(12)).toEqual([1, 3, 6, 12, 18, 24, 36]);
    expect(retentionMonthOptions(7)).toEqual([1, 3, 6, 7, 12, 18, 24, 36]);
    expect(retentionMonthOptions(99)).toEqual([1, 3, 6, 12, 18, 24, 36]);
  });
});
