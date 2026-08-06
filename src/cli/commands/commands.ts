import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { configStore } from "../../config-store.js";
import {
  discoverRaviCommands,
  normalizeRaviCommandId,
  renderRaviCommand,
  resolveRaviCommand,
  type RaviCommandIssue,
  type RaviCommandRecord,
} from "../../commands/index.js";
import type { AgentConfig } from "../../router/types.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import {
  commandRunReturnSchema,
  commandShowReturnSchema,
  commandValidateReturnSchema,
  commandsListReturnSchema,
} from "./operational-return-schemas.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
// The whole domain is read-only — `run` only RENDERS the composed prompt, it
// never publishes to a session — so there is no braked op (declared in
// .ravi/specs/cli/commands/SPEC.md).
// ============================================================

interface ContractCallSite {
  op: string;
  asJson?: boolean;
}

/**
 * Agent ids are public through `agents list`, so AGENT_NOT_FOUND enriches the
 * envelope with real similar ids from the local config.
 */
function resolveAgent(agentId: string | undefined, site: ContractCallSite): AgentConfig {
  const config = configStore.getConfig();
  const resolvedAgentId = agentId?.trim() || config.defaultAgent;
  const agent = config.agents[resolvedAgentId];
  if (!agent) {
    contractFail(site.op, "AGENT_NOT_FOUND", `Agent not found: ${resolvedAgentId}`, {
      asJson: site.asJson,
      details: {
        suggestedAction: "Check the agent id (see suggestions; list with: ravi agents list --json)",
        suggestions: suggestSimilar(resolvedAgentId, Object.keys(config.agents)),
      },
    });
  }
  return agent;
}

/**
 * Command ids are public through `commands list` on the same registry the
 * lookup used, so COMMAND_NOT_FOUND enriches the envelope with real similar
 * ids at zero extra cost.
 */
function failCommandNotFound(site: ContractCallSite, id: string, registry: { commands: RaviCommandRecord[] }): never {
  contractFail(site.op, "COMMAND_NOT_FOUND", `Ravi command not found: #${id}`, {
    asJson: site.asJson,
    details: {
      suggestedAction: "Check the command name (see suggestions; list with: ravi commands list --json)",
      suggestions: suggestSimilar(
        id,
        registry.commands.map((command) => command.id),
      ),
    },
  });
}

function serializeIssue(issue: RaviCommandIssue): Record<string, unknown> {
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    id: issue.id ?? null,
    scope: issue.scope ?? null,
    path: issue.path ?? null,
  };
}

function serializeCommand(
  command: RaviCommandRecord,
  options: { includeBody?: boolean } = {},
): Record<string, unknown> {
  return {
    id: command.id,
    token: `#${command.id}`,
    title: command.title ?? null,
    description: command.description ?? null,
    argumentHint: command.argumentHint ?? null,
    arguments: command.arguments,
    disabled: command.disabled,
    scope: command.scope,
    path: command.path,
    relativePath: command.relativePath,
    shadowedBy: command.shadowedBy ?? null,
    shadows: command.shadows ?? [],
    issues: command.issues.map(serializeIssue),
    ...(options.includeBody ? { body: command.body, frontmatter: command.frontmatter } : {}),
  };
}

function printCommandSummary(command: RaviCommandRecord): void {
  const disabled = command.disabled ? " disabled" : "";
  const shadow = command.shadows?.length ? " shadows global" : command.shadowedBy ? " shadowed" : "";
  const description = command.description ? ` - ${command.description}` : "";
  console.log(`#${command.id} [${command.scope}${disabled}${shadow}]${description}`);
  console.log(`  ${command.path}`);
  if (command.argumentHint) {
    console.log(`  args: ${command.argumentHint}`);
  }
  for (const issue of command.issues) {
    console.log(`  ${issue.level}: ${issue.code} - ${issue.message}`);
  }
}

function printIssue(issue: RaviCommandIssue): void {
  const target = [issue.scope, issue.id ? `#${issue.id}` : null, issue.path].filter(Boolean).join(" ");
  console.log(`${issue.level}: ${issue.code}${target ? ` (${target})` : ""}`);
  console.log(`  ${issue.message}`);
}

function normalizeRestArgs(rest?: string[]): string[] {
  return Array.isArray(rest) ? rest : [];
}

