import { inspectRuntimeCredentialAvailability } from "./credential-resolver.js";
import { resolveRuntimeCredentialUpstreamProvider } from "./runtime-request-builder.js";
import type { RuntimeTarget, RuntimeTargetPolicy } from "./target-policy.js";

export interface RuntimeTargetCredentialEligibilityOptions {
  agentId: string;
  taskProfileId?: string;
  env?: Record<string, string | undefined>;
  now?: number;
}

export function resolveRuntimeTargetCredentialEligibility(
  policy: RuntimeTargetPolicy,
  options: RuntimeTargetCredentialEligibilityOptions,
): Map<string, { eligible: boolean; detail?: string }> {
  return new Map<string, { eligible: boolean; detail?: string }>(
    policy.targets.map((target) => {
      const availability = inspectRuntimeCredentialAvailability({
        runtimeProvider: target.runtimeProvider,
        upstreamProvider: resolveRuntimeCredentialUpstreamProvider(target.runtimeProvider, target.model),
        model: target.model,
        agentId: options.agentId,
        ...(options.taskProfileId ? { taskProfile: options.taskProfileId } : {}),
        ...(target.credentialRequirements?.credentialIds
          ? { credentialIds: target.credentialRequirements.credentialIds }
          : {}),
        ...(target.credentialRequirements?.authMethods
          ? { authMethods: target.credentialRequirements.authMethods }
          : {}),
        ...(target.credentialRequirements?.sessionCompatibilityKey
          ? { sessionCompatibilityKey: target.credentialRequirements.sessionCompatibilityKey }
          : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        refreshPool: false,
      });
      const requiresManaged = runtimeTargetRequiresManagedCredential(target);
      if (availability.attemptBinding || (!availability.managedPoolConfigured && !requiresManaged)) {
        return [target.id, { eligible: true }] as const;
      }
      return [
        target.id,
        {
          eligible: false,
          detail: formatCredentialUnavailability(target, availability.rejected, availability.managedPoolConfigured),
        },
      ] as const;
    }),
  );
}

export function runtimeTargetRequiresManagedCredential(target: RuntimeTarget): boolean {
  const requirements = target.credentialRequirements;
  return Boolean(
    requirements &&
      (requirements.requireManaged ||
        requirements.credentialIds?.length ||
        requirements.authMethods?.length ||
        requirements.sessionCompatibilityKey),
  );
}

function formatCredentialUnavailability(
  target: RuntimeTarget,
  rejected: Array<{ label: string; reason: string }>,
  managedPoolConfigured: boolean,
): string {
  const reasonSummary = rejected
    .slice(0, 5)
    .map((item) => `${item.label}: ${item.reason}`)
    .join("; ");
  if (reasonSummary) return reasonSummary;
  return managedPoolConfigured
    ? `no managed credential resolved for ${target.runtimeProvider}/${target.model}`
    : `managed credential required for ${target.runtimeProvider}/${target.model}`;
}
