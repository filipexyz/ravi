import { getContext } from "./context.js";
import type { CommandAccessOptions } from "./decorators.js";
import { authorizePermission, type PermissionProviderDecision } from "../permissions/provider-runtime.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
import {
  buildAuthorizationGuidance,
  formatAuthorizationGuidanceLines,
  type AuthorizationCapability,
} from "../permissions/authorization-guidance.js";
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
  const inputWithAccess: CliCommandAccessInput & { access: CommandAccessOptions } = { ...input, access: input.access };

  const authority = resolveCommandAccessAuthority(input.source, inputWithAccess.access);
  if (!authority.allowed) {
    return {
      allowed: false,
      errorMessage: authority.errorMessage,
      attempted: [],
    };
  }

  const operation = buildCliCommandOperation(inputWithAccess);
  const attempted: PermissionProviderDecision[] = [];

  for (const candidate of commandAccessCandidates(inputWithAccess)) {
    const decision = authorizePermission({
      ...authority.request,
      permission: candidate.permission,
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      operation,
    });
    attempted.push(decision);
    if (decision.allowed) {
      return { allowed: true, errorMessage: "", decision, attempted };
    }
  }

  const errorMessage = buildCommandAccessDenialMessage(inputWithAccess, authority.label);
  recordCliCommandAccessDenial(inputWithAccess, authority, attempted, operation, errorMessage);

  return {
    allowed: false,
    errorMessage,
    decision: attempted[attempted.length - 1],
    attempted,
  };
}

function buildCommandAccessDenialMessage(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
  authorityLabel: string,
): string {
  const subject = subjectFromAuthorityLabel(authorityLabel);
  const guidance = buildAuthorizationGuidance({
    capability: commandAccessCapability(input.access),
    subject,
    scope: "recurring",
    reason: `Needs ${formatCommand(input)} command access.`,
    includeProviderOwnedTags: true,
  });
  return [
    `Permission denied: ${authorityLabel} cannot execute ${formatCommand(input)} (${input.access.kind} ${input.access.resource}.${input.access.action}, risk ${input.access.risk})`,
    ...formatAuthorizationGuidanceLines(guidance),
  ].join("\n");
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

function commandAccessCandidates(input: CliCommandAccessInput): Array<{
  permission: string;
  objectType: string;
  objectId: string;
}> {
  if (!input.access) return [];

  const semanticCandidates = [
    {
      permission: input.access.kind,
      objectType: input.access.resource,
      objectId: input.access.action,
    },
    {
      permission: input.access.kind,
      objectType: input.access.resource,
      objectId: "*",
    },
    {
      permission: input.access.kind,
      objectType: `${input.access.resource}.${input.access.action}`,
      objectId: "*",
    },
  ];

  const legacyCandidates = commandObjectCandidates(input.group, input.command).map((objectId) => ({
    permission: "execute",
    objectType: "group",
    objectId,
  }));

  return dedupeCandidates([...semanticCandidates, ...legacyCandidates]);
}

function dedupeCandidates(
  candidates: Array<{ permission: string; objectType: string; objectId: string }>,
): Array<{ permission: string; objectType: string; objectId: string }> {
  const seen = new Set<string>();
  const result: Array<{ permission: string; objectType: string; objectId: string }> = [];
  for (const candidate of candidates) {
    const key = `${candidate.permission}:${candidate.objectType}:${candidate.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function recordCliCommandAccessDenial(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
  authority: Extract<ReturnType<typeof resolveCommandAccessAuthority>, { allowed: true }>,
  attempted: PermissionProviderDecision[],
  operation: PermissionProviderCliCommandOperation,
  reason: string,
): void {
  const context = authority.request.context as
    | (CapabilityContextLike & {
        contextId?: string;
        sessionKey?: string;
        sessionName?: string;
      })
    | null
    | undefined;
  if (!context) return;

  const requested = attempted[0];
  if (!requested) return;
  const command = `${input.group} ${input.command}`;
  const capability = commandAccessCapability(input.access);
  const guidance = buildAuthorizationGuidance({
    capability,
    subject: context.agentId ? { type: "agent", id: context.agentId } : undefined,
    scope: "recurring",
    reason: `Needs ${command} command access.`,
    includeProviderOwnedTags: true,
  });

  const provenance = buildAuditContextProvenance({
    contextId: context.contextId,
    kind: context.kind,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionName: context.sessionName,
    capabilities: context.capabilities,
    metadata: context.metadata,
  });
  recordAndEmitPermissionDenial({
    subjectType: "agent",
    subjectId: context.agentId ?? undefined,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionName: context.sessionName,
    contextId: context.contextId,
    relation: requested.permission,
    objectType: requested.objectType,
    objectId: requested.objectId,
    reason,
    command,
    detail: {
      operation,
      guidance,
      attempted: attempted.map((decision) => ({
        providerId: decision.providerId,
        permission: decision.permission,
        objectType: decision.objectType,
        objectId: decision.objectId,
        reasonCode: decision.reasonCode,
      })),
      ...(provenance ? { context: provenance } : {}),
    },
    audit: {
      type: "scope",
      agentId: context.agentId ?? "unknown",
      denied: `${requested.permission}:${requested.objectType}:${requested.objectId}`,
      reason,
      command,
      blockType: "cli_command_access_missing_grant",
      guidance: {
        canonicalCapability: guidance.canonicalCapability,
        recommendedPath: guidance.preferredPath.message,
        suggestedTags: guidance.preferredPath.suggestedTags,
      },
      ...(provenance ? { context: provenance } : {}),
    },
  });
}

function commandAccessCapability(access: CommandAccessOptions): AuthorizationCapability {
  return {
    permission: access.kind,
    objectType: access.resource,
    objectId: access.action,
  };
}

function subjectFromAuthorityLabel(authorityLabel: string): { type: string; id: string } | undefined {
  const [type, ...idParts] = authorityLabel.split(":");
  const id = idParts.join(":");
  if (!type || !id || authorityLabel === "local operator") return undefined;
  return { type, id };
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
