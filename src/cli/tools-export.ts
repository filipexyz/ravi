/**
 * CLI Tools Export - Extract CLI commands as tool definitions
 */

import {
  getGroupMetadata,
  getCommandsMetadata,
  getCommandAccessMetadata,
  getCliOnlyMetadata,
  getArgsMetadata,
  getOptionsMetadata,
  getScopeMetadata,
  resolveCommandSafetyMetadata,
  shouldEmitCommandAudit,
  type ArgMetadata,
  type CommandAccessOptions,
  type CommandSafetyMetadata,
  type OptionMetadata,
  type ScopeType,
} from "./decorators.js";
import { extractOptionName, inferOptionType } from "./utils.js";
import { nats } from "../nats.js";
import { getContext, runWithContext } from "./context.js";
import { enforceCliCommandAuthorization, redactCommandAccessInput } from "./command-access.js";
import { resolveCommandSkillGate, type SkillGateMetadata } from "./skill-gates.js";
import {
  ContractError,
  binaryResponseToContractError,
  contractFailureOutcome,
  expectedErrorToContractError,
  permissionDeniedToContractError,
  unexpectedErrorToContractError,
} from "./agent-contract.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { cloudErrorToContractError, commandOperation } from "./cloud-error-contract.js";
import { sanitizeCliAuditValue } from "./audit.js";

// ============================================================================
// Types
// ============================================================================

type CommandClass = new () => object;

/** Exported tool definition */
export interface ExportedTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  metadata: {
    group: string;
    command: string;
    method: string;
    args: ArgMetadata[];
    options: OptionMetadata[];
    scope?: ScopeType;
    skillGate?: SkillGateMetadata;
    access?: CommandAccessOptions;
    safety: CommandSafetyMetadata;
  };
}

/** Tool execution result */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  outcome?: "succeeded" | "blocked" | "usage_error" | "denied" | "failed";
  /** CLI-compatible exit taxonomy for structured contract failures. */
  exitCode?: number;
}

/** Manifest entry for documentation/inspection */
export interface ToolManifestEntry {
  name: string;
  description: string;
  operationKind: CommandSafetyMetadata["operationKind"];
  effectClass: CommandSafetyMetadata["effectClass"];
  risk: CommandSafetyMetadata["risk"];
  requiresConfirmation: boolean;
  classificationSource: CommandSafetyMetadata["classificationSource"];
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
    defaultValue?: unknown;
  }>;
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Extract all tools from decorated command classes.
 */
export function extractTools(classes: CommandClass[]): ExportedTool[] {
  const tools: ExportedTool[] = [];

  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;

    const commandsMeta = getCommandsMetadata(cls);
    if (commandsMeta.length === 0) continue;

    const instance = new cls();

    // Resolve scope: command-level > group-level > "admin" (fail-secure default)
    const scopeMap = getScopeMetadata(cls);
    const commandAccessMap = getCommandAccessMetadata(cls);
    const cliOnlySet = getCliOnlyMetadata(cls);

    for (const cmdMeta of commandsMeta) {
      if (cliOnlySet.has(cmdMeta.method)) continue;
      const argsMeta = getArgsMetadata(instance, cmdMeta.method);
      const optionsMeta = getOptionsMetadata(instance, cmdMeta.method);

      // Normalize dot-separated group names to underscores for tool names
      const normalizedGroup = groupMeta.name.replace(/\./g, "_");

      const effectiveScope: ScopeType = scopeMap.get(cmdMeta.method) ?? groupMeta.scope ?? "admin";
      const skillGate = resolveCommandSkillGate({
        groupPath: groupMeta.name,
        command: cmdMeta.name,
        method: cmdMeta.method,
      });
      const access = commandAccessMap.get(cmdMeta.method);
      const safety = resolveCommandSafetyMetadata(access, `${groupMeta.name}.${cmdMeta.name}`);

      tools.push({
        name: `${normalizedGroup}_${cmdMeta.name}`,
        description: cmdMeta.description,
        handler: buildHandler(
          instance,
          cmdMeta.method,
          argsMeta,
          optionsMeta,
          `${normalizedGroup}_${cmdMeta.name}`,
          normalizedGroup,
          cmdMeta.name,
          effectiveScope,
          access,
        ),
        metadata: {
          group: normalizedGroup,
          command: cmdMeta.name,
          method: cmdMeta.method,
          args: argsMeta,
          options: optionsMeta,
          scope: effectiveScope,
          ...(skillGate ? { skillGate } : {}),
          ...(access ? { access } : {}),
          safety,
        },
      });
    }
  }

  return tools;
}

