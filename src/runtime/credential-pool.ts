import {
  getRuntimeCredentialActiveAttemptCount,
  listRuntimeCredentials,
  getRuntimeCredentialHealth,
} from "./credential-store.js";
import type {
  RuntimeCredentialRecord,
  RuntimeCredentialSelectionRequest,
  RuntimeCredentialStatus,
} from "./credential-types.js";

const INELIGIBLE_STATUSES = new Set<RuntimeCredentialStatus>([
  "cooldown",
  "exhausted",
  "invalid",
  "needs_reauth",
  "disabled",
]);

export interface RuntimeCredentialSelectionResult {
  credential: RuntimeCredentialRecord | null;
  candidates: RuntimeCredentialRecord[];
  rejected: Array<{
    credentialId: string;
    label: string;
    reason: string;
  }>;
}

export function selectRuntimeCredential(request: RuntimeCredentialSelectionRequest): RuntimeCredentialSelectionResult {
  const now = request.now ?? Date.now();
  const page = listRuntimeCredentials({
    runtimeProvider: request.runtimeProvider,
    includeDisabled: true,
    limit: 500,
  });
  const candidates: RuntimeCredentialRecord[] = [];
  const rejected: RuntimeCredentialSelectionResult["rejected"] = [];

  for (const credential of page.items) {
    const reason = getIneligibilityReason(credential, request, now);
    if (reason) {
      rejected.push({ credentialId: credential.id, label: credential.label, reason });
      continue;
    }
    candidates.push(credential);
  }

  candidates.sort((a, b) => {
    const priority = b.priority - a.priority;
    if (priority !== 0) return priority;
    const activeAttempts = getRuntimeCredentialActiveAttemptCount(a.id) - getRuntimeCredentialActiveAttemptCount(b.id);
    if (activeAttempts !== 0) return activeAttempts;
    const aHealth = getRuntimeCredentialHealth(a.id);
    const bHealth = getRuntimeCredentialHealth(b.id);
    const requestCount = (aHealth?.requestCount ?? 0) - (bHealth?.requestCount ?? 0);
    if (requestCount !== 0) return requestCount;
    const lastUsed = (aHealth?.lastSuccessAt ?? 0) - (bHealth?.lastSuccessAt ?? 0);
    if (lastUsed !== 0) return lastUsed;
    return a.id.localeCompare(b.id);
  });

  return {
    credential: candidates[0] ?? null,
    candidates,
    rejected,
  };
}

function getIneligibilityReason(
  credential: RuntimeCredentialRecord,
  request: RuntimeCredentialSelectionRequest,
  now: number,
): string | null {
  if (!credential.enabled) return "disabled";
  const health = getRuntimeCredentialHealth(credential.id);
  if (credential.status === "cooldown") {
    const readyAt = earliestReadyAt(health?.cooldownUntil, credential.resetAt, health?.resetAt);
    if (readyAt === undefined || readyAt > now) return "status:cooldown";
  } else if (credential.status === "exhausted") {
    const readyAt = earliestReadyAt(credential.resetAt, health?.resetAt);
    if (readyAt === undefined || readyAt > now) return "status:exhausted";
  } else if (INELIGIBLE_STATUSES.has(credential.status)) {
    return `status:${credential.status}`;
  }
  if (health?.cooldownUntil && health.cooldownUntil > now) return "cooldown";
  if (!matchesOptional(credential.upstreamProvider, request.upstreamProvider)) return "upstream_mismatch";
  if (!matchesAllowlist(credential.modelAllowlist, request.model)) return "model_not_allowed";
  if (matchesDenylist(credential.modelDenylist, request.model)) return "model_denied";
  if (request.credentialIds?.length && !request.credentialIds.includes(credential.id)) return "credential_not_allowed";
  if (request.authMethods?.length && (!credential.authMethod || !request.authMethods.includes(credential.authMethod))) {
    return "auth_method_not_allowed";
  }
  if (request.sessionCompatibilityKey && credential.sessionCompatibilityKey !== request.sessionCompatibilityKey) {
    return "session_compatibility_mismatch";
  }
  if (!matchesAllowlist(credential.agentAllowlist, request.agentId)) return "agent_not_allowed";
  if (!matchesAllowlist(credential.taskProfileAllowlist, request.taskProfile)) return "task_profile_not_allowed";
  return null;
}

function earliestReadyAt(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return present.length > 0 ? Math.min(...present) : undefined;
}

function matchesOptional(configured: string | undefined, requested: string | undefined): boolean {
  if (!configured) return true;
  return configured === requested;
}

function matchesAllowlist(allowlist: string[], value: string | undefined): boolean {
  if (!allowlist.length) return true;
  if (!value) return false;
  return allowlist.includes(value);
}

function matchesDenylist(denylist: string[], value: string | undefined): boolean {
  if (!denylist.length || !value) return false;
  return denylist.includes(value);
}
