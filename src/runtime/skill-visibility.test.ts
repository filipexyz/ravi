import { describe, expect, it } from "bun:test";
import {
  buildSkillVisibilitySnapshot,
  diffLoadedSkills,
  extractRequestedSkillsFromCommandLine,
  extractRequestedSkillsFromToolCall,
  extractSkillNameFromFilesystemPath,
  filterSkillNamesByAllowlist,
  isSkillNameAuthorizedOnAllowlist,
  isStoredSkillVisibilityCompatible,
  logicalSkillKey,
  markLoadedFromRaviSkillToolCall,
  markLoadedFromSkillGate,
  mergeSkillVisibilitySnapshots,
  readSkillVisibilityFromParams,
  resetLoadedSkillVisibilitySnapshot,
  skillIdentifiersMatch,
  skillNameMatchesAllowlist,
} from "./skill-visibility.js";
import type { RuntimeSkillVisibilitySnapshot } from "./types.js";

/** Claude and Pi advertise plugin skills by frontmatter name, not by gate alias. */
function claudeCatalog(now: number): RuntimeSkillVisibilitySnapshot {
  return buildSkillVisibilitySnapshot(
    [
      {
        id: "routes-manager",
        provider: "claude",
        state: "advertised",
        confidence: "declared",
        source: "plugin:ravi-system/routes",
        lastSeenAt: now,
      },
      { id: "sessions", provider: "claude", state: "advertised", confidence: "declared", lastSeenAt: now },
    ],
    now,
  );
}