/**
 * Generate a manifest of all tools for documentation/inspection.
 */
export function generateManifest(tools: ExportedTool[]): ToolManifestEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    operationKind: tool.metadata.safety.operationKind,
    effectClass: tool.metadata.safety.effectClass,
    risk: tool.metadata.safety.risk,
    requiresConfirmation: tool.metadata.safety.requiresConfirmation,
    classificationSource: tool.metadata.safety.classificationSource,
    parameters: [
      ...tool.metadata.args.map((arg) => ({
        name: arg.name,
        type: "string",
        required: arg.required ?? true,
        description: arg.description,
        defaultValue: arg.defaultValue,
      })),
      ...tool.metadata.options.map((opt) => ({
        name: extractOptionName(opt.flags),
        type: inferOptionType(opt.flags),
        required: false,
        description: opt.description,
        defaultValue: opt.defaultValue,
      })),
    ],
  }));
}

/**
 * Format manifest as JSON for SDK consumption.
 */
export function manifestToJSON(tools: ExportedTool[]): string {
  const manifest = generateManifest(tools);
  return JSON.stringify(manifest, null, 2);
}

// ============================================================================
// Internal Helpers
// ============================================================================

const MAX_INPUT_LENGTH = 500;

function truncateForEvent(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_INPUT_LENGTH ? value.slice(0, MAX_INPUT_LENGTH) + "…" : value;
  }
  if (value && typeof value === "object") {
    const truncated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      truncated[k] = truncateForEvent(v);
    }
    return truncated;
  }
  return value;
}

/**
 * Build handler function that executes the command method.
 */
