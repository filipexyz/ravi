import { getContext } from "./context.js";
import type { CommandAccessOptions } from "./decorators.js";
import { authorizePermission, type PermissionProviderDecision } from "../permissions/provider-runtime.js";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";
import type {
  CapabilityContextLike,
  PermissionProviderCliCommandOperation,
  PermissionProviderCommandAccess,
  PermissionProviderRequest,
} from "../permissions/provider-types.js";

export type CliCommandAccessSource = "cli" | "tool" | "gateway";

export interface CliCommandAccessInput {
  group: string;
  command: string;
  access?: CommandAccessOptions;
  input?: Record<string, unknown>;
  source: CliCommandAccessSource;
}

export interface CliCommandAccessResult {
  allowed: boolean;
  errorMessage: string;
  decision?: PermissionProviderDecision;
  attempted: PermissionProviderDecision[];
}

export function enforceCliCommandAccess(input: CliCommandAccessInput): CliCommandAccessResult {
  if (!input.access) {
    return {
      allowed: false,
      errorMessage: `Permission denied: command ${formatCommand(input)} is missing @CommandAccess metadata`,
      attempted: [],
    };
  }

  const authority = resolveCommandAccessAuthority(input.source, input.access);
  if (!authority.allowed) {
    return {
      allowed: false,
      errorMessage: authority.errorMessage,
      attempted: [],
    };
  }

  const operation = buildCliCommandOperation(input);
  const attempted: PermissionProviderDecision[] = [];

  for (const objectId of commandObjectCandidates(input.group, input.command)) {
    const decision = authorizePermission({
      ...authority.request,
      permission: "execute",
      objectType: "group",
      objectId,
      operation,
    });
    attempted.push(decision);
    if (decision.allowed) {
      return { allowed: true, errorMessage: "", decision, attempted };
    }
  }

  return {
    allowed: false,
    errorMessage: `Permission denied: ${authority.label} cannot execute ${formatCommand(input)} (${input.access.kind} ${input.access.resource}.${input.access.action}, risk ${input.access.risk})`,
    decision: attempted[attempted.length - 1],
    attempted,
  };
}

export function buildCliCommandOperation(input: CliCommandAccessInput): PermissionProviderCliCommandOperation {
  if (!input.access) {
    throw new Error(`Command ${formatCommand(input)} is missing @CommandAccess metadata`);
  }
  return {
    kind: "cli-command",
    source: input.source,
    group: input.group,
    command: input.command,
    fullName: `${input.group}.${input.command}`,
    access: normalizeAccess(input.access),
    input: selectCommandAccessInput(input.access, input.input ?? {}),
  };
}

function resolveCommandAccessAuthority(
  source: CliCommandAccessSource,
  access: CommandAccessOptions,
):
  | { allowed: true; label: string; request: Pick<PermissionProviderRequest, "context" | "subject" | "localOperator"> }
  | { allowed: false; errorMessage: string } {
  const ctx = getContext();
  const useRuntimeContext = source !== "cli" || Boolean(process.env[RAVI_CONTEXT_KEY_ENV]);
  if (useRuntimeContext && ctx?.context) {
    const agentId = ctx.agentId ?? ctx.context.agentId;
    const context: CapabilityContextLike = {
      ...ctx.context,
      agentId: ctx.context.agentId ?? agentId,
    };
    return {
      allowed: true,
      label: `agent:${context.agentId ?? agentId ?? "unknown"}`,
      request: { context },
    };
  }

  if (source !== "cli") {
    return {
      allowed: false,
      errorMessage: "Permission denied: command execution requires a resolved runtime principal",
    };
  }

  if (access.localOperator === false) {
    return {
      allowed: false,
      errorMessage: "Permission denied: local operator is not allowed for this command",
    };
  }

  return {
    allowed: true,
    label: "local operator",
    request: { localOperator: true },
  };
}

function commandObjectCandidates(group: string, command: string): string[] {
  return [`${group}_${command}`, group];
}

function normalizeAccess(access: CommandAccessOptions): PermissionProviderCommandAccess {
  return {
    kind: access.kind,
    resource: access.resource,
    action: access.action,
    risk: access.risk,
    ...(access.requiresContext ? { requiresContext: access.requiresContext } : {}),
    ...(access.resourceId ? { resourceId: access.resourceId } : {}),
    ...(access.input ? { input: access.input } : {}),
    ...(access.redactions ? { redactions: access.redactions } : {}),
    ...(access.localOperator != null ? { localOperator: access.localOperator } : {}),
    ...(access.requiresConfirmation != null ? { requiresConfirmation: access.requiresConfirmation } : {}),
    ...(access.notes ? { notes: access.notes } : {}),
  };
}

function selectCommandAccessInput(
  access: CommandAccessOptions,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const names = access.input ?? [];
  if (names.length === 0) return {};

  const redactions = new Set(access.redactions ?? []);
  const selected: Record<string, unknown> = {};
  for (const name of names) {
    if (!(name in input)) continue;
    selected[name] = redactions.has(name) ? "[REDACTED]" : input[name];
  }
  return selected;
}

function formatCommand(input: Pick<CliCommandAccessInput, "group" | "command">): string {
  return `${input.group} ${input.command}`;
}