@Group({
  name: "commands",
  description: "Manage Ravi prompt commands",
  scope: "open",
})
export class RaviCommandsCommands {
  @Command({ name: "list", description: "List Ravi commands" })
  @CommandAccess({ kind: "read", resource: "commands", action: "list", risk: "low" })
  @Returns(commandsListReturnSchema)
  list(
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical command tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching commands to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const agent = resolveAgent(agentId, { op: "commands list", asJson });
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const tagFilter = tagSlug?.trim() || null;
    const commands = filterItemsByCanonicalTag(
      registry.commands,
      "command",
      tagFilter ?? undefined,
      (command) => command.id,
    );
    const page = paginateCliItems(commands, { limit, offset });
    const pageCommands = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "commands", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageCommands.length,
      total: page.total,
      options: ["--agent", agentId, "--tag", tagFilter],
    });
    const commandRows = pickFields(
      pageCommands.map((command) => serializeCommand(command)),
      fields,
    );
    const payload = {
      total: page.total,
      pagination,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      agent: { id: agent.id, cwd: agent.cwd },
      locations: {
        agent: registry.agentCommandsDir ?? null,
        global: registry.globalCommandsDir,
      },
      items: commandRows,
      commands: commandRows,
      issues: registry.issues.map(serializeIssue),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (pageCommands.length === 0) {
      console.log("No Ravi commands found.");
      return payload;
    }
    console.log(
      `Ravi commands (${pageCommands.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):`,
    );
    for (const command of pageCommands) {
      printCommandSummary(command);
    }
    if (pagination.nextCommand) {
      console.log("\nNext page:");
      console.log(`  ${pagination.nextCommand}`);
    }
    if (registry.issues.length > 0) {
      console.log("");
      console.log(`Issues (${registry.issues.length}):`);
      for (const issue of registry.issues) printIssue(issue);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one Ravi command" })
  @CommandAccess({ kind: "read", resource: "commands", action: "show", risk: "low" })
  @Returns(commandShowReturnSchema)
  show(
    @Arg("name", { description: "Command name, with or without #" }) name: string,
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId, { op: "commands show", asJson });
    const id = normalizeRaviCommandId(name);
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const command = resolveRaviCommand(registry, id);
    if (!command) {
      failCommandNotFound({ op: "commands show", asJson }, id, registry);
    }

    const payload = {
      agent: { id: agent.id, cwd: agent.cwd },
      command: serializeCommand(command, { includeBody: true }),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printCommandSummary(command);
    console.log("");
    console.log(command.body.trimEnd());
    return payload;
  }

  @Command({ name: "validate", description: "Validate Ravi command files" })
  @CommandAccess({ kind: "read", resource: "commands", action: "validate", risk: "low" })
  @Returns(commandValidateReturnSchema)
  validate(
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId, { op: "commands validate", asJson });
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const errors = registry.issues.filter((issue) => issue.level === "error");
    const warnings = registry.issues.filter((issue) => issue.level === "warning");
    const payload = {
      valid: errors.length === 0,
      agent: { id: agent.id, cwd: agent.cwd },
      total: registry.entries.length,
      effectiveTotal: registry.commands.length,
      errors: errors.map(serializeIssue),
      warnings: warnings.map(serializeIssue),
    };

    if (asJson) {
      printJson(payload);
    } else if (errors.length === 0 && warnings.length === 0) {
      console.log(`Ravi commands valid (${registry.entries.length} files).`);
    } else {
      console.log(`Ravi command validation: ${errors.length} errors, ${warnings.length} warnings`);
      for (const issue of registry.issues) printIssue(issue);
    }
    if (errors.length > 0) {
      process.exitCode = 1;
    }
    return payload;
  }

  @Command({ name: "run", description: "Render a Ravi command into its composed prompt" })
  @CommandAccess({ kind: "read", resource: "commands", action: "render", risk: "low" })
  @Returns(commandRunReturnSchema)
  run(
    @Arg("name", { description: "Command name, with or without #" }) name: string,
    @Arg("args", { required: false, variadic: true, description: "Command arguments" }) rest?: string[],
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId, { op: "commands run", asJson });
    const id = normalizeRaviCommandId(name);
    const args = normalizeRestArgs(rest);
    const rawArguments = args.join(" ");
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const command = resolveRaviCommand(registry, id);
    if (!command) {
      failCommandNotFound({ op: "commands run", asJson }, id, registry);
    }

    const rendered = renderRaviCommand(
      command,
      {
        id,
        token: `#${id}`,
        rawArguments,
        originalText: `#${id}${rawArguments ? ` ${rawArguments}` : ""}`,
      },
      args,
    );
    const payload = {
      agent: { id: agent.id, cwd: agent.cwd },
      command: serializeCommand(command),
      metadata: rendered.metadata,
      positionalArguments: rendered.positionalArguments,
      prompt: rendered.prompt,
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(rendered.prompt);
    return payload;
  }
}
