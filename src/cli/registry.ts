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

type CommandClass = new () => object;

/**
 * Register all command classes with Commander
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

    const group = program
      .command(groupMeta.name)
      .description(groupMeta.description);

    const instance = new cls();

    for (const cmdMeta of commandsMeta) {
      registerCommand(group, instance, cmdMeta);
    }
  }
}

function registerCommand(
  group: CommanderCommand,
  instance: object,
  cmdMeta: CommandMetadata
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

  // Set up the action handler
  sub.action((...commanderArgs: unknown[]) => {
    // Commander passes: args..., options, command
    // We need to extract args and options in the right order

    // The last arg is the Command object, second to last is options
    const cmd = commanderArgs.pop(); // Command object (unused)
    void cmd;
    const options = commanderArgs.pop() as Record<string, unknown>;

    // Remaining are positional args
    const positionalArgs = commanderArgs;

    // Build the final args array in parameter order
    const finalArgs: unknown[] = [];
    const totalParams = argsMeta.length + optionsMeta.length;

    for (let i = 0; i < totalParams; i++) {
      // Check if this index is an arg
      const argAtIndex = argsMeta.find((a) => a.index === i);
      if (argAtIndex) {
        const argPosition = argsMeta.indexOf(argAtIndex);
        finalArgs.push(positionalArgs[argPosition]);
        continue;
      }

      // Check if this index is an option
      const optAtIndex = optionsMeta.find((o) => o.index === i);
      if (optAtIndex) {
        // Extract option name from flags (e.g., "-f, --force" -> "force")
        const optName = extractOptionName(optAtIndex.flags);
        finalArgs.push(options[optName]);
      }
    }

    // Call the method with extracted arguments
    const method = (instance as Record<string, Function>)[cmdMeta.method];
    const result = method.apply(instance, finalArgs);

    // Handle async methods
    if (result instanceof Promise) {
      result.catch((err: Error) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    }
  });
}

function extractOptionName(flags: string): string {
  // Parse flags like "-f, --force" or "--verbose" to get the long option name
  const match = flags.match(/--([a-zA-Z-]+)/);
  if (match) {
    // Convert kebab-case to camelCase
    return match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  // Fall back to short option
  const shortMatch = flags.match(/-([a-zA-Z])/);
  return shortMatch ? shortMatch[1] : "";
}