describe("skill visibility policy", () => {
  it("matches only canonical names and managed provider aliases", () => {
    expect(skillNameMatchesAllowlist("tiny", ["tiny"])).toBe(true);
    expect(skillNameMatchesAllowlist("ravi-user-skills-tiny", ["tiny"])).toBe(true);
    expect(skillNameMatchesAllowlist("unmanaged-tiny", ["tiny"])).toBe(false);
    expect(skillNameMatchesAllowlist("ravi-user-skills-sessions", ["sessions", "ravi-system-sessions"])).toBe(true);
    expect(skillNameMatchesAllowlist("ravi-system-sessions", ["sessions", "ravi-system-sessions"])).toBe(true);
  });

  it("reduces managed plugin aliases to one logical skill key", () => {
    expect(logicalSkillKey("pages")).toBe("pages");
    expect(logicalSkillKey("ravi-system-pages")).toBe("pages");
    expect(logicalSkillKey("ravi-user-skills-pages")).toBe("pages");
    expect(logicalSkillKey("ravi-dev-app-creator")).toBe("app-creator");
    expect(logicalSkillKey("Ravi-System-Cron-Manager")).toBe("cron-manager");
    expect(logicalSkillKey("acme-pages")).toBe("acme-pages");
    expect(logicalSkillKey("ravi-system-")).toBe("ravi-system");
  });

  it("matches skill identifiers across plugin short ids and catalog aliases", () => {
    expect(skillIdentifiersMatch("pages", "pages")).toBe(true);
    expect(skillIdentifiersMatch("pages", "ravi-system-pages")).toBe(true);
    expect(skillIdentifiersMatch("ravi-system-pages", "pages")).toBe(true);
    expect(skillIdentifiersMatch("ravi-system-sessions", "ravi-user-skills-sessions")).toBe(true);
    expect(skillIdentifiersMatch("tasks", "ravi-system-tasks-eval")).toBe(false);
    expect(skillIdentifiersMatch("acme-pages", "pages")).toBe(false);
  });

  it("marks the advertised short id when the gate names the catalog alias", () => {
    const snapshot = buildSkillVisibilitySnapshot(
      [
        {
          id: "pages",
          provider: "claude",
          state: "advertised",
          confidence: "declared",
          source: "plugin:ravi-system/pages",
          lastSeenAt: 1,
        },
        {
          id: "image",
          provider: "claude",
          state: "advertised",
          confidence: "declared",
          source: "plugin:ravi-system/image",
          lastSeenAt: 1,
        },
      ],
      1,
    );

    const loaded = markLoadedFromSkillGate(snapshot, {
      provider: "claude",
      skill: "ravi-system-pages",
      source: "catalog:ravi-system/pages",
      toolName: "pages_ship",
      now: 2,
    });

    expect(loaded.skills.map((skill) => skill.id)).toEqual(["image", "pages"]);
    expect(loaded.loadedSkills).toEqual(["pages"]);
    expect(loaded.skills.find((skill) => skill.id === "pages")?.evidence?.at(-1)?.kind).toBe("skill-gate");
  });

  it("prefers the exact gate id over an alias and still appends unknown skills", () => {
    const snapshot = buildSkillVisibilitySnapshot(
      [
        { id: "pages", provider: "codex", state: "advertised", confidence: "declared", lastSeenAt: 1 },
        { id: "ravi-system-pages", provider: "codex", state: "advertised", confidence: "declared", lastSeenAt: 1 },
      ],
      1,
    );

    const exact = markLoadedFromSkillGate(snapshot, { provider: "codex", skill: "ravi-system-pages", now: 2 });
    expect(exact.loadedSkills).toEqual(["ravi-system-pages"]);

    const appended = markLoadedFromSkillGate(snapshot, { provider: "codex", skill: "ravi-system-image", now: 2 });
    expect(appended.skills.map((skill) => skill.id)).toEqual(["pages", "ravi-system-image", "ravi-system-pages"]);
    expect(appended.loadedSkills).toEqual(["ravi-system-image"]);
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

  it("keeps the gate-marked advertised record loaded across catalog re-announces", () => {
    // Turn 1: the gate names the catalog alias, alias equivalence marks the
    // record Claude advertises under the short id.
    const afterGate = markLoadedFromSkillGate(claudeCatalog(1), {
      provider: "claude",
      skill: "ravi-system-routes-manager",
      toolName: "Bash",
      now: 2,
    });
    expect(afterGate.loadedSkills).toEqual(["routes-manager"]);
    expect(skillIdentifiersMatch(afterGate.loadedSkills[0]!, "ravi-system-routes-manager")).toBe(true);

    // turn.complete on turn 1 and on every later user turn: Claude re-attaches
    // the same catalog with the record back at `advertised`. Loaded must win.
    let snapshot = afterGate;
    for (const now of [3, 4, 5]) {
      snapshot = mergeSkillVisibilitySnapshots(snapshot, claudeCatalog(now), now);
      expect(snapshot.loadedSkills).toEqual(["routes-manager"]);
    }
    expect(snapshot.skills.map((skill) => [skill.id, skill.state])).toEqual([
      ["routes-manager", "loaded"],
      ["sessions", "advertised"],
    ]);
    expect(snapshot.skills[0]?.loadedAt).toBe(2);
    expect(snapshot.skills[0]?.evidence?.map((entry) => entry.kind)).toEqual(["skill-gate"]);
  });

  it("keeps a loaded record the provider never re-announces", () => {
    // Sessions gated before alias equivalence persisted the loaded record
    // under the gate alias, next to the advertised short id.
    const legacy = buildSkillVisibilitySnapshot(
      [
        ...claudeCatalog(1).skills,
        {
          id: "ravi-system-routes-manager",
          provider: "claude",
          state: "loaded",
          confidence: "observed",
          source: "catalog:ravi-system/routes",
          evidence: [{ kind: "skill-gate", observedAt: 2 }],
          loadedAt: 2,
          lastSeenAt: 2,
        },
      ],
      2,
    );

    let snapshot = legacy;
    for (const now of [3, 4]) {
      snapshot = mergeSkillVisibilitySnapshots(snapshot, claudeCatalog(now), now);
      expect(snapshot.loadedSkills).toEqual(["ravi-system-routes-manager"]);
    }
    expect(snapshot.skills.map((skill) => [skill.id, skill.state])).toEqual([
      ["ravi-system-routes-manager", "loaded"],
      ["routes-manager", "advertised"],
      ["sessions", "advertised"],
    ]);
    expect(snapshot.skills[0]?.loadedAt).toBe(2);

    // Plugins outside the managed prefixes have no alias equivalence, so the
    // gate appends its own record; the catalog never lists that id either.
    const acmeCatalog = (now: number) =>
      buildSkillVisibilitySnapshot(
        [{ id: "deploy", provider: "claude", state: "advertised", confidence: "declared", lastSeenAt: now }],
        now,
      );
    const afterGate = markLoadedFromSkillGate(acmeCatalog(1), {
      provider: "claude",
      skill: "acme-tools-deploy",
      toolName: "Bash",
      now: 2,
    });
    expect(afterGate.loadedSkills).toEqual(["acme-tools-deploy"]);

    const afterTurn = mergeSkillVisibilitySnapshots(afterGate, acmeCatalog(3), 3);
    expect(afterTurn.loadedSkills).toEqual(["acme-tools-deploy"]);
    expect(afterTurn.skills.map((skill) => [skill.id, skill.state])).toEqual([
      ["acme-tools-deploy", "loaded"],
      ["deploy", "advertised"],
    ]);
  });

  it("still drops non-loaded stored entries the provider no longer announces", () => {
    const stored = buildSkillVisibilitySnapshot(
      [
        ...claudeCatalog(1).skills,
        { id: "revoked", provider: "claude", state: "advertised", confidence: "declared", lastSeenAt: 1 },
        {
          id: "ravi-system-tasks",
          provider: "claude",
          state: "loaded",
          confidence: "observed",
          loadedAt: 1,
          lastSeenAt: 1,
        },
      ],
      1,
    );

    const merged = mergeSkillVisibilitySnapshots(stored, claudeCatalog(2), 2);
    expect(merged.skills.map((skill) => skill.id)).toEqual(["ravi-system-tasks", "routes-manager", "sessions"]);
    expect(merged.loadedSkills).toEqual(["ravi-system-tasks"]);
  });

  it("clears a gate-loaded skill only through an explicit reset, not through a re-announce", () => {
    const afterGate = markLoadedFromSkillGate(claudeCatalog(1), {
      provider: "claude",
      skill: "ravi-system-routes-manager",
      toolName: "Bash",
      now: 2,
    });

    const afterReset = resetLoadedSkillVisibilitySnapshot(afterGate, 3);
    expect(afterReset.loadedSkills).toEqual([]);
    expect(afterReset.skills.find((skill) => skill.id === "routes-manager")?.state).toBe("stale");

    const afterTurn = mergeSkillVisibilitySnapshots(afterReset, claudeCatalog(4), 4);
    expect(afterTurn.loadedSkills).toEqual([]);

    // A record persisted under the gate alias is retained only while loaded;
    // once reset, the next re-announce prunes it like any other stale entry.
    const legacy = buildSkillVisibilitySnapshot(
      [
        ...claudeCatalog(1).skills,
        {
          id: "ravi-system-routes-manager",
          provider: "claude",
          state: "loaded",
          confidence: "observed",
          loadedAt: 2,
          lastSeenAt: 2,
        },
      ],
      2,
    );
    const legacyAfterReset = resetLoadedSkillVisibilitySnapshot(legacy, 3);
    expect(legacyAfterReset.loadedSkills).toEqual([]);
    const legacyAfterTurn = mergeSkillVisibilitySnapshots(legacyAfterReset, claudeCatalog(4), 4);
    expect(legacyAfterTurn.loadedSkills).toEqual([]);
    expect(legacyAfterTurn.skills.map((skill) => skill.id)).toEqual(["routes-manager", "sessions"]);
  });

  it("round-trips skill-gate evidence through persisted session params", () => {
    const afterGate = markLoadedFromSkillGate(claudeCatalog(1), {
      provider: "claude",
      skill: "ravi-system-routes-manager",
      source: "catalog:ravi-system/routes",
      path: "/plugins/ravi-system/skills/routes/SKILL.md",
      toolName: "Bash",
      now: 2,
    });

    const reread = readSkillVisibilityFromParams({ skillVisibility: JSON.parse(JSON.stringify(afterGate)) });
    const record = reread.skills.find((skill) => skill.id === "routes-manager");
    expect(reread.loadedSkills).toEqual(["routes-manager"]);
    expect(record?.evidence).toEqual([
      expect.objectContaining({
        kind: "skill-gate",
        observedAt: 2,
        path: "/plugins/ravi-system/skills/routes/SKILL.md",
        eventType: "runtime.skill-gate.loaded",
        detail: "delivered by skill gate for Bash",
      }),
    ]);
  });

  it("reports only the skills that entered the loaded vector", () => {
    const before = markLoadedFromSkillGate(claudeCatalog(1), {
      provider: "claude",
      skill: "ravi-system-sessions",
      now: 2,
    });
    const after = markLoadedFromSkillGate(before, {
      provider: "claude",
      skill: "ravi-system-routes-manager",
      now: 3,
    });

    expect(diffLoadedSkills(before, after)).toEqual(["routes-manager"]);
    expect(diffLoadedSkills(after, after)).toEqual([]);
    expect(diffLoadedSkills(undefined, before)).toEqual(["sessions"]);
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
    expect(extractRequestedSkillsFromToolCall("Skill", { skill: "ravi-system-image" })).toEqual(["ravi-system-image"]);
    expect(extractRequestedSkillsFromToolCall("skills_show", { name: "tiny" })).toEqual(["tiny"]);
    expect(extractRequestedSkillsFromCommandLine("ravi skills show ravi-user-skills-tiny --json")).toEqual([
      "ravi-user-skills-tiny",
    ]);
  });

  it("extracts a skill from Read/Edit of skills/<name>/SKILL.md and ignores ordinary files", () => {
    expect(extractSkillNameFromFilesystemPath("/tmp/plugins/ravi-system/skills/whatsapp-manager/SKILL.md")).toBe(
      "whatsapp-manager",
    );
    expect(
      extractRequestedSkillsFromToolCall("Read", {
        path: "/workspace/src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md",
      }),
    ).toEqual(["app-creator"]);
    expect(extractRequestedSkillsFromToolCall("Read", { path: "README.md" })).toEqual([]);
    expect(extractRequestedSkillsFromCommandLine("cat /tmp/plugins/ravi-system/skills/image/SKILL.md")).toEqual([
      "image",
    ]);
    expect(extractRequestedSkillsFromCommandLine("ls /tmp/home/.agents/skills/find-skills")).toEqual([]);
  });

  it("returns every skill a shell line references, so a granted one cannot mask a denied one", () => {
    expect(
      extractRequestedSkillsFromCommandLine(
        "cat /tmp/p/skills/app-creator/SKILL.md; head -20 /tmp/p/skills/whatsapp-manager/SKILL.md",
      ),
    ).toEqual(["app-creator", "whatsapp-manager"]);
    expect(
      extractRequestedSkillsFromCommandLine("cat /tmp/p/skills/app-creator/SKILL.md /tmp/p/skills/image/SKILL.md 2>&1"),
    ).toEqual(["app-creator", "image"]);
    expect(
      extractRequestedSkillsFromCommandLine("ravi skills show app-creator && ravi skills show whatsapp-manager --json"),
    ).toEqual(["app-creator", "whatsapp-manager"]);
    expect(
      extractRequestedSkillsFromToolCall("Bash", {
        command: "wc -l /tmp/p/skills/app-creator/SKILL.md | ravi skills show image",
      }),
    ).toEqual(["app-creator", "image"]);
  });

  it("does not treat a ravi skills install/list --source path as a skill load unless the segment expands", () => {
    expect(
      extractRequestedSkillsFromCommandLine("ravi skills install --source ~/.agents/skills/find-skills/SKILL.md 2>&1"),
    ).toEqual([]);
    expect(
      extractRequestedSkillsFromCommandLine(
        "./bin/ravi skills list --source ~/.agents/skills/find-skills/SKILL.md --json",
      ),
    ).toEqual([]);
    expect(
      extractRequestedSkillsFromCommandLine(
        "ravi skills install --source ~/.agents/skills/find-skills/SKILL.md && cat ~/.agents/skills/find-skills/SKILL.md",
      ),
    ).toEqual(["find-skills"]);
    expect(
      extractRequestedSkillsFromCommandLine(
        'ravi skills install --source "$(cat /tmp/p/skills/whatsapp-manager/SKILL.md)"',
      ),
    ).toEqual(["whatsapp-manager"]);
    expect(
      extractRequestedSkillsFromCommandLine(
        "ravi skills show find-skills --source ~/.agents/skills/find-skills/SKILL.md",
      ),
    ).toEqual(["find-skills"]);
  });

  it("matches catalog aliases when checking a path-derived skill against an allowlist", () => {
    expect(isSkillNameAuthorizedOnAllowlist("app-creator", ["ravi-dev-app-creator"])).toBe(true);
    expect(isSkillNameAuthorizedOnAllowlist("whatsapp-manager", ["ravi-dev-app-creator"])).toBe(false);
  });
});
