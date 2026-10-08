import { getContext } from "./context.js";
import type { CommandAccessOptions, ScopeType } from "./decorators.js";
import {
  authorizePermission,
  findApprovalRequirement,
  type PermissionProviderDecision,
} from "../permissions/provider-runtime.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { authorizationContext } from "../permissions/authorization-agent.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
import { enforceScopeCheck } from "../permissions/scope.js";
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

export interface CliCommandAuthorizationInput extends CliCommandAccessInput {
  scope: ScopeType;
}

/** Apply command-declared audit redactions without mutating the invocation. */
export function redactCommandAccessInput(
  access: Pick<CommandAccessOptions, "redactions"> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redactions = new Set(access?.redactions ?? []);
  if (redactions.size === 0) return input;
  const redacted = { ...input };
  for (const field of redactions) {
    if (field in redacted) redacted[field] = "[REDACTED]";
  }
  return redacted;
}

export function enforceCliCommandAuthorization(input: CliCommandAuthorizationInput): CliCommandAccessResult {
  const accessResult = enforceCliCommandAccess(input);
  if (!accessResult.allowed || input.scope !== "superadmin") return accessResult;

  const boundary = enforceScopeCheck("superadmin", input.group, input.command);
  if (boundary.allowed) return accessResult;

  return {
    allowed: false,
    errorMessage: boundary.errorMessage,
    decision: accessResult.decision,
    attempted: accessResult.attempted,
  };
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

  const candidates = commandAccessCandidates(inputWithAccess);
  const requestFor = (candidate: AuthorizationCapability): PermissionProviderRequest => ({
    ...authority.request,
    permission: candidate.permission,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    operation,
  });

  for (const candidate of candidates) {
    const decision = authorizePermission(requestFor(candidate));
    attempted.push(decision);
    if (decision.allowed) {
      // Aprovação exigida para QUALQUER candidato vale para o comando: um
      // candidato liberado (ex.: o legado execute:group:<grupo>) não pode passar
      // por fora dela, nem o deny de outro provider esconder a exigência.
      const approval = findApprovalRequirement(candidates.map(requestFor));
      if (!approval) return { allowed: true, errorMessage: "", decision, attempted };
      attempted.push(approval);
      break;
    }
    if (decision.decision === "needs_approval") break;
  }

  const last = attempted[attempted.length - 1];
  const needsApproval = last?.decision === "needs_approval";
  const errorMessage = needsApproval
    ? buildCommandAccessApprovalMessage(inputWithAccess, authority.label, last)
    : buildCommandAccessDenialMessage(inputWithAccess, authority.label);
  recordCliCommandAccessDenial(inputWithAccess, authority, attempted, operation, errorMessage, needsApproval);

  return {
    allowed: false,
    errorMessage,
    decision: last,
    attempted,
  };
}

/**
 * `needs_approval` não tem canal humano no caminho do CLI (processo curto e
 * síncrono), então nega — mas diz o motivo real. A orientação de grant do
 * Ravi fica de fora: um grant local não supera a exigência de aprovação.
 */
function buildCommandAccessApprovalMessage(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
  authorityLabel: string,
  decision: PermissionProviderDecision,
): string {
  return [
    `Approval required: ${authorityLabel} cannot execute ${formatCommand(input)} (${input.access.kind} ${input.access.resource}.${input.access.action}, risk ${input.access.risk})`,
    `${decision.providerId}@${decision.providerVersion} (${decision.reasonCode}) requires human approval for ${decision.permission}:${decision.objectType}:${decision.objectId}.`,
    APPROVAL_REQUIRED_HINT,
  ].join("\n");
}

const APPROVAL_REQUIRED_HINT =
  "The CLI cannot request approval inline; ask the authority to reissue the scope without requiresApproval, or have the operator run it.";

function buildCommandAccessDenialMessage(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
  authorityLabel: string,
): string {
  const guidance = buildCommandAccessGuidance(input, subjectFromAuthorityLabel(authorityLabel));
  return [
    `Permission denied: ${authorityLabel} cannot execute ${formatCommand(input)} (${input.access.kind} ${input.access.resource}.${input.access.action}, risk ${input.access.risk})`,
    ...formatAuthorizationGuidanceLines(guidance),
  ].join("\n");
}

