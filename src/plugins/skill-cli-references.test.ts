import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard against "phantom capabilities" (issue #63): a shipped SKILL.md must not
 * tell agents to run `ravi <group> ...` when no such CLI group exists.
 *
 * Scope is deliberately narrow and robust: only the first word after `ravi`
 * is checked, and only against the decorated command registry plus the
 * top-level commands wired by hand in src/cli/index.ts.
 */

const INTERNAL_PLUGINS_DIR = fileURLToPath(new URL("./internal", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Top-level commands registered directly on the Commander program in src/cli/index.ts. */
const TOP_LEVEL_COMMANDS = [
  "doctor",
  "link",
  "login",
  "logout",
  "setup",
  "stream",
  "tui",
  "unlink",
  "update",
  "whoami",
];

/**
 * Documented exceptions, scoped to one skill file and one word.
 * Key: `<path relative to src/plugins/internal>|<word>`. Value: why it is allowed.
 */
const ALLOWED_REFERENCES: Record<string, string> = {
  "ravi-system/skills/cross/SKILL.md|cross":
    "Deprecated skill: maps the removed `ravi cross ...` commands to `ravi sessions ...`.",
  "ravi-system/skills/matrix/SKILL.md|matrix":
    "Retired skill: tells agents the legacy `ravi matrix ...` surface does not exist.",
  "ravi-system/skills/apps/SKILL.md|app":
    "Example of a dynamic app alias (`ravi <app-id> ...`) for an app whose id is `app`.",
};

function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listSkillFiles(path));
    } else if (entry === "SKILL.md" && path.includes("/skills/")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Load the registry in a fresh process: other test files in the same `bun test`
 * run replace modules with `mock.module`, which breaks importing every command.
 */
function knownGroups(): Set<string> {
  const script = `
    import "reflect-metadata";
    import { getRegistry } from "./src/cli/registry-snapshot.ts";
    const registry = getRegistry();
    const names = [];
    for (const group of registry.groups) {
      names.push(group.segments[0]);
      for (const alias of group.aliases ?? []) names.push(alias.split(".")[0]);
    }
    for (const command of registry.commands) names.push(command.groupSegments[0]);
    console.log(JSON.stringify(names));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to load the CLI registry: ${result.stderr}`);
  }
  const lines = result.stdout.trim().split("\n");
  return new Set<string>([...TOP_LEVEL_COMMANDS, ...(JSON.parse(lines[lines.length - 1]) as string[])]);
}

/** `ravi <word>` where `ravi` is a standalone token (not `ravi-system`, `~/.ravi`, `./bin/ravi`). */
const RAVI_INVOCATION = /(?<![\w./~-])ravi[ \t]+([a-z][a-z0-9-]*)/g;

describe("shipped skills reference real CLI groups", () => {
  it("every `ravi <group>` in src/plugins/internal/**/skills/**/SKILL.md exists in the command registry", () => {
    const groups = knownGroups();
    const phantoms: string[] = [];
    for (const file of listSkillFiles(INTERNAL_PLUGINS_DIR)) {
      const skillPath = relative(INTERNAL_PLUGINS_DIR, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(RAVI_INVOCATION)) {
          const word = match[1];
          if (groups.has(word) || `${skillPath}|${word}` in ALLOWED_REFERENCES) continue;
          phantoms.push(`${skillPath}:${index + 1}: ravi ${word}`);
        }
      });
    }
    expect(phantoms).toEqual([]);
  });

  it("the guard actually sees the shipped skills and the registry", () => {
    expect(listSkillFiles(INTERNAL_PLUGINS_DIR).length).toBeGreaterThan(5);
    const groups = knownGroups();
    expect(groups.has("sessions")).toBe(true);
    expect(groups.has("skills")).toBe(true);
    expect(groups.has("architect")).toBe(false);
  });

  it("every allowlisted exception still points at an existing skill that uses the word", () => {
    for (const key of Object.keys(ALLOWED_REFERENCES)) {
      const [skillPath, word] = key.split("|");
      const text = readFileSync(join(INTERNAL_PLUGINS_DIR, skillPath), "utf8");
      expect([...text.matchAll(RAVI_INVOCATION)].some((match) => match[1] === word)).toBe(true);
    }
  });

  it("flags an unknown group and ignores ravi-prefixed paths and plugin names", () => {
    const words = (text: string) => [...text.matchAll(RAVI_INVOCATION)].map((match) => match[1]);
    expect(words("run `ravi architect plan` then ravi sessions list")).toEqual(["architect", "sessions"]);
    expect(words("see ravi-system:sessions, ~/.ravi/ravi.db and ./bin/ravi agents")).toEqual([]);
  });
});
