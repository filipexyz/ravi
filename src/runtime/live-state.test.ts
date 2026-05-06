import { describe, expect, it } from "bun:test";

import {
  clearRuntimeLiveState,
  getRuntimeLiveStateForSession,
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
    clearRuntimeLiveState("dev");
  });

  it("falls back to blocked state for aborted persisted sessions", () => {
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
    });
  });
});
