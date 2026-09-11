import { describe, expect, it } from "bun:test";
import {
  buildSkillVisibilitySnapshot,
  isStoredSkillVisibilityCompatible,
  markLoadedFromRaviSkillToolCall,
  mergeSkillVisibilitySnapshots,
  skillNameMatchesAllowlist,
} from "./skill-visibility.js";

describe("skill visibility policy", () => {
  it("matches only canonical names and managed provider aliases", () => {
    expect(skillNameMatchesAllowlist("tiny", ["tiny"])).toBe(true);
    expect(skillNameMatchesAllowlist("ravi-user-skills-tiny", ["tiny"])).toBe(true);
    expect(skillNameMatchesAllowlist("unmanaged-tiny", ["tiny"])).toBe(false);
  });

  it("rejects resume when the stored catalog contains a revoked skill", () => {
    const params = {
      skillVisibility: buildSkillVisibilitySnapshot([
        {
          id: "ravi-user-skills-allowed",
          provider: "codex",
          state: "advertised",
          confidence: "declared",
          lastSeenAt: 1,
        },
        {
          id: "ravi-user-skills-revoked",
          provider: "codex",
          state: "advertised",
          confidence: "declared",
          lastSeenAt: 1,
        },
      ]),
    };

    expect(isStoredSkillVisibilityCompatible(params, ["allowed"])).toBe(false);
    expect(isStoredSkillVisibilityCompatible(params, ["allowed", "revoked"])).toBe(true);
  });

  it("drops stale catalog entries when a provider publishes its current catalog", () => {
    const stored = buildSkillVisibilitySnapshot([
      {
        id: "allowed",
        provider: "codex",
        state: "loaded",
        confidence: "observed",
        loadedAt: 1,
        lastSeenAt: 1,
      },
      {
        id: "revoked",
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        lastSeenAt: 1,
      },
    ]);
    const incoming = buildSkillVisibilitySnapshot([
      {
        id: "allowed",
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        lastSeenAt: 2,
      },
    ]);

    const merged = mergeSkillVisibilitySnapshots(stored, incoming, 2);
    expect(merged.skills.map((skill) => skill.id)).toEqual(["allowed"]);
    expect(merged.loadedSkills).toEqual(["allowed"]);
  });

  it("records a skill delivered through ravi skills show", () => {
    const snapshot = buildSkillVisibilitySnapshot([
      {
        id: "ravi-user-skills-tiny",
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        lastSeenAt: 1,
      },
    ]);

    const loaded = markLoadedFromRaviSkillToolCall(snapshot, {
      provider: "codex",
      toolName: "exec_command",
      toolInput: { command: "ravi skills show ravi-user-skills-tiny --json" },
      output: { skill: { name: "tiny", pluginName: "ravi-user-skills" } },
      now: 2,
    });

    expect(loaded.loadedSkills).toEqual(["ravi-user-skills-tiny"]);
    expect(loaded.skills[0]?.evidence?.at(-1)?.eventType).toBe("ravi.skills.show");
  });
});
