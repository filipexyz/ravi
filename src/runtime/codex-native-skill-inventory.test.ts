import { describe, expect, test } from "bun:test";
import * as Bun from "bun";
import { linkSync, mkdirSync, mkdtempSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  captureCodexNativeDiscoveryRevision,
  captureCodexNativeSkillInventory,
  readCodexNativeDiscoveryOptions,
} from "./codex-native-skill-inventory.js";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-inventory-"));
  return {
    cwd,
    async skill(name: string, text = "Fixture instructions") {
      const path = join(cwd, "skills", name, "SKILL.md");
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, text);
      return { path, name, enabled: true, description: "Fixture skill", scope: "user" };
    },
  };
}

function response(cwd: string, skills: readonly object[]) {
  return { data: [{ cwd, skills, errors: [] }], extraMetadata: "accepted" };
}

function discoveryFixture() {
  // A shared OS temp root keeps ancestry discovery outside the real user's home.
  const sharedTemp = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "Temp") : tmpdir();
  const root = mkdtempSync(join(sharedTemp, "ravi-codex-discovery-"));
  const cwd = join(root, "project", "nested");
  const codexHome = join(root, "config");
  const userHome = join(root, "user");
  for (const path of [cwd, codexHome, userHome]) mkdirSync(path, { recursive: true });
  mkdirSync(join(root, ".git", "HEAD"), { recursive: true });
  return {
    root,
    cwd,
    codexHome,
    userHome,
    capture(skills: readonly object[] = []) {
      return captureCodexNativeDiscoveryRevision(response(cwd, skills), cwd, codexHome, userHome, {
        pluginSkillRoots: [join(codexHome, "plugins")],
        systemSkillRoots: [],
        projectCodexSkillRoots: [join(cwd, ".codex", "skills")],
      });
    },
  };
}

