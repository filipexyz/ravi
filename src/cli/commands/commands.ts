import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
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

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function resolveAgent(agentId?: string): AgentConfig {
  const config = configStore.getConfig();
  const resolvedAgentId = agentId?.trim() || config.defaultAgent;
  const agent = config.agents[resolvedAgentId];
  if (!agent) {
    fail(`Agent not found: ${resolvedAgentId}`);
  }
  return agent;
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
  list(
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId);
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const payload = {
      total: registry.commands.length,
      agent: { id: agent.id, cwd: agent.cwd },
      locations: {
        agent: registry.agentCommandsDir ?? null,
        global: registry.globalCommandsDir,
      },
      commands: registry.commands.map((command) => serializeCommand(command)),
      issues: registry.issues.map(serializeIssue),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (registry.commands.length === 0) {
      console.log("No Ravi commands found.");
      return payload;
    }
    console.log(`Ravi commands (${registry.commands.length}):`);
    for (const command of registry.commands) {
      printCommandSummary(command);
    }
    if (registry.issues.length > 0) {
      console.log("");
      console.log(`Issues (${registry.issues.length}):`);
      for (const issue of registry.issues) printIssue(issue);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one Ravi command" })
  show(
    @Arg("name", { description: "Command name, with or without #" }) name: string,
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId);
    const id = normalizeRaviCommandId(name);
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const command = resolveRaviCommand(registry, id);
    if (!command) {
      fail(`Ravi command not found: #${id}`);
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
  validate(
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId);
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
  run(
    @Arg("name", { description: "Command name, with or without #" }) name: string,
    @Arg("args", { required: false, variadic: true, description: "Command arguments" }) rest?: string[],
    @Option({ flags: "--agent <id>", description: "Resolve agent-scoped commands for this agent" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = resolveAgent(agentId);
    const id = normalizeRaviCommandId(name);
    const args = normalizeRestArgs(rest);
    const rawArguments = args.join(" ");
    const registry = discoverRaviCommands({ agentCwd: agent.cwd });
    const command = resolveRaviCommand(registry, id);
    if (!command) {
      fail(`Ravi command not found: #${id}`);
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
