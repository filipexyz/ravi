import { describe, expect, it } from "bun:test";

import {
  clearRuntimeLiveState,
  getRuntimeLiveState,
  getRuntimeLiveStateForSession,
  isRuntimeLiveBusy,
  markRuntimeLiveIdle,
  updateRuntimeLiveState,
} from "./live-state.js";
import type { SessionEntry } from "../router/types.js";

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionKey: "agent:dev:main",
    name: "dev",
    agentId: "dev",
    agentCwd: "/tmp/dev",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("runtime live-state", () => {
  it("returns live state by session name", () => {
    clearRuntimeLiveState("dev");
    updateRuntimeLiveState("dev", {
      activity: "thinking",
      summary: "running",
      agentId: "dev",
      provider: "codex",
      model: "gpt-5",
    });

    expect(getRuntimeLiveStateForSession(makeSession())).toMatchObject({
      activity: "thinking",
      summary: "running",
      agentId: "dev",
      provider: "codex",
      model: "gpt-5",
    });

    markRuntimeLiveIdle("dev");
    expect(getRuntimeLiveStateForSession(makeSession())?.activity).toBe("idle");
    expect(getRuntimeLiveState("dev")?.busySince).toBeUndefined();
    expect(getRuntimeLiveState("dev")?.toolName).toBeUndefined();
    clearRuntimeLiveState("dev");
  });

  it("clears busySince and toolName when a turn returns to idle", () => {
    clearRuntimeLiveState("dev");
    updateRuntimeLiveState("dev", {
      activity: "thinking",
      summary: "bash running",
      toolName: "bash",
    });
    expect(getRuntimeLiveState("dev")?.busySince).toBeDefined();
    expect(getRuntimeLiveState("dev")?.toolName).toBe("bash");

    const idle = markRuntimeLiveIdle("dev", "turn complete");
    expect(idle).toMatchObject({
      activity: "idle",
      summary: "turn complete",
    });
    expect(idle.busySince).toBeUndefined();
    expect(idle.toolName).toBeUndefined();
    expect(getRuntimeLiveState("dev")?.busySince).toBeUndefined();
    expect(getRuntimeLiveState("dev")?.toolName).toBeUndefined();
    clearRuntimeLiveState("dev");
  });

  it("treats blocked as not busy and does not attach busySince", () => {
    clearRuntimeLiveState("dev");
    updateRuntimeLiveState("dev", {
      activity: "thinking",
      summary: "bash running",
      toolName: "bash",
    });

    const blocked = updateRuntimeLiveState("dev", {
      activity: "blocked",
      summary: "turn failed",
    });

    expect(isRuntimeLiveBusy("blocked")).toBe(false);
    expect(isRuntimeLiveBusy("thinking")).toBe(true);
    expect(blocked).toMatchObject({
      activity: "blocked",
      summary: "turn failed",
    });
    expect(blocked.busySince).toBeUndefined();
    expect(blocked.toolName).toBeUndefined();
    clearRuntimeLiveState("dev");
  });

  it("falls back to blocked-but-not-busy for aborted persisted sessions", () => {
    const live = getRuntimeLiveStateForSession(
      makeSession({
        name: "aborted-session",
        sessionKey: "agent:dev:aborted",
        abortedLastRun: true,
        updatedAt: 3_000,
      }),
    );

    expect(live).toMatchObject({
      activity: "blocked",
      summary: "last run aborted",
      updatedAt: 3_000,
      agentId: "dev",
    });
    expect(live?.busySince).toBeUndefined();
    expect(isRuntimeLiveBusy(live!.activity)).toBe(false);
  });
});