export function listCliCommandAccessCandidates(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
): AuthorizationCapability[] {
  return commandAccessCandidates(input);
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
  const hasContextKey = Boolean(process.env[RAVI_CONTEXT_KEY_ENV]?.trim());
  const useRuntimeContext = source !== "cli" || hasContextKey;
  if (useRuntimeContext && ctx?.context) {
    const context: CapabilityContextLike = authorizationContext(ctx.context, ctx.agentId);
    return {
      allowed: true,
      label: `agent:${context.agentId ?? "unknown"}`,
      request: { context },
    };
  }

  // A context key that does not resolve (unknown, revoked, expired, or from
  // another install) must not degrade into the local operator.
  if (source !== "cli" || hasContextKey) {
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

function commandAccessCandidates(input: CliCommandAccessInput & { access: CommandAccessOptions }): Array<{
  permission: string;
  objectType: string;
  objectId: string;
}> {
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

  const concreteResourceCandidates = commandAccessConcreteResourceCandidates(input);
  if (input.access.requireConcreteResource) {
    return concreteResourceCandidates;
  }
  const legacyCandidates = commandObjectCandidates(input.group, input.command).map((objectId) => ({
    permission: "execute",
    objectType: "group",
    objectId,
  }));

  return dedupeCandidates([...semanticCandidates, ...concreteResourceCandidates, ...legacyCandidates]);
}

function commandAccessConcreteResourceCandidates(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
): Array<{
  permission: string;
  objectType: string;
  objectId: string;
}> {
  const resourceInputKey = input.access.resourceId;
  if (!resourceInputKey) return [];
  const resourceIdValue = input.input?.[resourceInputKey];
  if (typeof resourceIdValue !== "string") return [];
  const objectId = resourceIdValue.trim();
  if (!objectId) return [];
  if (input.access.resourceIdPattern) {
    try {
      if (!new RegExp(input.access.resourceIdPattern).test(objectId)) return [];
    } catch {
      return [];
    }
  }
  return [
    {
      permission: input.access.kind,
      objectType: commandAccessConcreteResourceType(input.access.resource),
      objectId,
    },
  ];
}

function commandAccessConcreteResourceType(resource: string): string {
  if (resource === "tasks") return "task";
  return resource;
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
  needsApproval = false,
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

  // Com aprovação pendente, o que importa é o pedido que a exigiu; grant local
  // não resolve, então a orientação de grant/tags fica de fora do audit.
  const requested = needsApproval ? attempted[attempted.length - 1] : attempted[0];
  if (!requested) return;
  const command = `${input.group} ${input.command}`;
  const grantGuidance = buildCommandAccessGuidance(
    input,
    context.agentId ? { type: "agent", id: context.agentId } : undefined,
  );
  const guidance = needsApproval
    ? {
        kind: "approval-required",
        providerId: requested.providerId,
        reasonCode: requested.reasonCode,
        canonicalCapability: grantGuidance.canonicalCapability,
        candidateCapabilities: grantGuidance.candidateCapabilities,
        message: APPROVAL_REQUIRED_HINT,
      }
    : grantGuidance;

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
      blockType: needsApproval ? "cli_command_access_needs_approval" : "cli_command_access_missing_grant",
      guidance: needsApproval
        ? {
            canonicalCapability: grantGuidance.canonicalCapability,
            candidateCapabilities: grantGuidance.candidateCapabilities,
            recommendedPath: APPROVAL_REQUIRED_HINT,
          }
        : {
            canonicalCapability: grantGuidance.canonicalCapability,
            candidateCapabilities: grantGuidance.candidateCapabilities,
            recommendedPath: grantGuidance.preferredPath.message,
            allowCommand: grantGuidance.preferredPath.allowCommand,
            suggestedTags: grantGuidance.preferredPath.suggestedTags,
          },
      ...(provenance ? { context: provenance } : {}),
    },
  });
}

function buildCommandAccessGuidance(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
  subject?: { type: string; id: string },
) {
  return buildAuthorizationGuidance({
    capability: commandAccessCapability(input),
    candidates: commandAccessCandidates(input),
    subject,
    scope: "recurring",
    reason: `Needs ${formatCommand(input)} command access.`,
    includeProviderOwnedTags: true,
  });
}

function commandAccessCapability(
  input: CliCommandAccessInput & { access: CommandAccessOptions },
): AuthorizationCapability {
  if (input.access.requireConcreteResource) {
    const [concrete] = commandAccessConcreteResourceCandidates(input);
    if (concrete) return concrete;
  }
  return {
    permission: input.access.kind,
    objectType: input.access.resource,
    objectId: input.access.action,
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
    ...(access.requireConcreteResource ? { requireConcreteResource: true } : {}),
    ...(access.resourceIdPattern ? { resourceIdPattern: access.resourceIdPattern } : {}),
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
