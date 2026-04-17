import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimePlugin } from "../runtime/types.js";
import { listCodexSkillDirs, syncCodexSkills } from "./codex-skills.js";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("syncCodexSkills", () => {
  it("copies plugin skills into the Codex skills directory with namespaced names", () => {
    const { codexSkillsDir, manifestPath, pluginsDir } = createTestLayout();
    const plugin = createPlugin(pluginsDir, {
      pluginName: "ravi-system",
      skillDirName: "agents",
      skillName: "agents-manager",
      skillBody: "# Agents\n\nUse this skill to manage Ravi agents.\n",
      extraFiles: {
        "references/commands.md": "ravi agents list\n",
      },
    });

    const synced = syncCodexSkills([plugin], { codexSkillsDir, manifestPath });
    const targetDir = join(codexSkillsDir, "ravi-system-agents-manager");

    expect(synced).toEqual(["ravi-system-agents-manager"]);
    expect(listCodexSkillDirs({ codexSkillsDir })).toEqual(["ravi-system-agents-manager"]);
    expect(existsSync(join(targetDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(targetDir, "references", "commands.md"))).toBe(true);

    const skillMarkdown = readFileSync(join(targetDir, "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("name: ravi-system-agents-manager");
    expect(skillMarkdown).toContain("Use this skill to manage Ravi agents.");
  });

  it("adds a frontmatter name when the source skill does not define one and removes stale managed skills", () => {
    const { codexSkillsDir, manifestPath, pluginsDir } = createTestLayout();
    const firstPlugin = createPlugin(pluginsDir, {
      pluginName: "ravi-dev",
      skillDirName: "architecture",
      skillName: null,
      skillBody: "# Architecture\n\nRead this when editing Ravi internals.\n",
    });

    syncCodexSkills([firstPlugin], { codexSkillsDir, manifestPath });
    const firstTargetDir = join(codexSkillsDir, "ravi-dev-architecture");
    expect(existsSync(firstTargetDir)).toBe(true);

    const firstSkillMarkdown = readFileSync(join(firstTargetDir, "SKILL.md"), "utf8");
    expect(firstSkillMarkdown.startsWith("---\nname: ravi-dev-architecture\n---\n\n")).toBe(true);

    syncCodexSkills([], { codexSkillsDir, manifestPath });
    expect(existsSync(firstTargetDir)).toBe(false);
    expect(listCodexSkillDirs({ codexSkillsDir })).toEqual([]);
  });
});

function createTestLayout(): {
  codexSkillsDir: string;
  manifestPath: string;
  pluginsDir: string;
} {
  tempRoot = mkdtempSync(join(tmpdir(), "ravi-codex-skills-"));
  return {
    codexSkillsDir: join(tempRoot, "codex", "skills"),
    manifestPath: join(tempRoot, "cache", "manifest.json"),
    pluginsDir: join(tempRoot, "plugins"),
  };
}

function createPlugin(
  pluginsDir: string,
  options: {
    pluginName: string;
    skillDirName: string;
    skillName: string | null;
    skillBody: string;
    extraFiles?: Record<string, string>;
  },
): RuntimePlugin {
  const pluginDir = join(pluginsDir, options.pluginName);
  writeText(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: options.pluginName }, null, 2));

  const skillFrontmatter =
    options.skillName === null
      ? options.skillBody
      : `---\nname: ${options.skillName}\ndescription: Test skill\n---\n\n${options.skillBody}`;
  writeText(join(pluginDir, "skills", options.skillDirName, "SKILL.md"), skillFrontmatter);

  for (const [relativePath, content] of Object.entries(options.extraFiles ?? {})) {
    writeText(join(pluginDir, "skills", options.skillDirName, relativePath), content);
  }

  return {
    type: "local",
    path: pluginDir,
  };
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644, flag: "w" });
}
