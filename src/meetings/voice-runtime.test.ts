import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MEETING_VOICE_RUNTIME_ID,
  listMeetingVoiceRuntimeCandidates,
  normalizeMeetingVoiceRuntimeId,
  resolveMeetingVoiceRuntime,
} from "./voice-runtime.js";

describe("meeting voice runtime planning", () => {
  it("defaults live meeting voice to the Ravi native runtime", () => {
    const decision = resolveMeetingVoiceRuntime({ live: true });

    expect(decision).toMatchObject({
      enabled: true,
      runtimeId: DEFAULT_MEETING_VOICE_RUNTIME_ID,
      runnable: false,
      reason: "voice-runtime-planned",
    });
    expect(decision.error).toContain("planned but not wired yet");
    expect(decision.candidate?.availability).toBe("planned");
    expect(decision.candidate?.providerRuntime).toBe("ravi");
  });

  it("keeps aliases stable while preserving a provider-neutral operator surface", () => {
    expect(normalizeMeetingVoiceRuntimeId("voice")).toBe("ravi-native");
    expect(normalizeMeetingVoiceRuntimeId("meet")).toBe("ravi-native");
    expect(normalizeMeetingVoiceRuntimeId("livekit-agents")).toBe("livekit");
    expect(normalizeMeetingVoiceRuntimeId("pipe-cat")).toBe("pipecat");
  });

  it("does not run planned adapters through the current Google Meet path", () => {
    const pipecat = resolveMeetingVoiceRuntime({ live: true, requested: "pipecat" });
    const livekit = resolveMeetingVoiceRuntime({ live: true, requested: "livekit" });

    expect(pipecat).toMatchObject({
      enabled: true,
      runtimeId: "pipecat",
      runnable: false,
      reason: "voice-runtime-planned",
    });
    expect(pipecat.error).toContain("planned but not wired yet");
    expect(livekit).toMatchObject({
      enabled: true,
      runtimeId: "livekit",
      runnable: false,
      reason: "voice-runtime-planned",
    });
  });

  it("lists the three candidate families as planned until the native bridge is wired", () => {
    const candidates = listMeetingVoiceRuntimeCandidates();

    expect(candidates.map((candidate) => candidate.id)).toEqual(["ravi-native", "pipecat", "livekit"]);
    expect(
      candidates.filter((candidate) => candidate.availability === "ready").map((candidate) => candidate.id),
    ).toEqual([]);
  });
});
