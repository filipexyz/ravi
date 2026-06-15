import { randomUUID } from "node:crypto";
import type { ContextCapability } from "../router/router-db.js";
import { getContext } from "../cli/context.js";
import { getConfiguredCapabilityMaterializers, getConfiguredPermissionProviders } from "./provider-registry.js";
import type {
  CapabilityContextLike,
  PermissionProvider,
  PermissionProviderCapabilityOptions,
  PermissionProviderDecision,
  PermissionProviderRequest,
  PermissionProviderSubject,
} from "./provider-types.js";

export type {
  CapabilityContextLike,
  PermissionDecisionValue,
  PermissionProvider,
  PermissionProviderCapabilityOptions,
  PermissionProviderDecision,
  PermissionProviderRequest,
  PermissionProviderSubject,
} from "./provider-types.js";
export {
  AppPermissionProviderDeniedError,
  evaluateAppPermissionProvider,
} from "./app-permission-provider-runtime.js";
export type { AppPermissionProviderRuntimeOperation } from "./app-permission-provider-runtime.js";

export interface AuthorizePermissionOptions {
  providers?: PermissionProvider[];
}

/**
 * The single authorization facade for Ravi runtime callers.
 *
 * Ravi core calls this provider runtime, not grant-store internals. The default
 * chain is configured by provider-registry.ts and can be replaced without
 * changing callers.
 */
export function authorizePermission(
  request: PermissionProviderRequest,
  options: AuthorizePermissionOptions = {},
): PermissionProviderDecision {
  const startedAt = Date.now();
  const runtimeRequest = withRequestId(request);
  return evaluateProviderChain(runtimeRequest, options.providers ?? getConfiguredPermissionProviders(), startedAt);
}

export function can(
  subjectType: string,
  subjectId: string,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  return authorizePermission({
    subject: { type: subjectType, id: subjectId },
    permission,
    objectType,
    objectId,
  }).allowed;
}

export function agentCan(
  agentId: string | undefined,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (!agentId) return false;

  const scopedContext = agentId ? getScopedContext(agentId) : undefined;
  if (scopedContext) {
    return authorizePermission({
      context: { ...scopedContext, agentId: scopedContext.agentId ?? agentId },
      permission,
      objectType,
      objectId,
    }).allowed;
  }

  return authorizePermission({
    subject: { type: "agent", id: agentId },
    permission,
    objectType,
    objectId,
  }).allowed;
}

export function localOperatorCan(permission: string, objectType: string, objectId: string): boolean {
  return authorizePermission({
    localOperator: true,
    permission,
    objectType,
    objectId,
  }).allowed;
}

function getScopedContext(agentId: string): CapabilityContextLike | undefined {
  const ctx = getContext();
  if (!ctx?.context) return undefined;
  if (ctx.agentId && ctx.agentId !== agentId) return undefined;
  return ctx.context;
}

export function canWithCapabilityContext(
  context: CapabilityContextLike,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  return authorizePermission({
    context,
    permission,
    objectType,
    objectId,
  }).allowed;
}

export function canWithCapabilities(
  capabilities: ContextCapability[],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  return authorizePermission({
    capabilities,
    permission,
    objectType,
    objectId,
  }).allowed;
}

export function materializeSubjectCapabilities(
  subjectType: string,
  subjectId: string,
  options: PermissionProviderCapabilityOptions = {},
  providers: PermissionProvider[] = getConfiguredCapabilityMaterializers(),
): ContextCapability[] {
  return materializeFromProviders(
    { type: subjectType, id: subjectId },
    options,
    providers,
    (provider, subject, providerOptions) => provider.materializeCapabilities?.(subject, providerOptions) ?? [],
  );
}

export function materializeSubjectDelegationOverrides(
  subjectType: string,
  subjectId: string,
  options: PermissionProviderCapabilityOptions = {},
  providers: PermissionProvider[] = getConfiguredCapabilityMaterializers(),
): ContextCapability[] {
  return materializeFromProviders(
    { type: subjectType, id: subjectId },
    options,
    providers,
    (provider, subject, providerOptions) => provider.materializeDelegationOverrides?.(subject, providerOptions) ?? [],
  );
}

