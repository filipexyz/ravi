import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../router/types.js";
import { buildRuntimeSessionVisibilityPayload } from "./session-visibility.js";
import { clearRuntimeLiveState, updateRuntimeLiveState } from "./live-state.js";
import type { RuntimeSkillVisibilitySnapshot } from "./types.js";

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionKey: "agent:main:visibility",
    name: "visibility",
    agentId: "main",
    agentCwd: "/tmp/ravi",
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function makeSnapshot(id: string, state: "advertised" | "loaded", updatedAt: number): RuntimeSkillVisibilitySnapshot {
  return {
    skills: [
      {
        id,
        provider: "codex",
        state,
        confidence: state === "loaded" ? "observed" : "declared",
        source: "test",
        loadedAt: state === "loaded" ? updatedAt : null,
        lastSeenAt: updatedAt,
      },
    ],
    loadedSkills: state === "loaded" ? [id] : [],
    updatedAt,
  };
}

describe("buildRuntimeSessionVisibilityPayload", () => {
  it("reads persisted skill visibility from runtime session params", () => {
    const session = makeSession({
      runtimeProvider: "codex",
      runtimeSessionParams: {
        skillVisibility: makeSnapshot("persisted-skill", "advertised", 300),
      },
    });

    const payload = buildRuntimeSessionVisibilityPayload(session);

    expect(payload.provider).toBe("codex");
    expect(payload.skills).toEqual([expect.objectContaining({ id: "persisted-skill", state: "advertised" })]);
    expect(payload.loadedSkills).toEqual([]);
    expect(payload.lastUpdatedAt).toBe(300);
  });

  it("prefers live skill visibility over persisted session params", () => {
    const session = makeSession({
      name: "visibility-live",
      runtimeProvider: "codex",
      runtimeSessionParams: {
        skillVisibility: makeSnapshot("persisted-skill", "advertised", 300),
      },
    });

    try {
      updateRuntimeLiveState("visibility-live", {
        activity: "thinking",
        provider: "codex",
        skills: makeSnapshot("live-skill", "loaded", 400).skills,
        loadedSkills: ["live-skill"],
      });

      const payload = buildRuntimeSessionVisibilityPayload(session);

      expect(payload.skills).toEqual([expect.objectContaining({ id: "live-skill", state: "loaded" })]);
      expect(payload.loadedSkills).toEqual(["live-skill"]);
    } finally {
      clearRuntimeLiveState("visibility-live");
    }
  });

  it("prefers newer persisted skill visibility over stale live state", () => {
    const session = makeSession({
      name: "visibility-stale-live",
      runtimeProvider: "codex",
      runtimeSessionParams: {
        skillVisibility: makeSnapshot("persisted-skill", "loaded", Date.now() + 1_000),
      },
    });

    try {
      updateRuntimeLiveState("visibility-stale-live", {
        activity: "idle",
        provider: "codex",
        skills: makeSnapshot("stale-live-skill", "advertised", 300).skills,
        loadedSkills: [],
      });

      const payload = buildRuntimeSessionVisibilityPayload(session);

      expect(payload.skills).toEqual([expect.objectContaining({ id: "persisted-skill", state: "loaded" })]);
      expect(payload.loadedSkills).toEqual(["persisted-skill"]);
    } finally {
      clearRuntimeLiveState("visibility-stale-live");
    }
  });

  it("uses the session update timestamp for an empty visibility snapshot", () => {
    const payload = buildRuntimeSessionVisibilityPayload(
      makeSession({
        name: "visibility-empty",
        updatedAt: 500,
      }),
    );

    expect(payload.skills).toEqual([]);
    expect(payload.loadedSkills).toEqual([]);
    expect(payload.lastUpdatedAt).toBe(500);
  });
});
