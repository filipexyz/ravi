import {
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  listRuntimeCredentials,
  resetRuntimeCredentialHealth,
} from "./credential-store.js";
import type {
  RuntimeCredentialRefreshHook,
  RuntimeCredentialRefreshReason,
  RuntimeCredentialRefreshResult,
  RuntimeCredentialRecord,
  RuntimeCredentialSelectionRequest,
  RuntimeCredentialStatus,
} from "./credential-types.js";
import type { RuntimeProviderId } from "./types.js";

const refreshHooks = new Map<RuntimeProviderId, RuntimeCredentialRefreshHook>();

export interface RuntimeCredentialRefreshOptions {
  reason?: RuntimeCredentialRefreshReason;
  force?: boolean;
  now?: number;
}

export interface RuntimeCredentialPoolRefreshOptions extends RuntimeCredentialSelectionRequest {
  reason?: RuntimeCredentialRefreshReason;
  force?: boolean;
}

export function registerRuntimeCredentialRefreshHook(
  runtimeProvider: RuntimeProviderId,
  hook: RuntimeCredentialRefreshHook,
): void {
  refreshHooks.set(runtimeProvider, hook);
}

export function unregisterRuntimeCredentialRefreshHook(runtimeProvider: RuntimeProviderId): void {
  refreshHooks.delete(runtimeProvider);
}

export async function refreshRuntimeCredential(
  credentialId: string,
  options: RuntimeCredentialRefreshOptions = {},
): Promise<RuntimeCredentialRefreshResult> {
  const now = options.now ?? Date.now();
  const reason = options.reason ?? "operator";
  const credential = getRuntimeCredential(credentialId);
  if (!credential) throw new Error(`Runtime credential not found: ${credentialId}`);
  const health = getRuntimeCredentialHealth(credentialId);

  const generic = recoverGenericCredentialState(credential, health, {
    force: options.force,
    reason,
    now,
  });
  if (generic) return generic;

  const hook = refreshHooks.get(credential.runtimeProvider);
  if (!hook) {
    return buildRefreshResult(credential, credential.status, {
      action: shouldSkipWithoutHook(credential.status) ? "skipped" : "unsupported",
      reason,
      now,
      message:
        shouldSkipWithoutHook(credential.status) && !options.force
          ? "credential does not need refresh"
          : "no provider-specific credential refresh hook registered",
      cooldownUntil: health?.cooldownUntil,
      resetAt: credential.resetAt ?? health?.resetAt,
    });
  }

  const hookResult = await hook({
    credential,
    health,
    reason,
    force: options.force,
    now,
  });

  if (hookResult.resetHealth || hookResult.action === "refreshed" || hookResult.action === "adopted") {
    const transition = resetRuntimeCredentialHealth(credential.id);
    return buildRefreshResult(credential, transition.credential.status, {
      action: hookResult.action,
      reason,
      now,
      message: hookResult.message,
      metadata: hookResult.metadata,
    });
  }

  return buildRefreshResult(credential, credential.status, {
    action: hookResult.action,
    reason,
    now,
    message: hookResult.message,
    cooldownUntil: health?.cooldownUntil,
    resetAt: credential.resetAt ?? health?.resetAt,
    metadata: hookResult.metadata,
  });
}

export async function refreshRuntimeCredentialPool(
  options: RuntimeCredentialPoolRefreshOptions,
): Promise<RuntimeCredentialRefreshResult[]> {
  const now = options.now ?? Date.now();
  const page = listRuntimeCredentials({
    runtimeProvider: options.runtimeProvider,
    includeDisabled: true,
    limit: 500,
  });
  const results: RuntimeCredentialRefreshResult[] = [];

  for (const credential of page.items) {
    if (!matchesCredentialRefreshScope(credential, options)) continue;
    const shouldRefresh = options.force || shouldAutoRefreshCredential(credential, now);
    if (!shouldRefresh) continue;
    results.push(
      await refreshRuntimeCredential(credential.id, {
        reason: options.reason ?? "preselect",
        force: options.force,
        now,
      }),
    );
  }

  return results;
}