export function isSuperadmin(subjectType: string, subjectId: string): boolean {
  return can(subjectType, subjectId, "admin", "system", "*");
}

export function isAgentSuperadmin(agentId: string | undefined): boolean {
  return Boolean(agentId && isSuperadmin("agent", agentId));
}

export function isDelegatedAuthorityContext(context: Pick<CapabilityContextLike, "kind" | "metadata">): boolean {
  if (context.kind === "turn-runtime" || context.kind === "invocation-runtime") {
    return true;
  }
  return context.metadata?.authorityMode === "delegated";
}

function evaluateProviderChain(
  request: PermissionProviderRequest,
  providers: PermissionProvider[],
  startedAt: number,
): PermissionProviderDecision {
  const applicable = providers.filter((provider) => provider.supports(request));
  if (applicable.length === 0) {
    return deny(request, "provider-runtime", "runtime", "no_permission_provider_configured", undefined, startedAt);
  }

  let allowDecision: PermissionProviderDecision | null = null;

  for (const provider of applicable) {
    const decision = authorizeProvider(provider, request);

    if (decision.decision === "deny" || decision.decision === "needs_approval") {
      return normalizeDecision(request, decision, startedAt);
    }

    if (decision.decision === "allow") {
      allowDecision = normalizeDecision(request, decision, startedAt);
      continue;
    }

    if (provider.required && decision.decision === "not_applicable") {
      return deny(request, provider.id, provider.version, "required_provider_not_applicable", undefined, startedAt);
    }
  }

  return allowDecision ?? deny(request, "provider-runtime", "runtime", "no_provider_allowed", undefined, startedAt);
}

function materializeFromProviders(
  subject: PermissionProviderSubject,
  options: PermissionProviderCapabilityOptions,
  providers: PermissionProvider[],
  read: (
    provider: PermissionProvider,
    subject: PermissionProviderSubject,
    options: PermissionProviderCapabilityOptions,
  ) => ContextCapability[],
): ContextCapability[] {
  return dedupeCapabilities(providers.flatMap((provider) => read(provider, subject, options)));
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function authorizeProvider(
  provider: PermissionProvider,
  request: PermissionProviderRequest,
): PermissionProviderDecision {
  try {
    return provider.authorize(request);
  } catch (error) {
    return deny(
      request,
      provider.id,
      provider.version,
      "provider_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeDecision(
  request: PermissionProviderRequest,
  decision: PermissionProviderDecision,
  startedAt: number,
): PermissionProviderDecision {
  return {
    ...decision,
    allowed: decision.decision === "allow",
    permission: decision.permission || request.permission,
    objectType: decision.objectType || request.objectType,
    objectId: decision.objectId || request.objectId,
    requestId: decision.requestId ?? request.requestId,
    durationMs: elapsedMs(startedAt),
  };
}

function deny(
  request: PermissionProviderRequest,
  providerId: string,
  providerVersion: string,
  reasonCode: string,
  reason?: string,
  startedAt?: number,
): PermissionProviderDecision {
  return {
    decision: "deny",
    allowed: false,
    providerId,
    providerVersion,
    reasonCode,
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    requestId: request.requestId,
    ...(startedAt !== undefined ? { durationMs: elapsedMs(startedAt) } : {}),
    ...(request.subject ? { subject: request.subject } : {}),
    ...(contextIdFrom(request.context) ? { contextId: contextIdFrom(request.context) } : {}),
    ...(reason ? { evidence: [{ kind: "error", message: reason }] } : {}),
  };
}

function withRequestId(request: PermissionProviderRequest): PermissionProviderRequest {
  return request.requestId ? request : { ...request, requestId: randomUUID() };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function contextIdFrom(context: PermissionProviderRequest["context"]): string | undefined {
  const value = (context as { contextId?: unknown } | null | undefined)?.contextId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
