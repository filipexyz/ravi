/**
 * CLI Registry - Bridges decorators to Commander.js
 *
 * Reads metadata from decorated classes and registers them with Commander.
 */

import { Command as CommanderCommand } from "commander";
import {
  getGroupMetadata,
  getCommandsMetadata,
  getCommandAccessMetadata,
  getArgsMetadata,
  getOptionsMetadata,
  getScopeMetadata,
  type CommandAccessOptions,
  type CommandMetadata,
  type ScopeType,
} from "./decorators.js";
import { extractOptionName } from "./utils.js";
import {
  ContractError,
  binaryResponseToContractError,
  contractFailureOutcome,
  expectedErrorToContractError,
  permissionDeniedToContractError,
  renderContractError,
  unexpectedErrorToContractError,
} from "./agent-contract.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { cloudErrorToContractError, commandOperation, renderCloudContractError } from "./cloud-error-contract.js";
import { enforceCliCommandAuthorization, redactCommandAccessInput } from "./command-access.js";
import { emitCliAuditEvent } from "./audit.js";
import { getContext, runWithContext } from "./context.js";
import { omitRenderingFlags } from "./registry-snapshot.js";
import {
  dispatchRemote,
  resolveRemoteGatewayConfig,
  remoteGatewayErrorToContractError,
  remoteGatewayExitCode,
  remoteDispatchOutput,
  resolveContextKeyForRemote,
  type RemoteDispatchResult,
  type RemoteGatewayConfig,
} from "./remote-gateway.js";

type CommandClass = new () => object;

/**
 * Resolve a nested command path, creating intermediate commands as needed.
 * e.g. "whatsapp.group" on program creates program → whatsapp → group
 * Returns the deepest command node.
 */
function resolveCommandPath(
  parent: CommanderCommand,
  segments: string[],
  description: string,
  aliases?: string[],
): CommanderCommand {
  let current = parent;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    const isLast = i === segments.length - 1;

    // Check if this subcommand already exists
    let existing = current.commands.find((c) => c.name() === name);
    if (!existing) {
      existing = current.command(name).description(isLast ? description : "");
    } else if (isLast && description) {
      // Update description if this is the final segment
      existing.description(description);
    }
    if (isLast && aliases?.length) {
      const currentAliases = new Set(existing.aliases());
      for (const alias of aliases) {
        if (!currentAliases.has(alias)) existing.alias(alias);
      }
    }
    current = existing;
  }
  return current;
}

/**
 * Register all command classes with Commander.
 * Supports nested groups via dot notation: "whatsapp.group" → ravi whatsapp group <cmd>
 *
 * Throws if two classes register the same `(groupPath, command)` pair so
 * collisions are caught at startup instead of silently shadowed by commander.
 */
export function registerCommands(program: CommanderCommand, classes: CommandClass[]): void {
  const seen = new Map<string, { cls: CommandClass; method: string }>();
  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;
    if (groupMeta.hidden) continue;
    for (const cmd of getCommandsMetadata(cls)) {
      const fullName = `${groupMeta.name}.${cmd.name}`;
      const prev = seen.get(fullName);
      if (prev) {
        throw new Error(
          `CLI registry collision: command "${fullName}" is registered by both ` +
            `${prev.cls.name} (method ${prev.method}) and ${cls.name} (method ${cmd.method}). ` +
            `Each (group, command) pair must be unique.`,
        );
      }
      seen.set(fullName, { cls, method: cmd.method });
    }
  }

  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;
    if (groupMeta.hidden) continue;

    const commandsMeta = getCommandsMetadata(cls);
    if (commandsMeta.length === 0) continue;

    // Support nested groups via dot notation
    const segments = groupMeta.name.split(".");
    const group = resolveCommandPath(program, segments, groupMeta.description, groupMeta.aliases);

    const instance = new cls();

    // Tool name uses underscore-separated full path
    const toolGroupName = segments.join("_");

    // Resolve scope: command-level > group-level > "admin" (fail-secure default)
    const scopeMap = getScopeMetadata(cls);
    const commandAccessMap = getCommandAccessMetadata(cls);

    for (const cmdMeta of commandsMeta) {
      const effectiveScope: ScopeType = scopeMap.get(cmdMeta.method) ?? groupMeta.scope ?? "admin";
      registerCommand(group, instance, cmdMeta, toolGroupName, effectiveScope, commandAccessMap.get(cmdMeta.method));
    }
  }
}