describe("captureCodexNativeDiscoveryRevision", () => {
  test("a visible directory link followed by native discovery fingerprints canonical target metadata", async () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const target = join(data.root, "canonical-native");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    await Bun.write(join(target, "SKILL.md"), "Synthetic linked skill");
    symlinkSync(target, join(skillsRoot, "linked-native"), process.platform === "win32" ? "junction" : "dir");
    const before = data.capture();
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    await Bun.write(join(target, "SKILL.md"), "Changed synthetic linked skill content size");
    expect(data.capture()).not.toBe(before);
  });

  test("retargeting a visible directory link invalidates its discovery revision", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const first = join(data.root, "first-target");
    const second = join(data.root, "second-target");
    for (const path of [skillsRoot, first, second]) mkdirSync(path, { recursive: true });
    const link = join(skillsRoot, "linked-native");
    symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
    const before = data.capture();
    renameSync(link, join(data.root, "preserved-first-link"));
    symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");
    expect(data.capture()).not.toBe(before);
  });

  test("replacing a canonical directory target invalidates the revision even when it remains empty", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const target = join(data.root, "canonical-native");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(skillsRoot, "linked-native"), process.platform === "win32" ? "junction" : "dir");
    const before = data.capture();
    renameSync(target, join(data.root, "preserved-first-target"));
    mkdirSync(target);
    expect(data.capture()).not.toBe(before);
  });

  test("visible directory link cycles fail closed", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const target = join(data.root, "canonical-native");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(skillsRoot, "linked-native"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(skillsRoot, join(target, "cycle"), process.platform === "win32" ? "junction" : "dir");
    expect(() => data.capture()).toThrow();
  });

  test("dangling visible directory links fail closed", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(
      join(data.root, "missing-target"),
      join(skillsRoot, "linked-native"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => data.capture()).toThrow();
  });

  test("visible links cannot expand metadata traversal into a whole configured home", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(data.codexHome, join(skillsRoot, "linked-native"), process.platform === "win32" ? "junction" : "dir");
    let failure: unknown;
    try {
      data.capture();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "unsafe-root" });
  });

  test("metadata traversal has a finite depth even through valid directory links", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const target = join(data.root, "canonical-native");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(join(target, ...Array.from({ length: 68 }, (_, index) => `d${index}`)), { recursive: true });
    symlinkSync(target, join(skillsRoot, "linked-native"), process.platform === "win32" ? "junction" : "dir");
    let failure: unknown;
    try {
      data.capture();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "traversal-limit" });
  });

  test("builtin system cache keeps its conservative rejection of visible directory links", () => {
    const data = discoveryFixture();
    const systemRoot = join(data.codexHome, "skills", ".system");
    const target = join(data.root, "canonical-native");
    mkdirSync(systemRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(systemRoot, "linked-builtin"), process.platform === "win32" ? "junction" : "dir");
    expect(() => data.capture()).toThrow();
  });

  test("hidden directory links skipped by native discovery do not block a request", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    const target = join(data.root, "outside");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(skillsRoot, ".hidden"), process.platform === "win32" ? "junction" : "dir");
    expect(data.capture()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("adding a hidden directory does not change the visible discovery revision", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.userHome, ".agents", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    const before = data.capture();
    mkdirSync(join(skillsRoot, ".hidden"));
    expect(data.capture()).toBe(before);
  });

  test("changes inside hidden directories stay outside native discovery", async () => {
    const data = discoveryFixture();
    const path = join(data.userHome, ".agents", "skills", ".hidden", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Hidden synthetic content");
    const before = data.capture();
    await Bun.write(path, "Different hidden synthetic content");
    expect(data.capture()).toBe(before);
  });

  test("the explicit system cache root is protected despite its hidden name", async () => {
    const data = discoveryFixture();
    const path = join(data.codexHome, "skills", ".system", "builtin", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Builtin synthetic content");
    const before = data.capture();
    await Bun.write(path, "Changed builtin synthetic content");
    expect(data.capture()).not.toBe(before);
  });

  test("an explicit system cache root cannot be replaced by a hidden directory link", () => {
    const data = discoveryFixture();
    const skillsRoot = join(data.codexHome, "skills");
    const target = join(data.root, "outside");
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(skillsRoot, ".system"), process.platform === "win32" ? "junction" : "dir");
    expect(() => data.capture()).toThrow();
  });

  test("explicit project layers prevent unrelated .codex roots from being traversed", () => {
    const data = discoveryFixture();
    const target = join(data.root, "outside");
    mkdirSync(target);
    mkdirSync(join(data.cwd, ".codex"));
    symlinkSync(target, join(data.cwd, ".codex", "skills"), process.platform === "win32" ? "junction" : "dir");
    expect(
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, {
        projectCodexSkillRoots: [],
        systemSkillRoots: [],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  test("unchanged discovery roots have a stable synchronous revision", () => {
    const data = discoveryFixture();
    const before = data.capture();
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(data.capture()).toBe(before);
  });

  test("an entry added to an existing empty root invalidates discovery", async () => {
    const data = discoveryFixture();
    const path = join(data.cwd, ".agents", "skills");
    mkdirSync(path, { recursive: true });
    const before = data.capture();
    await Bun.write(join(path, "added.txt"), "New discovery entry");
    expect(data.capture()).not.toBe(before);
  });

  test("a previously absent ancestor skill root invalidates discovery when created", () => {
    const data = discoveryFixture();
    const before = data.capture();
    mkdirSync(join(data.root, ".agents", "skills", "new-skill"), { recursive: true });
    expect(data.capture()).not.toBe(before);
  });

  test.each(["cwd-agents", "cwd-codex", "config-skills", "config-plugins", "user-agents"])(
    "changes in the %s root invalidate discovery",
    async (kind) => {
      const data = discoveryFixture();
      const roots: Record<string, string> = {
        "cwd-agents": join(data.cwd, ".agents", "skills"),
        "cwd-codex": join(data.cwd, ".codex", "skills"),
        "config-skills": join(data.codexHome, "skills"),
        "config-plugins": join(data.codexHome, "plugins"),
        "user-agents": join(data.userHome, ".agents", "skills"),
      };
      const resource = join(roots[kind], "nested", "resource.txt");
      mkdirSync(dirname(resource), { recursive: true });
      await Bun.write(resource, "Before");
      const before = data.capture();
      await Bun.write(resource, "After content changes file size");
      expect(data.capture()).not.toBe(before);
    },
  );

  test("a removed discovery entry invalidates the revision while preserving the fixture", async () => {
    const data = discoveryFixture();
    const resource = join(data.codexHome, "plugins", "plugin", "manifest.json");
    mkdirSync(dirname(resource), { recursive: true });
    await Bun.write(resource, "Synthetic manifest");
    const before = data.capture();
    renameSync(resource, join(data.root, "preserved-manifest.json"));
    expect(data.capture()).not.toBe(before);
  });

  test.each([".agents", ".codex"])("a symlink above the project root is not a %s discovery root", (name) => {
    const data = discoveryFixture();
    const innerRepo = join(data.cwd, "repository");
    mkdirSync(join(innerRepo, ".git", "HEAD"), { recursive: true });
    const target = join(data.root, "outside");
    mkdirSync(target);
    mkdirSync(join(data.cwd, name), { recursive: true });
    symlinkSync(target, join(data.cwd, name, "skills"), process.platform === "win32" ? "junction" : "dir");
    expect(
      captureCodexNativeDiscoveryRevision(response(innerRepo, []), innerRepo, data.codexHome, data.userHome),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each(["skills", "plugins"])(
    "a legacy home .codex/%s symlink is irrelevant with a different CODEX_HOME",
    (name) => {
      const data = discoveryFixture();
      const before = data.capture();
      const target = join(data.root, "outside");
      mkdirSync(target);
      mkdirSync(join(data.userHome, ".codex"));
      symlinkSync(target, join(data.userHome, ".codex", name), process.platform === "win32" ? "junction" : "dir");
      expect(data.capture()).toBe(before);
    },
  );

  test("without a project marker only cwd repository roots are discovered", () => {
    const data = discoveryFixture();
    renameSync(join(data.root, ".git"), join(data.root, "preserved-git-marker"));
    const target = join(data.root, "outside");
    mkdirSync(target);
    mkdirSync(join(dirname(data.cwd), ".agents"));
    symlinkSync(
      target,
      join(dirname(data.cwd), ".agents", "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(data.capture()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("explicit empty project markers do not inherit git-root discovery", () => {
    const data = discoveryFixture();
    const target = join(data.root, "outside");
    mkdirSync(target);
    mkdirSync(join(data.root, ".agents"));
    symlinkSync(target, join(data.root, ".agents", "skills"), process.platform === "win32" ? "junction" : "dir");
    expect(
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, {
        projectRootMarkers: [],
        systemSkillRoots: [],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  test("configured project markers determine the real ancestor discovery boundary", () => {
    const data = discoveryFixture();
    const markerRoot = dirname(data.cwd);
    mkdirSync(join(markerRoot, "WORKSPACE"));
    const options = { projectRootMarkers: ["WORKSPACE"], systemSkillRoots: [] };
    const capture = () =>
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, options);
    const before = capture();
    mkdirSync(join(data.root, ".agents", "skills"), { recursive: true });
    expect(capture()).toBe(before);
    mkdirSync(join(markerRoot, ".agents", "skills"), { recursive: true });
    expect(capture()).not.toBe(before);
  });

  test("system roots supplied by effective config layers detect new admin skills", () => {
    const data = discoveryFixture();
    const systemRoot = join(data.root, "system-config", "skills");
    const options = { systemSkillRoots: [systemRoot] };
    const capture = () =>
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, options);
    const before = capture();
    mkdirSync(join(systemRoot, "new-admin-skill"), { recursive: true });
    expect(capture()).not.toBe(before);
  });

  test("plugin roots are explicit instead of inferred from storage directory names", () => {
    const data = discoveryFixture();
    const target = join(data.root, "outside");
    mkdirSync(target);
    symlinkSync(target, join(data.codexHome, "plugins"), process.platform === "win32" ? "junction" : "dir");
    expect(
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, {
        systemSkillRoots: [],
        pluginSkillRoots: [],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      captureCodexNativeDiscoveryRevision(response(data.cwd, []), data.cwd, data.codexHome, data.userHome, {
        systemSkillRoots: [],
        pluginSkillRoots: [join(data.codexHome, "plugins")],
      }),
    ).toThrow();
  });

  test("a skill returned from an extra root protects siblings in that root", async () => {
    const data = discoveryFixture();
    const path = join(data.root, "extra", "native", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Known skill");
    const skills = [{ path, name: "native", enabled: true }];
    const before = data.capture(skills);
    mkdirSync(join(data.root, "extra", "new-sibling"));
    expect(data.capture(skills)).not.toBe(before);
  });

  test("known nested system skills protect their enclosing skills root", async () => {
    const data = discoveryFixture();
    const path = join(data.root, "extra", "skills", ".system", "native", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Known skill");
    const skills = [{ path, name: "native", enabled: true }];
    const before = data.capture(skills);
    mkdirSync(join(data.root, "extra", "skills", "new-sibling"));
    expect(data.capture(skills)).not.toBe(before);
  });

  test("global configuration and credentials outside roots do not participate", async () => {
    const data = discoveryFixture();
    const before = data.capture();
    await Bun.write(join(data.codexHome, "auth.json"), "Synthetic credential fixture");
    await Bun.write(join(data.codexHome, "config.toml"), "Synthetic config fixture");
    await Bun.write(join(data.userHome, ".env"), "Synthetic env fixture");
    expect(data.capture()).toBe(before);
  });

  test("malformed discovery responses fail with a sanitized error", () => {
    const data = discoveryFixture();
    expect(() => captureCodexNativeDiscoveryRevision(null, data.cwd, data.codexHome, data.userHome)).toThrow(
      /^Codex native skill inventory is invalid$/,
    );
  });

  test("junction roots are refused before traversing external directories", () => {
    const data = discoveryFixture();
    const target = join(data.root, "outside");
    mkdirSync(target);
    symlinkSync(target, join(data.codexHome, "skills"), process.platform === "win32" ? "junction" : "dir");
    expect(() => data.capture()).toThrow();
  });

  test("a rejected discovery link exposes only a bounded diagnostic code", () => {
    const data = discoveryFixture();
    const target = join(data.root, "private-outside");
    mkdirSync(target);
    symlinkSync(target, join(data.codexHome, "skills"), process.platform === "win32" ? "junction" : "dir");
    let failure: unknown;
    try {
      data.capture();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "Codex native skill inventory is invalid", code: "symbolic-link" });
  });

  test("a sensitive discovery entry exposes only a bounded diagnostic code", async () => {
    const data = discoveryFixture();
    const path = join(data.codexHome, "plugins", "private-plugin", "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Synthetic private content");
    let failure: unknown;
    try {
      data.capture();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "Codex native skill inventory is invalid", code: "sensitive-entry" });
  });

  test("sensitive entries inside discovery roots fail closed", async () => {
    const data = discoveryFixture();
    const path = join(data.codexHome, "plugins", "fixture", "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Synthetic credential fixture");
    expect(() => data.capture()).toThrow();
  });

  test("fallback roots cannot expand to the user's home", async () => {
    const data = discoveryFixture();
    const path = join(data.userHome, "native", "SKILL.md");
    mkdirSync(dirname(path));
    await Bun.write(path, "Known skill");
    expect(() => data.capture([{ path, name: "native", enabled: true }])).toThrow();
  });

  test.each([".codex", ".agents", ".env"])("fallback roots cannot enumerate a sensitive %s directory", async (name) => {
    const data = discoveryFixture();
    const path = join(data.root, "extra", name, "native", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, "Known synthetic skill");
    expect(() => data.capture([{ path, name: "native", enabled: true }])).toThrow();
  });
});

describe("readCodexNativeDiscoveryOptions", () => {
  test("extracts every project layer including disabled layers without reading config files", () => {
    const data = discoveryFixture();
    const projectFolder = join(data.cwd, ".codex");
    const disabledFolder = join(data.root, ".codex");
    const systemFolder = join(data.root, "system");
    const options = readCodexNativeDiscoveryOptions({
      config: { project_root_markers: ["WORKSPACE"] },
      layers: [
        { name: { type: "system", file: join(systemFolder, "config.toml") }, config: {}, version: "fixture" },
        {
          name: { type: "project", dotCodexFolder: projectFolder },
          config: {},
          version: "fixture",
          disabledReason: null,
        },
        {
          name: { type: "project", dotCodexFolder: disabledFolder },
          config: {},
          version: "fixture",
          disabledReason: "not trusted",
        },
      ],
    });
    expect(options).toEqual({
      projectRootMarkers: ["WORKSPACE"],
      projectCodexSkillRoots: [join(projectFolder, "skills"), join(disabledFolder, "skills")],
      systemSkillRoots: [join(systemFolder, "skills")],
      pluginSkillRoots: [],
    });
  });

  test.each([undefined, null])("absent project markers default to .git (%j)", (markers) => {
    const data = discoveryFixture();
    const options = readCodexNativeDiscoveryOptions({
      config: { project_root_markers: markers },
      layers: [
        { name: { type: "system", file: join(data.root, "system", "config.toml") }, config: {}, version: "fixture" },
      ],
    });
    expect(options.projectRootMarkers).toEqual([".git"]);
  });

  test("empty project markers are preserved without defaulting to git", () => {
    const data = discoveryFixture();
    expect(
      readCodexNativeDiscoveryOptions({
        config: { project_root_markers: [] },
        layers: [
          { name: { type: "system", file: join(data.root, "system", "config.toml") }, config: {}, version: "fixture" },
        ],
      }).projectRootMarkers,
    ).toEqual([]);
  });

  test.each([
    null,
    {},
    { config: {}, layers: null },
    { config: {}, layers: [{}] },
    { config: { project_root_markers: "bad" }, layers: [] },
  ])("malformed config layers cannot claim discovery coverage %j", (value) => {
    expect(() => readCodexNativeDiscoveryOptions(value)).toThrow(/^Codex native skill inventory is invalid$/);
  });
});

describe("captureCodexNativeSkillInventory", () => {
  test("an explicit empty inventory disables no skills", () => {
    const { cwd } = fixture();
    const captured = captureCodexNativeSkillInventory(response(cwd, []), cwd);
    expect(captured.disabledSkills).toEqual([]);
    expect(captured.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  test("every native path is disabled, including already-disabled skills", async () => {
    const data = fixture();
    const first = await data.skill("first");
    const second = { ...(await data.skill("second")), enabled: false };
    const captured = captureCodexNativeSkillInventory(response(data.cwd, [second, first]), data.cwd);
    expect(captured.disabledSkills).toEqual([
      { path: first.path, enabled: false },
      { path: second.path, enabled: false },
    ]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.disabledSkills)).toBe(true);
    expect(captured.disabledSkills.every(Object.isFrozen)).toBe(true);
  });

  test("inventory ordering does not invalidate a binding", async () => {
    const data = fixture();
    const first = await data.skill("first");
    const second = await data.skill("second");
    const captured = captureCodexNativeSkillInventory(response(data.cwd, [first, second]), data.cwd);
    expect(captureCodexNativeSkillInventory(response(data.cwd, [second, first]), data.cwd)).toEqual(captured);
  });

  test("adding or removing a native skill changes the revision", async () => {
    const data = fixture();
    const first = await data.skill("first");
    const second = await data.skill("second");
    const single = captureCodexNativeSkillInventory(response(data.cwd, [first]), data.cwd);
    const both = captureCodexNativeSkillInventory(response(data.cwd, [first, second]), data.cwd);
    const empty = captureCodexNativeSkillInventory(response(data.cwd, []), data.cwd);
    expect(single.revision).not.toBe(both.revision);
    expect(single.revision).not.toBe(empty.revision);
  });

  test("native metadata changes invalidate the captured revision", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const original = captureCodexNativeSkillInventory(response(data.cwd, [skill]), data.cwd);
    const changed = captureCodexNativeSkillInventory(
      response(data.cwd, [{ ...skill, name: "renamed-native" }]),
      data.cwd,
    );
    expect(changed.revision).not.toBe(original.revision);
  });

  test("editing SKILL.md invalidates even a denied skill", async () => {
    const data = fixture();
    const skill = { ...(await data.skill("denied")), enabled: false };
    const inventory = response(data.cwd, [skill]);
    const original = captureCodexNativeSkillInventory(inventory, data.cwd);
    await Bun.write(skill.path, "Different instructions");
    expect(captureCodexNativeSkillInventory(inventory, data.cwd).revision).not.toBe(original.revision);
  });

  test("editing nested resources invalidates the captured revision", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const resource = join(dirname(skill.path), "scripts", "nested", "run.sh");
    mkdirSync(dirname(resource), { recursive: true });
    await Bun.write(resource, "echo fixture-one");
    const inventory = response(data.cwd, [skill]);
    const original = captureCodexNativeSkillInventory(inventory, data.cwd);
    await Bun.write(resource, "echo fixture-two");
    expect(captureCodexNativeSkillInventory(inventory, data.cwd).revision).not.toBe(original.revision);
  });

  test("adding and removing a resource changes the revision without deleting fixtures", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const inventory = response(data.cwd, [skill]);
    const original = captureCodexNativeSkillInventory(inventory, data.cwd);
    const resource = join(dirname(skill.path), "reference.txt");
    await Bun.write(resource, "Reference fixture");
    const withResource = captureCodexNativeSkillInventory(inventory, data.cwd);
    expect(withResource.revision).not.toBe(original.revision);
    renameSync(resource, join(data.cwd, "preserved-reference.txt"));
    expect(captureCodexNativeSkillInventory(inventory, data.cwd).revision).toBe(original.revision);
  });

  test("materialized paths contribute content but not native disable overrides", async () => {
    const data = fixture();
    const native = await data.skill("native");
    const materialized = await data.skill("materialized");
    const inventory = response(data.cwd, [native]);
    const captured = captureCodexNativeSkillInventory(inventory, data.cwd, [materialized.path]);
    expect(captured.disabledSkills).toEqual([{ path: native.path, enabled: false }]);
    expect(captured.revision).not.toBe(captureCodexNativeSkillInventory(inventory, data.cwd).revision);
    await Bun.write(materialized.path, "Changed approved instructions");
    expect(captureCodexNativeSkillInventory(inventory, data.cwd, [materialized.path]).revision).not.toBe(
      captured.revision,
    );
  });

  test("overlapping native and materialized paths are safely deduplicated", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const inventory = response(data.cwd, [skill]);
    expect(captureCodexNativeSkillInventory(inventory, data.cwd, [skill.path, skill.path])).toEqual(
      captureCodexNativeSkillInventory(inventory, data.cwd, [skill.path]),
    );
  });

  test("unrelated sibling files are outside the content fingerprint", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const inventory = response(data.cwd, [skill]);
    const original = captureCodexNativeSkillInventory(inventory, data.cwd);
    await Bun.write(join(data.cwd, "unrelated.txt"), "Sibling fixture");
    expect(captureCodexNativeSkillInventory(inventory, data.cwd).revision).toBe(original.revision);
  });

  test.each([null, {}, { data: [] }, { data: "invalid" }])("rejects malformed top-level input %j", (value) => {
    const { cwd } = fixture();
    expect(() => captureCodexNativeSkillInventory(value, cwd)).toThrow("Codex native skill inventory is invalid");
  });

  test("rejects errors instead of trusting an incomplete inventory", () => {
    const { cwd } = fixture();
    expect(() =>
      captureCodexNativeSkillInventory({ data: [{ cwd, skills: [], errors: [{ message: "private path" }] }] }, cwd),
    ).toThrow("Codex native skill inventory is invalid");
  });

  test("rejects a missing errors field", () => {
    const { cwd } = fixture();
    expect(() => captureCodexNativeSkillInventory({ data: [{ cwd, skills: [] }] }, cwd)).toThrow();
  });

  test("rejects a response for a different cwd", () => {
    const { cwd } = fixture();
    expect(() => captureCodexNativeSkillInventory(response(join(cwd, "other"), []), cwd)).toThrow();
  });

  test("rejects duplicate cwd rows instead of ignoring an ambiguous inventory", () => {
    const { cwd } = fixture();
    const row = { cwd, skills: [], errors: [] };
    expect(() => captureCodexNativeSkillInventory({ data: [row, row] }, cwd)).toThrow();
  });

  test("rejects duplicate native paths after path normalization", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    expect(() =>
      captureCodexNativeSkillInventory(
        response(data.cwd, [skill, { ...skill, path: join(dirname(skill.path), "nested", "..", "SKILL.md") }]),
        data.cwd,
      ),
    ).toThrow();
  });

  test.each(["skills/native/SKILL.md", "", "SKILL.md", ".env", "\u0000/SKILL.md"])(
    "rejects unsafe skill path %j",
    (path) => {
      const { cwd } = fixture();
      expect(() =>
        captureCodexNativeSkillInventory(response(cwd, [{ path, name: "native", enabled: true }]), cwd),
      ).toThrow();
    },
  );

  test("rejects missing skill files with a sanitized error", () => {
    const { cwd } = fixture();
    const path = join(cwd, "private-missing-skill", "SKILL.md");
    expect(() =>
      captureCodexNativeSkillInventory(response(cwd, [{ path, name: "private-name", enabled: true }]), cwd),
    ).toThrow(/^Codex native skill inventory is invalid$/);
  });

  test("rejects malformed metadata", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    expect(() =>
      captureCodexNativeSkillInventory(response(data.cwd, [{ ...skill, enabled: "true" }]), data.cwd),
    ).toThrow();
  });

  test("rejects a skill rooted at the Codex config directory", async () => {
    const data = fixture();
    const codexRoot = join(data.cwd, ".codex");
    mkdirSync(codexRoot);
    const path = join(codexRoot, "SKILL.md");
    await Bun.write(path, "Invalid broad skill root");
    expect(() =>
      captureCodexNativeSkillInventory(response(data.cwd, [{ path, name: "root", enabled: true }]), data.cwd),
    ).toThrow();
  });

  test.each(["auth.json", ".env", ".env.local"])("rejects sensitive resource filename %s", async (name) => {
    const data = fixture();
    const skill = await data.skill("native");
    await Bun.write(join(dirname(skill.path), name), "Synthetic non-secret fixture");
    expect(() => captureCodexNativeSkillInventory(response(data.cwd, [skill]), data.cwd)).toThrow();
  });

  test("rejects directory junctions outside a skill without traversing them", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const outside = join(data.cwd, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dirname(skill.path), "resources"), process.platform === "win32" ? "junction" : "dir");
    expect(() => captureCodexNativeSkillInventory(response(data.cwd, [skill]), data.cwd)).toThrow();
  });

  test("rejects a junction in a skill's ancestor path", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const alias = join(data.cwd, "alias");
    symlinkSync(dirname(skill.path), alias, process.platform === "win32" ? "junction" : "dir");
    const aliasedSkill = { ...skill, path: join(alias, "SKILL.md") };
    expect(() => captureCodexNativeSkillInventory(response(data.cwd, [aliasedSkill]), data.cwd)).toThrow();
  });

  test("rejects hard-linked resources rather than reading an external file alias", async () => {
    const data = fixture();
    const skill = await data.skill("native");
    const outside = join(data.cwd, "outside.txt");
    await Bun.write(outside, "External synthetic fixture");
    linkSync(outside, join(dirname(skill.path), "reference.txt"));
    expect(() => captureCodexNativeSkillInventory(response(data.cwd, [skill]), data.cwd)).toThrow();
  });

  test("accepts an equivalent normalized absolute cwd", () => {
    const { cwd } = fixture();
    expect(captureCodexNativeSkillInventory(response(resolve(cwd), []), join(cwd, ".")).disabledSkills).toEqual([]);
  });
});
