/**
 * The generated `ravi-library` plugin (spec skills/library).
 *
 * Pinned Library skills load natively, like Ravi's system skills, through a
 * plugin the pin sync writes under the state dir:
 *
 *   <stateDir>/library/plugins/<generation>/union/ravi-library/
 *   <stateDir>/library/plugins/<generation>/agents/<agent>/all/ravi-library/
 *   <stateDir>/library/plugins/<generation>/agents/<agent>/external/ravi-library/
 *
 * A provider that takes a plugin per session (Claude, Pi) gets only the
 * agent's own directory: `all` in the operator's own turns, `external` (only
 * items marked `externalAllowed`) otherwise. Codex copies plugin skills into
 * one shared `~/.codex/skills`, so it gets the `union` (every pin of the
 * installation) and the skills that are not this agent's are disabled for its
 * thread. A generation is written once, atomically (staging directory, then
 * rename), and older generations are pruned only after a newer one exists, so
 * a running session never sees its plugin change under it.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

import { getRaviStateDir } from "../utils/paths.js";

export const LIBRARY_PLUGIN_NAME = "ravi-library";
/** Codex copies a plugin skill as `<plugin>-<skill>`; the name a Codex thread knows it by. */
export const LIBRARY_PLUGIN_SKILL_PREFIX = `${LIBRARY_PLUGIN_NAME}-`;
const COMPLETE_MARKER = ".complete";
const MAX_SKILL_NAME_LENGTH = 64;
/** Generations kept besides the current one (sessions started on them keep reading their files). */
const KEPT_PREVIOUS_GENERATIONS = 2;

export type LibraryPluginVariant = "all" | "external";

export interface LibraryPluginSkill {
  agentId: string;
  /** Directory and frontmatter name inside the plugin. */
  skillName: string;
  externalAllowed: boolean;
  /** Cached version directory holding the skill's files (and `item.json`). */
  sourceDir: string;
  /** `org/<slug>` or `<project>/<slug>`, for the plugin's README. */
  ref: string;
  version: number;
}

export interface LibraryPluginOptions {
  stateDir?: string;
}

export function libraryPluginsRoot(options: LibraryPluginOptions = {}): string {
  return join(options.stateDir ?? getRaviStateDir(), "library", "plugins");
}

/** Whether a path lies inside a generated Library plugin tree. */
export function isInsideLibraryPluginsRoot(path: string, options: LibraryPluginOptions = {}): boolean {
  const root = resolve(libraryPluginsRoot(options));
  return resolve(path).startsWith(`${root}${sep}`);
}

/** The plugin skill name of an item: `org-<slug>` or `<project>-<slug>`, before collision handling. */
export function baseLibrarySkillName(item: {
  scope: "org" | "project";
  project: { slug: string } | null;
  slug: string;
}) {
  // `org` is a reserved project slug, so it never names a project here.
  const scope = item.scope === "org" ? "org" : (item.project?.slug ?? "project");
  return `${scope}-${item.slug}`;
}

/**
 * Stable, unique plugin skill names for a set of Library ids. Ids are named
 * in sorted order; a name already taken (`org-x-y` can be the org's `x-y` or
 * project `org-x`'s `y`) or too long gets a short hash of the id.
 */
export function assignLibrarySkillNames(
  entries: ReadonlyArray<{ libraryId: string; baseName: string }>,
): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const unique = [...new Map(entries.map((entry) => [entry.libraryId, entry])).values()].sort((a, b) =>
    a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0,
  );
  for (const entry of unique) {
    let name = entry.baseName;
    if (name.length > MAX_SKILL_NAME_LENGTH || taken.has(name)) {
      const suffix = shortHash(entry.libraryId);
      name = `${entry.baseName.slice(0, MAX_SKILL_NAME_LENGTH - suffix.length - 1).replace(/-+$/, "")}-${suffix}`;
    }
    taken.add(name);
    names.set(entry.libraryId, name);
  }
  return names;
}

/** The name Codex gives a plugin skill once copied into `~/.codex/skills`. */
export function codexLibrarySkillName(skillName: string): string {
  return `${LIBRARY_PLUGIN_SKILL_PREFIX}${skillName}`;
}

/** Directory name of an agent inside a generation (agent ids are usually safe already). */
export function libraryAgentSegment(agentId: string): string {
  const id = agentId.trim();
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id) ? id : `_${shortHash(id)}`;
}

export function libraryUnionPluginDir(generationDir: string): string {
  return join(generationDir, "union", LIBRARY_PLUGIN_NAME);
}

export function libraryAgentPluginDir(generationDir: string, agentId: string, variant: LibraryPluginVariant): string {
  return join(generationDir, "agents", libraryAgentSegment(agentId), variant, LIBRARY_PLUGIN_NAME);
}