function registerCommand(
  group: CommanderCommand,
  instance: object,
  cmdMeta: CommandMetadata,
  groupName: string,
  scope: ScopeType,
  access: CommandAccessOptions | undefined,
): void {
  // A command can also be an intermediate group when it has nested subcommands:
  // e.g. `ravi crm account <id>` and `ravi crm account create ...`.
  // If the nested group was registered first, Commander already has the node.
  const sub =
    group.commands.find((c) => c.name() === cmdMeta.name) ??
    group.command(cmdMeta.name).description(cmdMeta.description);

  // Add aliases if specified
  if (cmdMeta.aliases) {
    sub.aliases(cmdMeta.aliases);
  }

  // Educational extended help (rendered after auto-usage section)
  if (cmdMeta.helpAfter) {
    sub.addHelpText("after", cmdMeta.helpAfter);
  }

  // Get args and options metadata
  const argsMeta = getArgsMetadata(instance, cmdMeta.method);
  const optionsMeta = getOptionsMetadata(instance, cmdMeta.method);

  // Add positional arguments to commander
  for (const arg of argsMeta) {
    const argName = arg.variadic ? `${arg.name}...` : arg.name;
    const argDef = arg.required ? `<${argName}>` : `[${argName}]`;
    if (arg.description) {
      sub.argument(argDef, arg.description, arg.defaultValue);
    } else {
      sub.argument(argDef);
    }
  }

  // Add options to commander
  for (const opt of optionsMeta) {
    if (opt.description) {
      sub.option(opt.flags, opt.description, opt.defaultValue as string | boolean | undefined);
    } else {
      sub.option(opt.flags);
    }
  }

  const toolName = `${groupName}_${cmdMeta.name}`;

  // Set up the action handler
  sub.action(async (...commanderArgs: unknown[]) => {
    // Commander passes: args..., options, command
    const cmd = commanderArgs.pop() as CommanderCommand;
    // Resolve options via optsWithGlobals so parent-level flags with the same
    // name (e.g. --json declared on both `crm contact` and `crm contact show`)
    // surface on nested subcommands. Without this, commander binds the flag
    // to the ancestor that declared it first and the leaf action sees {}.
    commanderArgs.pop();
    const options = cmd.optsWithGlobals() as Record<string, unknown>;
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
        const optionValue = resolveOptionValue(options, optAtIndex.flags, optionsMeta, cmd);
        finalArgs.push(optionValue);
        if (optionValue !== undefined) {
          input[optName] = optionValue;
        }
      }
    }

    let remoteConfig: RemoteGatewayConfig | null;
    try {
      remoteConfig = await resolveRemoteGatewayConfig(process.env, commandOperation(groupName, cmdMeta.name));
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      renderContractError(error, input.json === true);
      process.exit(error.exitCode);
    }

    // The target gateway owns authorization for its context key. Performing a
    // local authorization first can reject a valid remote-only credential or
    // authorize a different local default principal.
    if (remoteConfig) {
      await dispatchRemoteCommand({
        config: remoteConfig,
        groupName,
        command: cmdMeta.name,
        groupSegments: groupName.split("_"),
        input,
      });
      return;
    }

    const accessResult = enforceCliCommandAuthorization({
      group: groupName,
      command: cmdMeta.name,
      access,
      input,
      source: "cli",
      scope,
    });
    const auditInput = redactCommandAccessInput(access, input);
    if (!accessResult.allowed) {
      const contractError = permissionDeniedToContractError(
        commandOperation(groupName, cmdMeta.name),
        accessResult.errorMessage,
      );
      renderContractError(contractError, input.json === true);
      await emitCliAuditEvent({
        group: groupName,
        name: cmdMeta.name,
        tool: toolName,
        input: auditInput,
        outcome: "denied",
        exitCode: 1,
        errorCode: "PERMISSION_DENIED",
        status: "completed",
        closeLazyConnection: false,
      });
      const { flushAuditAndExit } = await import("../permissions/scope.js");
      await flushAuditAndExit(1);
    }

    // Execute and emit single event with input + output
    const startTime = Date.now();
    let outcome: "succeeded" | "blocked" | "usage_error" | "denied" | "failed" = "succeeded";
    let contractExitCode: number | null = null;
    let contractErrorCode: string | undefined;

    try {
      const method = (instance as Record<string, Function>)[cmdMeta.method];
      const result = runWithContext(getContext() ?? {}, () => method.apply(instance, finalArgs));
      const returnValue = result instanceof Promise ? await result : result;
      if (returnValue instanceof Response) {
        if (!returnValue.ok) {
          const error = binaryResponseToContractError(commandOperation(groupName, cmdMeta.name), returnValue.status);
          renderContractError(error, input.json === true);
          throw error;
        }
        process.stdout.write(new Uint8Array(await returnValue.arrayBuffer()));
      }
    } catch (err) {
      const op = commandOperation(groupName, cmdMeta.name);
      const contractError =
        err instanceof ContractError
          ? err
          : isCloudAuthError(err)
            ? cloudErrorToContractError(op, err)
            : (expectedErrorToContractError(op, err) ?? unexpectedErrorToContractError(op));
      if (contractError) {
        if (isCloudAuthError(err)) renderCloudContractError(contractError, input.json === true);
        else if (!(err instanceof ContractError)) renderContractError(contractError, input.json === true);
        // contractFail/contractDryRun already emitted the envelope (or the
        // legacy text); preserve the Manual v2 exit taxonomy (1 error ·
        // 2 usage · 3 policy brake) instead of the generic error path.
        contractExitCode = contractError.exitCode;
        contractErrorCode = contractError.code;
        outcome = contractFailureOutcome(contractError);
      }
    }

    await emitCliAuditEvent({
      group: groupName,
      name: cmdMeta.name,
      tool: toolName,
      input: auditInput,
      outcome,
      exitCode: contractExitCode ?? undefined,
      errorCode: contractErrorCode,
      status: "completed",
      durationMs: Date.now() - startTime,
      closeLazyConnection: true,
    });

    if (contractExitCode !== null) process.exit(contractExitCode);
  });
}

