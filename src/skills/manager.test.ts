import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverSkills,
  installSkills,
  listCatalogSkills,
  listInstalledSkills,
  parseSkillSource,
  resolveSkillSource,
  selectSkills,
  userSkillsPluginDir,
} from "./manager.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("skills manager", () => {
  it("parses GitHub shorthands and tree URLs", () => {
    expect(parseSkillSource("vercel-labs/skills")).toMatchObject({
      type: "git",
      gitUrl: "https://github.com/vercel-labs/skills.git",
    });

    expect(parseSkillSource("https://github.com/vercel-labs/skills/tree/main/skills/find-skills")).toMatchObject({
      type: "git",
      gitUrl: "https://github.com/vercel-labs/skills.git",
      ref: "main",
      subpath: "skills/find-skills",
    });
  });

  it("discovers skills from common repository layouts", () => {
    const root = createTempRoot();
    writeText(
      join(root, "skills", "planner", "SKILL.md"),
      "---\nname: planner\ndescription: |\n  Planeja execução\n---\n\n# Planner\n",
    );
    writeText(
      join(root, ".codex", "skills", "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: Revisa mudanças\n---\n\n# Reviewer\n",
    );

    const resolved = resolveSkillSource(root);
    const skills = discoverSkills(resolved);

    expect(skills.map((skill) => skill.name)).toEqual(["planner", "reviewer"]);
    expect(skills.find((skill) => skill.name === "planner")?.description).toBe("Planeja execução");
  });

  it("requires explicit selection when source has multiple skills", () => {
    const skills = [skillFixture("one"), skillFixture("two")];

    expect(() => selectSkills(skills)).toThrow(/Pass --skill <name> or --all/);
    expect(selectSkills(skills, { skill: "two" }).map((skill) => skill.name)).toEqual(["two"]);
    expect(selectSkills(skills, { all: true }).map((skill) => skill.name)).toEqual(["one", "two"]);
  });

  it("installs selected skills into the Ravi user plugin", () => {
    const root = createTempRoot();
    const home = join(root, "home");
    const sourceDir = join(root, "source", "skills", "writer");
    writeText(join(sourceDir, "SKILL.md"), "---\nname: writer\ndescription: Escreve bem\n---\n\n# Writer\n");
    writeText(join(sourceDir, "references", "style.md"), "Use frases curtas.\n");

    const resolved = resolveSkillSource(join(root, "source"));
    const [skill] = discoverSkills(resolved);
    const [installed] = installSkills([skill], { homeDir: home });

    const pluginDir = userSkillsPluginDir(home);
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(installed.name).toBe("writer");
    expect(existsSync(join(pluginDir, "skills", "writer", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "writer", "references", "style.md"))).toBe(true);

    const installedSkills = listInstalledSkills({ homeDir: home });
    expect(installedSkills.map((item) => item.name)).toEqual(["writer"]);
  });

  it("lists and installs Ravi catalog skills from the embedded registry", () => {
    const root = createTempRoot();
    const home = join(root, "home");
    const catalogSkills = listCatalogSkills();
    const imageSkill = catalogSkills.find((skill) => skill.name === "image");

    expect(imageSkill).toBeDefined();
    expect(imageSkill?.source).toBe("catalog:ravi-system/image");
    expect(imageSkill?.files?.map((file) => file.path)).toContain("SKILL.md");

    const [installed] = installSkills([imageSkill!], { homeDir: home });

    expect(installed.name).toBe("image");
    expect(existsSync(join(userSkillsPluginDir(home), "skills", "image", "SKILL.md"))).toBe(true);
    expect(listInstalledSkills({ homeDir: home }).map((skill) => skill.name)).toEqual(["image"]);
  });
});

function createTempRoot(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "ravi-skills-manager-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skillFixture(name: string) {
  const root = createTempRoot();
  const skillDir = join(root, name);
  writeText(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  const resolved = resolveSkillSource(skillDir);
  return discoverSkills(resolved)[0];
}