/**
 * Write (or reuse) the generation for this fingerprint and return its
 * directory, or null when there is nothing to write. Throws when a skill's
 * cached files are missing: the caller keeps the previous generation.
 */
export function writeLibraryPluginGeneration(
  fingerprint: string,
  skills: readonly LibraryPluginSkill[],
  options: LibraryPluginOptions = {},
): string | null {
  if (skills.length === 0) return null;
  const root = libraryPluginsRoot(options);
  const generationDir = join(root, `g-${generationKey(fingerprint, skills)}`);
  if (existsSync(join(generationDir, COMPLETE_MARKER))) return generationDir;

  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-${randomBytes(6).toString("hex")}`);
  try {
    const union = new Map<string, LibraryPluginSkill>();
    for (const skill of skills) union.set(skill.skillName, skill);
    writePlugin(join(staging, "union", LIBRARY_PLUGIN_NAME), [...union.values()]);

    const byAgent = new Map<string, LibraryPluginSkill[]>();
    for (const skill of skills) byAgent.set(skill.agentId, [...(byAgent.get(skill.agentId) ?? []), skill]);
    for (const [agentId, own] of byAgent) {
      const agentRoot = join(staging, "agents", libraryAgentSegment(agentId));
      writePlugin(join(agentRoot, "all", LIBRARY_PLUGIN_NAME), own);
      const external = own.filter((skill) => skill.externalAllowed);
      if (external.length > 0) writePlugin(join(agentRoot, "external", LIBRARY_PLUGIN_NAME), external);
    }
    writeFileSync(join(staging, COMPLETE_MARKER), `${fingerprint}\n`);
    rmSync(generationDir, { recursive: true, force: true });
    renameSync(staging, generationDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return generationDir;
}

/**
 * The generation's directory key: the pins' fingerprint and the skills
 * actually written. An apply that left a pin out (not readable this time)
 * writes fewer skills under the same fingerprint, so its generation must not
 * be the one a later full apply finds complete and reuses.
 */
function generationKey(fingerprint: string, skills: readonly LibraryPluginSkill[]): string {
  const written = skills
    .map((skill) =>
      [skill.agentId, skill.skillName, skill.externalAllowed ? 1 : 0, skill.ref, skill.version].join("\0"),
    )
    .sort()
    .join("\n");
  return createHash("sha256").update(`${fingerprint}\n${written}`, "utf8").digest("hex").slice(0, 24);
}

/** Remove generations other than `current` and the newest few before it. Best effort. */
export function pruneLibraryPluginGenerations(current: string | null, options: LibraryPluginOptions = {}): void {
  const root = libraryPluginsRoot(options);
  let entries: Array<{ dir: string; mtime: number }>;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((dir) => resolve(dir) !== (current ? resolve(current) : ""))
      .map((dir) => ({ dir, mtime: safeMtime(dir) }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  const staleStaging = entries.filter((entry) => entry.dir.includes(`${sep}.staging-`));
  const generations = entries.filter((entry) => !entry.dir.includes(`${sep}.staging-`));
  for (const entry of [...generations.slice(KEPT_PREVIOUS_GENERATIONS), ...staleStaging]) {
    // A staging directory younger than a minute may belong to a sync still writing.
    if (entry.dir.includes(`${sep}.staging-`) && Date.now() - entry.mtime < 60_000) continue;
    try {
      rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

function writePlugin(pluginDir: string, skills: readonly LibraryPluginSkill[]): void {
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: LIBRARY_PLUGIN_NAME,
        version: "1.0.0",
        description: "Library skills pinned to this agent in Ravi Console (generated; do not edit)",
      },
      null,
      2,
    )}\n`,
  );
  for (const skill of skills) {
    const target = join(pluginDir, "skills", skill.skillName);
    if (!existsSync(join(skill.sourceDir, "SKILL.md"))) {
      throw new Error(`Library skill ${skill.ref}@${skill.version} is not in the local cache.`);
    }
    cpSync(skill.sourceDir, target, {
      recursive: true,
      filter: (source) => !source.endsWith(`${sep}item.json`) || resolve(source, "..") !== resolve(skill.sourceDir),
    });
    const entry = join(target, "SKILL.md");
    writeFileSync(entry, withSkillName(readFileSync(entry, "utf8"), skill.skillName));
  }
}

/** Set the frontmatter `name` so every provider knows the skill by its plugin name. */
export function withSkillName(content: string, name: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!match) return `---\nname: ${name}\n---\n\n${content}`;
  const frontmatter = match[1] ?? "";
  const updated = /^name:.*$/m.test(frontmatter)
    ? frontmatter.replace(/^name:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;
  return `---\n${updated}\n---${match[2] ?? "\n"}${content.slice(match[0].length)}`;
}

function safeMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}