function resolveOptionValue(
  options: Record<string, unknown>,
  flags: string,
  commandOptions: Array<{ flags: string }>,
  command: CommanderCommand,
): unknown {
  const optionName = extractOptionName(flags);
  const longFlag = flags.match(/--([a-zA-Z-]+)/)?.[1];
  if (!longFlag?.startsWith("no-")) {
    const value = options[optionName];
    const hasNegatedPair = commandOptions.some(
      (option) => option.flags.match(/--([a-zA-Z-]+)/)?.[1] === `no-${longFlag}`,
    );
    // Commander stores a paired `--foo`/`--no-foo` under the positive key.
    // A false value therefore means the positive flag was not present.
    if (hasNegatedPair && (value === false || command.getOptionValueSource(optionName) !== "cli")) {
      return undefined;
    }
    return value;
  }

  // Commander exposes `--no-foo` as the positive `foo` option (true when
  // omitted, false when present). Decorated methods and the generated command
  // contract expose `noFoo`, so convert Commander's state to flag presence.
  const positiveName = longFlag.slice(3).replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
  const positiveValue = options[positiveName];
  return typeof positiveValue === "boolean" ? !positiveValue : undefined;
}

interface DispatchRemoteCommandInput {
  config: RemoteGatewayConfig;
  groupName: string;
  command: string;
  groupSegments: string[];
  input: Record<string, unknown>;
}

async function dispatchRemoteCommand(input: DispatchRemoteCommandInput): Promise<void> {
  const op = commandOperation(input.groupName, input.command);
  const contextKey = resolveContextKeyForRemote();
  if (!contextKey) {
    const error = new ContractError(
      op,
      "REMOTE_CONTEXT_REQUIRED",
      "Remote gateway mode requires a runtime context key.",
      1,
      {
        suggestedAction: "Set RAVI_CONTEXT_KEY or add a local Ravi context credential issued by the target gateway",
      },
    );
    renderContractError(error, input.input.json === true);
    process.exit(error.exitCode);
  }

  let result;
  try {
    result = await dispatchRemote({
      groupSegments: input.groupSegments,
      command: input.command,
      body: omitRenderingFlags(input.input),
      config: input.config,
      contextKey,
    });
  } catch {
    const error = new ContractError(op, "SERVER_UNAVAILABLE", "Remote gateway request failed.", 1, {
      retryable: true,
      suggestedAction: "Check gateway availability and retry",
    });
    renderContractError(error, input.input.json === true);
    process.exit(error.exitCode);
  }

  const remoteError = remoteGatewayErrorToContractError(op, result);
  if (remoteError) {
    renderContractError(remoteError, input.input.json === true);
    process.exit(remoteError.exitCode);
  }
  printRemoteResponse(result);
  if (!result.ok) {
    process.exit(remoteGatewayExitCode(result));
  }
}

function printRemoteResponse(result: RemoteDispatchResult): void {
  const output = remoteDispatchOutput(result);
  if (output.value.length > 0) process.stdout.write(output.value);
}
