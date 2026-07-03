/**
 * Skills Commands - install, inspect and sync Ravi skills.
 */

import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { syncCodexSkills } from "../../plugins/codex-skills.js";
import { discoverPlugins } from "../../plugins/index.js";
import {
  getAgent,
  dbListAgentsForSkill,
  dbListSkillGrants,
  dbListSkillGrantsForAgent,
  dbUpsertSkillGrant,
  dbDeleteSkillGrant,
  type DbSkillGrant,
} from "../../router/index.js";
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
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import { resolveAgentSkills } from "../../runtime/allowed-skills.js";
import {
  skillGrantMutationReturnSchema,
  skillGrantWhoReturnSchema,
  skillInspectReturnSchema,
  skillShowReturnSchema,
  skillsInstallReturnSchema,
  skillsListReturnSchema,
  skillsSyncReturnSchema,
} from "./operational-return-schemas.js";

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
})
export class SkillsCommands {
  @Command({
    name: "list",
    description: "List Ravi catalog skills, installed skills or source skills",
    aliases: ["ls"],
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "list", risk: "low" })
  @Returns(skillsListReturnSchema)
  list(
    @Option({ flags: "--source <source>", description: "List skills available in a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--installed", description: "List operator-installed skills instead of the Ravi catalog" })
    installed?: boolean,
    @Option({ flags: "--codex", description: "Include materialized Codex skills" }) includeCodex?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical skill tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching skills to skip (default: 0)" }) offset?: string,
  ) {
    const discovered = source
      ? withResolvedSkillSource(source, (resolved) => discoverSkills(resolved))
      : installed === true || includeCodex === true
        ? listInstalledSkills({ includeCodex: includeCodex === true })
        : listCatalogSkills();
    const tagFilter = tagSlug?.trim() || null;
    const skills = filterItemsByCanonicalTag(discovered, "skill", tagFilter ?? undefined, (skill) => skill.name);
    const page = paginateCliItems(skills, { limit, offset });
    const pageSkills = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "skills", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageSkills.length,
      total: page.total,
      options: [
        "--source",
        source,
        installed ? "--installed" : null,
        includeCodex ? "--codex" : null,
        "--tag",
        tagFilter,
      ],
    });

    const sourceLabel = source ?? (installed === true || includeCodex === true ? "installed" : "catalog");

    const payload = {
      total: page.total,
      pagination,
      source: sourceLabel,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      items: pageSkills.map((skill) => serializeSkill(skill)),
      skills: pageSkills.map((skill) => serializeSkill(skill)),
    };

    if (asJson) {
      printJson(payload);
    } else if (pageSkills.length === 0) {
      console.log(source ? "No skills found in source." : "No skills found.");
    } else {
      for (const skill of pageSkills) {
        const description = skill.description ? ` — ${skill.description.split("\n")[0]}` : "";
        console.log(`${skill.name}${description}`);
        console.log(`  ${skill.source} ${skill.path}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show a Ravi catalog skill, installed skill or source skill" })
  @CommandAccess({ kind: "read", resource: "skills", action: "show", risk: "low" })
  @Returns(skillShowReturnSchema)
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
  @CommandAccess({ kind: "mutate", resource: "skills", action: "install", risk: "high" })
  @Returns(skillsInstallReturnSchema)
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
  @CommandAccess({ kind: "mutate", resource: "skills", action: "sync", risk: "high" })
  @Returns(skillsSyncReturnSchema)
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

  @Command({
    name: "grant",
    description: "Grant a custom skill to an agent (per-agent visibility). System skills follow permissions.",
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "grant", risk: "medium" })
  @Returns(skillGrantMutationReturnSchema)
  grant(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Arg("skill", { description: "Skill name (matches SKILL.md name)" }) skill: string,
    @Option({ flags: "--note <text>", description: "Optional operator note" }) note?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    const skillName = skill?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!skillName) fail("Skill name is required.");
    if (!getAgent(agentId)) {
      fail(`Agent not found: ${agentId}`);
    }
    const resolved =
      findSkillByName(listCatalogSkills(), skillName) ??
      findSkillByName(listInstalledSkills({ includeCodex: false }), skillName);
    if (!resolved) {
      fail(`Skill not found: ${skillName}. Install or publish it before granting.`);
    }

    const canonicalSkillName = resolved.name;
    const grant = dbUpsertSkillGrant({
      agentId,
      skillName: canonicalSkillName,
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    const payload = {
      success: true,
      agentId,
      skillName: canonicalSkillName,
      grant,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Granted ${canonicalSkillName} to ${agentId}`);
      if (grant.note) console.log(`  note: ${grant.note}`);
    }
    return payload;
  }

  @Command({
    name: "revoke",
    description: "Revoke a skill grant from an agent",
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "revoke", risk: "medium" })
  @Returns(skillGrantMutationReturnSchema)
  revoke(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Arg("skill", { description: "Skill name" }) skill: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    const skillName = skill?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!skillName) fail("Skill name is required.");
    const removed = dbDeleteSkillGrant(agentId, skillName);
    const payload = {
      success: removed,
      agentId,
      skillName,
    };
    if (asJson) {
      printJson(payload);
    } else if (removed) {
      console.log(`✓ Revoked ${skillName} from ${agentId}`);
    } else {
      console.log(`No grant found for ${skillName} on ${agentId}.`);
    }
    return payload;
  }

  @Command({
    name: "inspect",
    description: "Show the resolved per-agent skill allowlist (baseline ∪ permission-derived ∪ grants)",
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "inspect", risk: "low" })
  @Returns(skillInspectReturnSchema)
  inspect(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!getAgent(agentId)) fail(`Agent not found: ${agentId}`);
    const resolved = resolveAgentSkills(agentId);
    const payload = {
      agentId,
      hasConfiguration: resolved.hasConfiguration,
      allowlist: resolved.allowlist,
      provenance: resolved.provenance,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`# skills.inspect ${agentId}`);
      console.log(`hasConfiguration=${resolved.hasConfiguration}`);
      console.log(`allowlist (${resolved.allowlist.length}):`);
      for (const skill of resolved.allowlist) console.log(`  - ${skill}`);
      console.log(`from baseline (${resolved.provenance.baseline.length})`);
      console.log(`from capabilities (${resolved.provenance.fromCapabilities.length})`);
      console.log(`from grants (${resolved.provenance.fromGrants.length})`);
    }
    return payload;
  }

  @Command({
    name: "who",
    description: "List agents currently granted a skill (or list all grants for an agent with --agent)",
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "who", risk: "low" })
  @Returns(skillGrantWhoReturnSchema)
  who(
    @Arg("skill", { required: false, description: "Skill name to look up" }) skill?: string,
    @Option({ flags: "--agent <id>", description: "List grants for a specific agent instead" }) agentFilter?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agentFilter?.trim();
    const skillName = skill?.trim();
    let grants: DbSkillGrant[] = [];
    let scopeLabel = "";
    if (agentId) {
      grants = dbListSkillGrantsForAgent(agentId);
      scopeLabel = `agent ${agentId}`;
    } else if (skillName) {
      grants = dbListAgentsForSkill(skillName);
      scopeLabel = `skill ${skillName}`;
    } else {
      grants = dbListSkillGrants();
      scopeLabel = "all grants";
    }
    const payload = {
      ...(skillName ? { skillName } : {}),
      total: grants.length,
      grants,
    };
    if (asJson) {
      printJson(payload);
    } else if (grants.length === 0) {
      console.log(`No grants for ${scopeLabel}.`);
    } else {
      for (const grant of grants) {
        console.log(`- agent=${grant.agentId} skill=${grant.skillName}${grant.note ? ` note="${grant.note}"` : ""}`);
      }
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
