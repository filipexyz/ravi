/**
 * CLI Registry - Bridges decorators to Commander.js
 *
 * Reads metadata from decorated classes and registers them with Commander.
 */

import { Command as CommanderCommand } from "commander";
import {
  getGroupMetadata,
  getCommandsMetadata,
  getArgsMetadata,
  getOptionsMetadata,
  type CommandMetadata,
} from "./decorators.js";
import { extractOptionName } from "./utils.js";
import { notif } from "../notif.js";

type CommandClass = new () => object;

const MAX_INPUT_LENGTH = 500;

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_INPUT_LENGTH
      ? value.slice(0, MAX_INPUT_LENGTH) + "…"
      : value;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v);
    return out;
  }
  return value;
}

/**
 * Resolve a nested command path, creating intermediate commands as needed.
 * e.g. "whatsapp.group" on program creates program → whatsapp → group
 * Returns the deepest command node.
 */
function resolveCommandPath(
  parent: CommanderCommand,
  segments: string[],
  description: string
): CommanderCommand {
  let current = parent;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    const isLast = i === segments.length - 1;

    // Check if this subcommand already exists
    let existing = current.commands.find((c) => c.name() === name);
    if (!existing) {
      existing = current
        .command(name)
        .description(isLast ? description : "");
    } else if (isLast && description) {
      // Update description if this is the final segment
      existing.description(description);
    }
    current = existing;
  }
  return current;
}

/**
 * Register all command classes with Commander.
 * Supports nested groups via dot notation: "whatsapp.group" → ravi whatsapp group <cmd>
 */
export function registerCommands(
  program: CommanderCommand,
  classes: CommandClass[]
): void {
  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;

    const commandsMeta = getCommandsMetadata(cls);
    if (commandsMeta.length === 0) continue;

    // Support nested groups via dot notation
    const segments = groupMeta.name.split(".");
    const group = resolveCommandPath(program, segments, groupMeta.description);

    const instance = new cls();

    // Tool name uses underscore-separated full path
    const toolGroupName = segments.join("_");

    for (const cmdMeta of commandsMeta) {
      registerCommand(group, instance, cmdMeta, toolGroupName);
    }
  }
}

function registerCommand(
  group: CommanderCommand,
  instance: object,
  cmdMeta: CommandMetadata,
  groupName: string
): void {
  const sub = group.command(cmdMeta.name).description(cmdMeta.description);

  // Add aliases if specified
  if (cmdMeta.aliases) {
    sub.aliases(cmdMeta.aliases);
  }

  // Get args and options metadata
  const argsMeta = getArgsMetadata(instance, cmdMeta.method);
  const optionsMeta = getOptionsMetadata(instance, cmdMeta.method);

  // Add positional arguments to commander
  for (const arg of argsMeta) {
    const argDef = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
    if (arg.description) {
      sub.argument(argDef, arg.description, arg.defaultValue);
    } else {
      sub.argument(argDef);
    }
  }

  // Add options to commander
  for (const opt of optionsMeta) {
    if (opt.description) {
      sub.option(
        opt.flags,
        opt.description,
        opt.defaultValue as string | boolean | undefined
      );
    } else {
      sub.option(opt.flags);
    }
  }

  const toolName = `${groupName}_${cmdMeta.name}`;

  // Set up the action handler
  sub.action(async (...commanderArgs: unknown[]) => {
    // Commander passes: args..., options, command
    const cmd = commanderArgs.pop(); // Command object (unused)
    void cmd;
    const options = commanderArgs.pop() as Record<string, unknown>;
    const positionalArgs = commanderArgs;

    // Build input map for the event
    const input: Record<string, unknown> = {};

    // Build the final args array in parameter order
    const finalArgs: unknown[] = [];
    const totalParams = argsMeta.length + optionsMeta.length;

    for (let i = 0; i < totalParams; i++) {
      const argAtIndex = argsMeta.find((a) => a.index === i);
      if (argAtIndex) {
        const argPosition = argsMeta.indexOf(argAtIndex);
        finalArgs.push(positionalArgs[argPosition]);
        input[argAtIndex.name] = positionalArgs[argPosition];
        continue;
      }

      const optAtIndex = optionsMeta.find((o) => o.index === i);
      if (optAtIndex) {
        const optName = extractOptionName(optAtIndex.flags);
        finalArgs.push(options[optName]);
        if (options[optName] !== undefined) {
          input[optName] = options[optName];
        }
      }
    }

    // Execute and emit single event with input + output
    const startTime = Date.now();
    let isError = false;

    try {
      const method = (instance as Record<string, Function>)[cmdMeta.method];
      const result = method.apply(instance, finalArgs);
      if (result instanceof Promise) await result;
    } catch (err) {
      isError = true;
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
    }

    await notif
      .emit(`ravi._cli.cli.${groupName}.${cmdMeta.name}`, {
        tool: toolName,
        input: truncate(input),
        isError,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        sessionKey: "_cli",
      })
      .catch(() => {});

    if (isError) process.exit(1);
  });
}
