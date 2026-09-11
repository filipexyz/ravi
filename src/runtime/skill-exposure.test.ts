import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginSkillVisibilitySnapshot } from "./skill-visibility.js";

describe("global skill exposure", () => {
  test("registry preserves metadata while rejecting unsupported and unprepared execution", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "ravi-skill-registry-"));
    const result = spawnSync(process.execPath, [join(import.meta.dir, "skill-exposure-registry.fixture.ts")], {
      cwd: isolatedRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: isolatedRoot,
        TMP: isolatedRoot,
        HOME: isolatedRoot,
        USERPROFILE: isolatedRoot,
        APPDATA: isolatedRoot,
        LOCALAPPDATA: isolatedRoot,
        XDG_CONFIG_HOME: isolatedRoot,
        CODEX_HOME: join(isolatedRoot, "codex"),
        CLAUDE_CONFIG_DIR: join(isolatedRoot, "claude"),
        RAVI_STATE_DIR: join(isolatedRoot, "ravi"),
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
        NODE_ENV: "test",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skill exposure registry boundary verified");
  }, 25_000);
  // Omitting an empty filter used to re-advertise every plugin skill.
  test("an explicit empty policy exposes no plugin skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-empty-skill-exposure-"));
    const skillDir = join(root, "skills", "private-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: private-skill\ndescription: Private instructions\n---\nPrivate body\n",
    );

    const result = buildPluginSkillVisibilitySnapshot({
      provider: "new-adapter",
      plugins: [{ type: "local", path: root }],
      state: "advertised",
      confidence: "declared",
      evidenceKind: "system-prompt",
      allowedSkills: [],
    });

    expect(result.skills).toEqual([]);
  });
});
