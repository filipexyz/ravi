/**
 * Skill gate rule management.
 */

import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { isDefaultSkillGateRuleId, listDefaultSkillGateRules, type DefaultSkillGateRule } from "../skill-gates.js";
import {
  dbDeleteSkillGateRule,
  dbGetSkillGateRule,
  dbListSkillGateRules,
  dbUpsertSkillGateRule,
  type DbSkillGateRule,
  type DbSkillGateRuleInput,
} from "../../router/router-db.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

interface EffectiveSkillGateRule {
  id: string;
  skill: string | null;
  enabled: boolean;
  source: "default" | "override" | "custom";
  pattern?: string;
  groupRegex?: string;
  tool?: string;
  toolPrefix?: string;
  toolRegex?: string;
  command?: string;
  commandPrefix?: string;
  commandRegex?: string;
  configured?: DbSkillGateRule;
  defaultRule?: DefaultSkillGateRule;
}

function hasMatcher(input: DbSkillGateRuleInput): boolean {
  return Boolean(
    input.pattern ||
      input.groupRegex ||
      input.tool ||
      input.toolPrefix ||
      input.toolRegex ||
      input.command ||
      input.commandPrefix ||
      input.commandRegex,
  );
}

function serializeDbRule(rule: DbSkillGateRule): Record<string, unknown> {
  return {
    id: rule.id,
    skill: rule.skill ?? null,
    enabled: !rule.disabled,
    disabled: rule.disabled,
    pattern: rule.pattern ?? null,
    groupRegex: rule.groupRegex ?? null,
    tool: rule.tool ?? null,
    toolPrefix: rule.toolPrefix ?? null,
    toolRegex: rule.toolRegex ?? null,
    command: rule.command ?? null,
    commandPrefix: rule.commandPrefix ?? null,
    commandRegex: rule.commandRegex ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function buildEffectiveRules(): EffectiveSkillGateRule[] {
  const configured = dbListSkillGateRules();
  const configuredById = new Map(configured.map((rule) => [rule.id, rule]));
  const defaults = listDefaultSkillGateRules();
  const defaultIds = new Set(defaults.map((rule) => rule.id));
  const effective: EffectiveSkillGateRule[] = [];

  for (const defaultRule of defaults) {
    const override = configuredById.get(defaultRule.id);
    effective.push({
      id: defaultRule.id,
      skill: override?.skill ?? defaultRule.skill,
      enabled: override?.disabled !== true,
      source: override ? "override" : "default",
      pattern: override?.pattern ?? defaultRule.pattern,
      groupRegex: override?.groupRegex,
      tool: override?.tool,
      toolPrefix: override?.toolPrefix,
      toolRegex: override?.toolRegex,
      command: override?.command,
      commandPrefix: override?.commandPrefix,
      commandRegex: override?.commandRegex,
      ...(override ? { configured: override } : {}),
      defaultRule,
    });
  }

  for (const custom of configured.filter((rule) => !defaultIds.has(rule.id))) {
    effective.push({
      id: custom.id,
      skill: custom.skill ?? null,
      enabled: !custom.disabled,
      source: "custom",
      pattern: custom.pattern,
      groupRegex: custom.groupRegex,
      tool: custom.tool,
      toolPrefix: custom.toolPrefix,
      toolRegex: custom.toolRegex,
      command: custom.command,
      commandPrefix: custom.commandPrefix,
      commandRegex: custom.commandRegex,
      configured: custom,
    });
  }

  return effective.sort((a, b) => a.id.localeCompare(b.id));
}

function serializeEffectiveRule(rule: EffectiveSkillGateRule): Record<string, unknown> {
  return {
    id: rule.id,
    skill: rule.skill,
    enabled: rule.enabled,
    source: rule.source,
    pattern: rule.pattern ?? null,
    groupRegex: rule.groupRegex ?? null,
    tool: rule.tool ?? null,
    toolPrefix: rule.toolPrefix ?? null,
    toolRegex: rule.toolRegex ?? null,
    command: rule.command ?? null,
    commandPrefix: rule.commandPrefix ?? null,
    commandRegex: rule.commandRegex ?? null,
    configured: rule.configured ? serializeDbRule(rule.configured) : null,
    defaultRule: rule.defaultRule ?? null,
  };
}

function printRule(rule: EffectiveSkillGateRule): void {
  console.log(`${rule.enabled ? "✓" : "✗"} ${rule.id}`);
  console.log(`  Skill: ${rule.skill ?? "(none)"}`);
  console.log(`  Source: ${rule.source}`);
  const matchers = [
    rule.pattern ? `pattern=${rule.pattern}` : null,
    rule.groupRegex ? `groupRegex=${rule.groupRegex}` : null,
    rule.tool ? `tool=${rule.tool}` : null,
    rule.toolPrefix ? `toolPrefix=${rule.toolPrefix}` : null,
    rule.toolRegex ? `toolRegex=${rule.toolRegex}` : null,
    rule.command ? `command=${rule.command}` : null,
    rule.commandPrefix ? `commandPrefix=${rule.commandPrefix}` : null,
    rule.commandRegex ? `commandRegex=${rule.commandRegex}` : null,
  ].filter(Boolean);
  console.log(`  Match: ${matchers.join(" | ") || "(default id override only)"}`);
}

@Group({
  name: "skill-gates",
  description: "Manage runtime skill gate rules",
  scope: "admin",
})
export class SkillGatesCommands {
  @Command({ name: "list", description: "List skill gate rules" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const effective = buildEffectiveRules();
    const payload = {
      total: effective.length,
      configuredTotal: dbListSkillGateRules().length,
      rules: effective.map(serializeEffectiveRule),
    };

    if (asJson) {
      printJson(payload);
    } else if (effective.length === 0) {
      console.log("No skill gate rules configured.");
    } else {
      console.log("\nSkill gates:\n");
      for (const rule of effective) {
        printRule(rule);
        console.log("");
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one skill gate rule" })
  show(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const rule = buildEffectiveRules().find((candidate) => candidate.id === id);
    if (!rule) {
      fail(`Skill gate rule not found: ${id}`);
    }

    const payload = { rule: serializeEffectiveRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      printRule(rule);
    }
    return payload;
  }

  @Command({ name: "set", description: "Create or overwrite a skill gate rule" })
  set(
    @Arg("id", { description: "Rule id. Use a default id to override it, or a new id for a custom rule." }) id: string,
    @Arg("skill", { description: "Skill name loaded by this gate" }) skill: string,
    @Option({ flags: "--pattern <regex>", description: "Regex against normalized Ravi group/tool names" })
    pattern?: string,
    @Option({ flags: "--group-regex <regex>", description: "Alias for --pattern" }) groupRegex?: string,
    @Option({ flags: "--tool <name>", description: "Exact runtime tool name" }) tool?: string,
    @Option({ flags: "--tool-prefix <prefix>", description: "Runtime tool name prefix" }) toolPrefix?: string,
    @Option({ flags: "--tool-regex <regex>", description: "Regex against runtime tool names" }) toolRegex?: string,
    @Option({ flags: "--command <command>", description: "Exact shell command" }) command?: string,
    @Option({ flags: "--command-prefix <prefix>", description: "Shell command prefix" }) commandPrefix?: string,
    @Option({ flags: "--command-regex <regex>", description: "Regex against shell command text" })
    commandRegex?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const input: DbSkillGateRuleInput = {
      id,
      skill,
      pattern,
      groupRegex,
      tool,
      toolPrefix,
      toolRegex,
      command,
      commandPrefix,
      commandRegex,
    };

    if (!skill.trim()) {
      fail("Skill name is required.");
    }
    if (!isDefaultSkillGateRuleId(id) && !hasMatcher(input)) {
      fail("Custom skill gate rules require at least one matcher.");
    }

    const rule = dbUpsertSkillGateRule(input);
    const payload = { success: true, rule: serializeDbRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Set skill gate rule: ${rule.id}`);
    }
    return payload;
  }

  @Command({ name: "disable", description: "Disable a skill gate rule" })
  disable(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const existing = dbGetSkillGateRule(id);
    if (!existing && !isDefaultSkillGateRuleId(id)) {
      fail(`Skill gate rule not found: ${id}`);
    }

    const rule = dbUpsertSkillGateRule({
      ...(existing ?? { id }),
      disabled: true,
    });
    const payload = { success: true, rule: serializeDbRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Disabled skill gate rule: ${id}`);
    }
    return payload;
  }

  @Command({ name: "enable", description: "Enable a configured skill gate rule" })
  enable(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const existing = dbGetSkillGateRule(id);
    if (!existing) {
      fail(`Skill gate override not found: ${id}`);
    }

    const rule = dbUpsertSkillGateRule({ ...existing, disabled: false });
    const payload = { success: true, rule: serializeDbRule(rule) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Enabled skill gate rule: ${id}`);
    }
    return payload;
  }

  @Command({ name: "rm", description: "Remove a custom gate or disable a default gate" })
  rm(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const isDefault = isDefaultSkillGateRuleId(id);
    const existing = dbGetSkillGateRule(id);
    if (!isDefault && !existing) {
      fail(`Skill gate rule not found: ${id}`);
    }

    const payload = isDefault
      ? {
          success: true,
          action: "disabled-default",
          rule: serializeDbRule(dbUpsertSkillGateRule({ id, disabled: true })),
        }
      : { success: true, action: "deleted-custom", deleted: dbDeleteSkillGateRule(id) };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(isDefault ? `Disabled default skill gate rule: ${id}` : `Deleted custom skill gate rule: ${id}`);
    }
    return payload;
  }

  @Command({ name: "reset", description: "Delete a configured override and restore the default behavior" })
  reset(
    @Arg("id", { description: "Rule id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const deleted = dbDeleteSkillGateRule(id);
    const payload = { success: true, deleted };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(deleted ? `Reset skill gate rule: ${id}` : `No configured override found: ${id}`);
    }
    return payload;
  }
}