function recoverGenericCredentialState(
  credential: RuntimeCredentialRecord,
  health: ReturnType<typeof getRuntimeCredentialHealth>,
  input: {
    force?: boolean;
    reason: RuntimeCredentialRefreshReason;
    now: number;
  },
): RuntimeCredentialRefreshResult | null {
  if (!credential.enabled || credential.status === "disabled") {
    return buildRefreshResult(credential, credential.status, {
      action: "skipped",
      reason: input.reason,
      now: input.now,
      message: "credential is disabled",
    });
  }

  const cooldownUntil = health?.cooldownUntil;
  const resetAt = credential.resetAt ?? health?.resetAt;
  const readyAt = earliestReadyAt(cooldownUntil, resetAt);
  const expiredCooldown = credential.status === "cooldown" && readyAt !== undefined && readyAt <= input.now;
  const expiredQuota = credential.status === "exhausted" && resetAt !== undefined && resetAt <= input.now;

  if (expiredCooldown || expiredQuota) {
    const transition = resetRuntimeCredentialHealth(credential.id);
    return buildRefreshResult(credential, transition.credential.status, {
      action: "recovered",
      reason: expiredCooldown ? "expired_cooldown" : input.reason,
      now: input.now,
      message: expiredCooldown ? "cooldown expired" : "quota reset window expired",
    });
  }

  if ((credential.status === "healthy" || credential.status === "unknown") && !input.force) {
    return buildRefreshResult(credential, credential.status, {
      action: "skipped",
      reason: input.reason,
      now: input.now,
      message: "credential does not need refresh",
    });
  }

  return null;
}

function shouldAutoRefreshCredential(credential: RuntimeCredentialRecord, now: number): boolean {
  if (!credential.enabled || credential.status === "disabled") return false;
  if (credential.status === "healthy" || credential.status === "unknown") return false;
  if (credential.status === "cooldown" || credential.status === "exhausted") {
    const health = getRuntimeCredentialHealth(credential.id);
    const readyAt = earliestReadyAt(health?.cooldownUntil, credential.resetAt ?? health?.resetAt);
    return readyAt !== undefined && readyAt <= now;
  }
  return credential.status === "needs_reauth" || credential.status === "invalid";
}

function matchesCredentialRefreshScope(
  credential: RuntimeCredentialRecord,
  request: RuntimeCredentialPoolRefreshOptions,
): boolean {
  if (!matchesOptional(credential.upstreamProvider, request.upstreamProvider)) return false;
  if (!matchesAllowlist(credential.modelAllowlist, request.model)) return false;
  if (matchesDenylist(credential.modelDenylist, request.model)) return false;
  if (!matchesAllowlist(credential.agentAllowlist, request.agentId)) return false;
  if (!matchesAllowlist(credential.taskProfileAllowlist, request.taskProfile)) return false;
  return true;
}

function earliestReadyAt(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (present.length === 0) return undefined;
  return Math.min(...present);
}

function shouldSkipWithoutHook(status: RuntimeCredentialStatus): boolean {
  return status === "healthy" || status === "unknown" || status === "disabled";
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

function buildRefreshResult(
  credential: RuntimeCredentialRecord,
  statusAfter: RuntimeCredentialStatus,
  input: {
    action: RuntimeCredentialRefreshResult["action"];
    reason: RuntimeCredentialRefreshReason;
    now: number;
    message?: string;
    cooldownUntil?: number;
    resetAt?: number;
    metadata?: Record<string, unknown>;
  },
): RuntimeCredentialRefreshResult {
  return {
    credentialId: credential.id,
    label: credential.label,
    runtimeProvider: credential.runtimeProvider,
    ...(credential.upstreamProvider ? { upstreamProvider: credential.upstreamProvider } : {}),
    statusBefore: credential.status,
    statusAfter,
    action: input.action,
    reason: input.reason,
    ...(input.message ? { message: input.message } : {}),
    ...(input.resetAt ? { resetAt: input.resetAt } : {}),
    ...(input.cooldownUntil ? { cooldownUntil: input.cooldownUntil } : {}),
    refreshedAt: input.now,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
