/**
 * Skills Commands - install, inspect and sync Ravi skills.
 */

import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { syncCodexSkills } from "../../plugins/codex-skills.js";
import { discoverPlugins } from "../../plugins/index.js";
import {
  discoverSkills,
  findSkillByName,
  findInstalledSkill,
  installSkills,
  listCatalogSkills,
  listInstalledSkills,
  selectSkills,
  withResolvedSkillSource,
  type RaviSkill,
} from "../../skills/manager.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function serializeSkill(skill: RaviSkill, options: { includeContent?: boolean } = {}): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description ?? null,
    path: skill.path,
    skillFilePath: skill.skillFilePath,
    source: skill.source,
    pluginName: skill.pluginName ?? null,
    ...(options.includeContent ? { content: skill.content } : {}),
  };
}

function syncCodex(): string[] {
  return syncCodexSkills(discoverPlugins());
}

@Group({
  name: "skills",
  description: "Skill discovery, install and inspection tools",
  scope: "open",
  skillGate: "ravi-system-skill-creator",
})
export class SkillsCommands {
  @Command({
    name: "list",
    description: "List Ravi catalog skills, installed skills or source skills",
    aliases: ["ls"],
  })
  list(
    @Option({ flags: "--source <source>", description: "List skills available in a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--installed", description: "List operator-installed skills instead of the Ravi catalog" })
    installed?: boolean,
    @Option({ flags: "--codex", description: "Include materialized Codex skills" }) includeCodex?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skills = source
      ? withResolvedSkillSource(source, (resolved) => discoverSkills(resolved))
      : installed === true || includeCodex === true
        ? listInstalledSkills({ includeCodex: includeCodex === true })
        : listCatalogSkills();

    const sourceLabel = source ?? (installed === true || includeCodex === true ? "installed" : "catalog");

    const payload = {
      total: skills.length,
      source: sourceLabel,
      skills: skills.map((skill) => serializeSkill(skill)),
    };

    if (asJson) {
      printJson(payload);
    } else if (skills.length === 0) {
      console.log(source ? "No skills found in source." : "No skills found.");
    } else {
      for (const skill of skills) {
        const description = skill.description ? ` — ${skill.description.split("\n")[0]}` : "";
        console.log(`${skill.name}${description}`);
        console.log(`  ${skill.source} ${skill.path}`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show a Ravi catalog skill, installed skill or source skill" })
  show(
    @Arg("name", { description: "Catalog skill name, installed skill name, or source skill name" }) name: string,
    @Option({ flags: "--source <source>", description: "Inspect skill from a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--installed", description: "Inspect only operator-installed/materialized skills" })
    installed?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skill = source
      ? withResolvedSkillSource(source, (resolved) => {
          const skills = discoverSkills(resolved);
          return selectSkills(skills, { skill: name })[0] ?? null;
        })
      : installed === true
        ? findInstalledSkill(name)
        : (findSkillByName(listCatalogSkills(), name) ?? findInstalledSkill(name));

    if (!skill) {
      fail(`Skill not found: ${name}`);
    }

    const payload = { skill: serializeSkill(skill, { includeContent: true }) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`# ${skill.name}`);
      if (skill.description) console.log(`\n${skill.description}\n`);
      console.log(`Path: ${skill.path}`);
      console.log("");
      console.log(skill.content);
    }
    return payload;
  }

  @Command({ name: "install", description: "Install Ravi catalog skills or skills from an explicit source" })
  install(
    @Arg("name", {
      required: false,
      description: "Skill name. Defaults to the Ravi catalog unless --source is passed",
    })
    name?: string,
    @Option({ flags: "--source <source>", description: "Install from a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--skill <name>", description: "Legacy alias for the skill name" }) skillName?: string,
    @Option({ flags: "--all", description: "Install all skills found in source" }) all?: boolean,
    @Option({ flags: "--plugin <name>", description: "User plugin bucket (default: ravi-user-skills)" })
    plugin?: string,
    @Option({ flags: "--overwrite", description: "Replace existing installed skill" }) overwrite?: boolean,
    @Option({ flags: "--skip-codex-sync", description: "Do not immediately sync materialized Codex skills" })
    skipCodexSync?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const requestedSkill = normalizeRequestedSkillName(name, skillName);
    if (!requestedSkill && all !== true) {
      fail("Pass a skill name or --all.");
    }

    const installSelected = (available: RaviSkill[]) => {
      const selected = selectSkills(available, {
        ...(requestedSkill ? { skill: requestedSkill } : {}),
        all: all === true,
      });
      return installSkills(selected, {
        ...(plugin ? { pluginName: plugin } : {}),
        overwrite: overwrite === true,
      });
    };

    const installed = source
      ? withResolvedSkillSource(source, (resolved) => installSelected(discoverSkills(resolved)))
      : installSelected(listCatalogSkills());

    const codexSynced = skipCodexSync === true ? [] : syncCodex();
    const payload = {
      success: true,
      source: source ?? "catalog",
      installed: installed.map((skill) => ({
        ...serializeSkill(skill),
        installPath: skill.installPath,
      })),
      codexSynced,
    };

    if (asJson) {
      printJson(payload);
    } else {
      for (const skill of installed) {
        console.log(`✓ Installed skill: ${skill.name}`);
        console.log(`  ${skill.installPath}`);
      }
      if (skipCodexSync !== true) {
        console.log(`Synced Codex skills: ${codexSynced.length}`);
      }
    }
    return payload;
  }

  @Command({ name: "sync", description: "Sync Ravi plugin skills into the Codex skills directory" })
  sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const codexSynced = syncCodex();
    const payload = {
      success: true,
      codexSynced,
      total: codexSynced.length,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Synced Codex skills: ${codexSynced.length}`);
    }
    return payload;
  }
}

function normalizeRequestedSkillName(name?: string, skillName?: string): string | undefined {
  const positional = name?.trim();
  const flag = skillName?.trim();
  if (positional && flag && positional !== flag) {
    fail(`Conflicting skill names: ${positional} and ${flag}`);
  }
  return positional || flag || undefined;
}
