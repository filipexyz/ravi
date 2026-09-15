import { describe, expect, it } from "bun:test";
import {
  buildSkillVisibilitySnapshot,
  extractRequestedSkillFromCommandLine,
  extractRequestedSkillFromToolCall,
  extractSkillNameFromFilesystemPath,
  filterSkillNamesByAllowlist,
  isSkillNameAuthorizedOnAllowlist,
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
    expect(skillNameMatchesAllowlist("ravi-user-skills-sessions", ["sessions", "ravi-system-sessions"])).toBe(true);
    expect(skillNameMatchesAllowlist("ravi-system-sessions", ["sessions", "ravi-system-sessions"])).toBe(true);
  });

  it("selects one provider alias per logical skill and falls back when the canonical alias is absent", () => {
    expect(
      filterSkillNamesByAllowlist(
        [
          "ravi-user-skills-sessions",
          "ravi-system-sessions",
          "ravi-user-skills-skill-creator",
          "ravi-user-skills-building-ravi-apps",
          "ravi-user-skills-tiny",
        ],
        ["sessions", "ravi-system-sessions", "skill-creator", "ravi-system-skill-creator", "building-ravi-apps"],
      ),
    ).toEqual(["ravi-system-sessions", "ravi-user-skills-skill-creator", "ravi-user-skills-building-ravi-apps"]);
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

  it("maps a bare CLI skill result back to its advertised provider alias", () => {
    const snapshot = buildSkillVisibilitySnapshot([
      {
        id: "ravi-user-skills-building-ravi-apps",
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        lastSeenAt: 1,
      },
    ]);

    const loaded = markLoadedFromRaviSkillToolCall(snapshot, {
      provider: "codex",
      toolName: "shell",
      toolInput: { command: "ravi skills show building-ravi-apps --json" },
      output: { skill: { name: "building-ravi-apps", source: "codex" } },
      now: 2,
    });

    expect(loaded.loadedSkills).toEqual(["ravi-user-skills-building-ravi-apps"]);
  });
});

describe("skill invocation extraction", () => {
  it("extracts dedicated Skill tool names and ravi skills show commands", () => {
    expect(extractRequestedSkillFromToolCall("Skill", { skill: "ravi-system-image" })).toBe("ravi-system-image");
    expect(extractRequestedSkillFromToolCall("skills_show", { name: "tiny" })).toBe("tiny");
    expect(extractRequestedSkillFromCommandLine("ravi skills show ravi-user-skills-tiny --json")).toBe(
      "ravi-user-skills-tiny",
    );
  });

  it("extracts a skill from Read/Edit of skills/<name>/SKILL.md and ignores ordinary files", () => {
    expect(extractSkillNameFromFilesystemPath("/tmp/plugins/ravi-system/skills/whatsapp-manager/SKILL.md")).toBe(
      "whatsapp-manager",
    );
    expect(
      extractRequestedSkillFromToolCall("Read", {
        path: "/workspace/src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md",
      }),
    ).toBe("app-creator");
    expect(extractRequestedSkillFromToolCall("Read", { path: "README.md" })).toBeNull();
    expect(extractRequestedSkillFromCommandLine("cat /tmp/plugins/ravi-system/skills/image/SKILL.md")).toBe("image");
  });

  it("matches catalog aliases when checking a path-derived skill against an allowlist", () => {
    expect(isSkillNameAuthorizedOnAllowlist("app-creator", ["ravi-dev-app-creator"])).toBe(true);
    expect(isSkillNameAuthorizedOnAllowlist("whatsapp-manager", ["ravi-dev-app-creator"])).toBe(false);
  });
});