function buildHandler(
  instance: object,
  methodName: string,
  args: ArgMetadata[],
  options: OptionMetadata[],
  toolName: string,
  group: string,
  command: string,
  scope: ScopeType,
  access: CommandAccessOptions | undefined,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (toolArgs: Record<string, unknown>): Promise<ToolResult> => {
    const ctx = access?.kind === "read" ? getContext({ touch: false, readOnly: true }) : getContext();
    const sessionKey = ctx?.sessionKey ?? "_cli";
    const agentId = ctx?.agentId;
    const startTime = Date.now();
    const auditInput = redactCommandAccessInput(access, toolArgs);
    const auditEnabled = shouldEmitCommandAudit(access, toolName);
    const accessResult = runWithContext(ctx ?? {}, () =>
      enforceCliCommandAuthorization({
        group,
        command,
        access,
        input: toolArgs,
        source: "tool",
        scope,
      }),
    );
    if (!accessResult.allowed) {
      const contractError = permissionDeniedToContractError(
        commandOperation(group, command),
        accessResult.errorMessage,
      );
      const envelope = JSON.stringify(contractError.envelope());
      if (auditEnabled && process.env.RAVI_SUPPRESS_AUDIT_EVENTS !== "1") {
        nats
          .emit(`ravi.${sessionKey}.cli.${group}.${command}`, {
            tool: toolName,
            input: truncateForEvent(sanitizeCliAuditValue(auditInput)),
            output: sanitizeCliAuditValue(accessResult.errorMessage, "output"),
            isError: true,
            outcome: "denied",
            exitCode: 1,
            errorCode: "PERMISSION_DENIED",
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            sessionKey,
            agentId,
          })
          .catch(() => {});
      }
      return {
        content: [{ type: "text", text: envelope }],
        isError: true,
        outcome: "denied",
        exitCode: contractError.exitCode,
      };
    }

    // Capture console output
    const output: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      output.push(`[ERROR] ${args.map(String).join(" ")}`);
    };

    let isError = false;
    let outcome: "succeeded" | "blocked" | "usage_error" | "denied" | "failed" = "succeeded";
    let contractExitCode: number | undefined;
    let contractErrorCode: string | undefined;

    try {
      // Build args array in parameter order
      const finalArgs: unknown[] = [];
      const totalParams = args.length + options.length;

      for (let i = 0; i < totalParams; i++) {
        const argAtIndex = args.find((a) => a.index === i);
        if (argAtIndex) {
          finalArgs.push(toolArgs[argAtIndex.name]);
          continue;
        }

        const optAtIndex = options.find((o) => o.index === i);
        if (optAtIndex) {
          const optName = extractOptionName(optAtIndex.flags);
          finalArgs.push(toolArgs[optName]);
        }
      }

      // Call the method
      const method = (instance as Record<string, Function>)[methodName];
      const result = runWithContext({ ...(ctx ?? {}), transport: "tool" }, () => method.apply(instance, finalArgs));
      const returnValue = result instanceof Promise ? await result : result;
      if (returnValue instanceof Response) {
        if (!returnValue.ok) {
          throw binaryResponseToContractError(commandOperation(group, command), returnValue.status);
        }
        output.push(
          JSON.stringify({
            success: true,
            op: commandOperation(group, command),
            binary: true,
            status: returnValue.status,
            contentType: returnValue.headers.get("content-type"),
            contentLength: returnValue.headers.get("content-length"),
            suggestedAction: "Use the SDK or gateway binary response to consume the bytes",
          }),
        );
      }
    } catch (err) {
      isError = true;
      const contractError =
        err instanceof ContractError
          ? err
          : isCloudAuthError(err)
            ? cloudErrorToContractError(commandOperation(group, command), err)
            : (expectedErrorToContractError(commandOperation(group, command), err) ??
              unexpectedErrorToContractError(commandOperation(group, command)));
      if (contractError) {
        contractExitCode = contractError.exitCode;
        contractErrorCode = contractError.code;
        outcome = contractFailureOutcome(contractError);
        isError = outcome !== "blocked";
        // A tool result must contain exactly one machine-readable envelope.
        // Preserve an already-emitted envelope; otherwise replace any captured
        // human rendering or incidental output with the canonical structure.
        const envelope = contractError.envelope();
        const renderedEnvelope = output.find((line) => isSameContractEnvelope(line, envelope));
        output.splice(0, output.length, renderedEnvelope ?? JSON.stringify(envelope));
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const text = output.join("\n").trim() || "(no output)";

    if (auditEnabled && process.env.RAVI_SUPPRESS_AUDIT_EVENTS !== "1") {
      nats
        .emit(`ravi.${sessionKey}.cli.${group}.${command}`, {
          tool: toolName,
          input: truncateForEvent(sanitizeCliAuditValue(auditInput)),
          // Tool output may contain message bodies or provider payloads. Audit
          // the semantic outcome, never the full returned content.
          output: truncateForEvent(sanitizeCliAuditValue(text, "output")),
          isError,
          outcome,
          ...(contractExitCode !== undefined ? { exitCode: contractExitCode } : {}),
          ...(contractErrorCode !== undefined ? { errorCode: contractErrorCode } : {}),
          durationMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          sessionKey,
          agentId,
        })
        .catch(() => {});
    }

    return {
      content: [{ type: "text", text }],
      isError,
      outcome,
      ...(contractExitCode !== undefined ? { exitCode: contractExitCode } : {}),
    };
  };
}

function isSameContractEnvelope(line: string, expected: ReturnType<ContractError["envelope"]>): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    return JSON.stringify(parsed) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
