import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverSkills,
  findSkillByName,
  installSkills,
  listCatalogSkills,
  listInstalledSkills,
  parseSkillSource,
  resolveSkillSource,
  SkillSourceError,
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
      "---\nname: planner\ndescription: >-\n  Planeja execução\n  em etapas\n---\n\n# Planner\n",
    );
    writeText(
      join(root, ".codex", "skills", "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: Revisa mudanças\n---\n\n# Reviewer\n",
    );

    const resolved = resolveSkillSource(root);
    const skills = discoverSkills(resolved);

    expect(skills.map((skill) => skill.name)).toEqual(["planner", "reviewer"]);
    expect(skills.find((skill) => skill.name === "planner")?.description).toBe("Planeja execução\nem etapas");
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

  it("lists and installs Ravi catalog skills from internal plugin files", () => {
    const root = createTempRoot();
    const home = join(root, "home");
    const catalogSkills = listCatalogSkills();
    const imageSkill = catalogSkills.find((skill) => skill.name === "image");
    const slackSkill = catalogSkills.find((skill) => skill.name === "slack");

    expect(imageSkill).toBeDefined();
    expect(imageSkill?.source).toBe("catalog:ravi-system/image");
    expect(imageSkill?.files?.map((file) => file.path)).toContain("SKILL.md");
    expect(slackSkill).toBeDefined();
    expect(slackSkill?.source).toBe("catalog:ravi-system/slack");
    expect(slackSkill?.files?.map((file) => file.path)).toContain("references/canvas.md");

    const [installed] = installSkills([imageSkill!], { homeDir: home });

    expect(installed.name).toBe("image");
    expect(existsSync(join(userSkillsPluginDir(home), "skills", "image", "SKILL.md"))).toBe(true);
    expect(listInstalledSkills({ homeDir: home }).map((skill) => skill.name)).toEqual(["image"]);
  });

  it("treats ~ and caller-cwd relative paths as local sources instead of GitHub shorthands", () => {
    expect(parseSkillSource("~/.agents/skills/find-skills", { homeDir: "/home/op" })).toMatchObject({
      type: "local",
      rootPath: "/home/op/.agents/skills/find-skills",
    });
    expect(parseSkillSource("./find-skills", { cwd: "/work/agent" })).toMatchObject({
      type: "local",
      rootPath: "/work/agent/find-skills",
    });
    expect(parseSkillSource("owner/repo")).toMatchObject({ type: "git" });
  });

  it("installs a single-skill directory without an explicit name (find-skills layout)", () => {
    const root = createTempRoot();
    const home = join(root, "home");
    const skillDir = join(home, ".agents", "skills", "find-skills");
    writeText(
      join(skillDir, "SKILL.md"),
      '---\nname: find-skills\ndescription: Helps users when they ask "how do I do X", "find a skill for X", or more.\n---\n\n# Find Skills\n',
    );

    for (const input of ["~/.agents/skills/find-skills", "~/.agents/skills/find-skills/SKILL.md"]) {
      const resolved = resolveSkillSource(input, { homeDir: home });
      expect(resolved.rootPath).toBe(skillDir);
      const selected = selectSkills(discoverSkills(resolved));
      expect(selected.map((skill) => skill.name)).toEqual(["find-skills"]);
      expect(selected[0]?.description).toBe(
        'Helps users when they ask "how do I do X", "find a skill for X", or more.',
      );
    }

    const [installed] = installSkills(selectSkills(discoverSkills(resolveSkillSource(skillDir))), { homeDir: home });
    expect(installed?.name).toBe("find-skills");
    expect(listInstalledSkills({ homeDir: home }).map((skill) => skill.name)).toEqual(["find-skills"]);

    const again = captureError(() =>
      installSkills(selectSkills(discoverSkills(resolveSkillSource(skillDir))), { homeDir: home }),
    );
    expect(again).toMatchObject({
      code: "SKILL_ALREADY_INSTALLED",
      skillName: "find-skills",
      publicMessage: "Skill already installed: find-skills.",
    });
  });

  it("strips only a wrapping quote pair from frontmatter scalars", () => {
    const root = createTempRoot();
    writeText(join(root, "a", "SKILL.md"), "---\nname: \"quoted-name\"\ndescription: 'It''s quoted'\n---\n");
    writeText(join(root, "b", "SKILL.md"), '---\nname: plain\ndescription: say "hi" twice\n---\n');
    const skills = discoverSkills(resolveSkillSource(root));
    expect(skills.map((skill) => [skill.name, skill.description])).toEqual([
      ["plain", 'say "hi" twice'],
      ["quoted-name", "It's quoted"],
    ]);
  });

  it("raises typed, path-free errors for source and selection failures", () => {
    const root = createTempRoot();
    const missing = join(root, "SENTINEL_MISSING_DIR");
    const notFound = captureError(() => resolveSkillSource(missing));
    expect(notFound).toBeInstanceOf(SkillSourceError);
    expect(notFound).toMatchObject({ code: "SKILL_SOURCE_NOT_FOUND", publicMessage: "Local skill source not found." });
    expect((notFound as SkillSourceError).message).toContain(missing);

    const empty = createTempRoot();
    expect(captureError(() => selectSkills(discoverSkills(resolveSkillSource(empty))))).toMatchObject({
      code: "SKILL_SOURCE_EMPTY",
    });

    const skills = [skillFixture("one"), skillFixture("two")];
    expect(captureError(() => selectSkills(skills))).toMatchObject({
      code: "SKILL_SELECTION_REQUIRED",
      publicMessage: "Source has 2 skills. Pass a skill name or --all.",
      candidates: ["one", "two"],
    });
    expect(captureError(() => selectSkills(skills, { skill: "three" }))).toMatchObject({
      code: "SKILL_NOT_FOUND",
      skillName: "three",
      candidates: ["one", "two"],
    });
  });

  it("resolves catalog skills by Codex managed aliases", () => {
    const catalogSkills = listCatalogSkills();

    expect(findSkillByName(catalogSkills, "ravi-system-apps")?.name).toBe("apps");
    expect(findSkillByName(catalogSkills, "ravi-system-tasks")?.name).toBe("tasks");
    expect(findSkillByName(catalogSkills, "ravi-dev-ravi-architecture")?.name).toBe("ravi-architecture");
    expect(findSkillByName(catalogSkills, "pages")?.name).toBe("pages");
    expect(findSkillByName(catalogSkills, "ravi-system-pages")?.name).toBe("pages");
  });
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

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
