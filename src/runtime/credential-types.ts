import type { RuntimeProviderId } from "./types.js";

export type RuntimeCredentialStatus =
  | "healthy"
  | "cooldown"
  | "exhausted"
  | "invalid"
  | "needs_reauth"
  | "disabled"
  | "unknown";

export type RuntimeCredentialSourceKind =
  | "env"
  | "provider-profile"
  | "provider-config"
  | "keychain"
  | "helper"
  | "ravi-secret"
  | "plaintext-file";

export type RuntimeCredentialTargetKind = "env" | "auth-profile" | "provider-config";

export type RuntimeCredentialPoolStrategy = "fill_first" | "round_robin" | "random" | "least_used";

export interface RuntimeCredentialSecretBinding {
  id: string;
  credentialId: string;
  sourceKind: RuntimeCredentialSourceKind;
  targetKind: RuntimeCredentialTargetKind;
  targetName: string;
  secretRef: string;
  sourceHint?: string;
  sensitive: boolean;
  remoteForward: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeCredentialRecord {
  id: string;
  label: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  modelAllowlist: string[];
  modelDenylist: string[];
  agentAllowlist: string[];
  taskProfileAllowlist: string[];
  priority: number;
  weight?: number;
  enabled: boolean;
  status: RuntimeCredentialStatus;
  authMethod?: string;
  sourceKind?: RuntimeCredentialSourceKind;
  strategyHint?: RuntimeCredentialPoolStrategy;
  sessionCompatibilityKey?: string;
  authProfileRef?: string;
  fingerprint: string;
  sensitiveEnvKeys: string[];
  remoteForwardEnvKeys: string[];
  lastErrorCode?: string;
  lastErrorReason?: string;
  lastErrorMessageRedacted?: string;
  resetAt?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  bindings: RuntimeCredentialSecretBinding[];
}

export interface RuntimeCredentialInput {
  id?: string;
  label: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  modelAllowlist?: string[];
  modelDenylist?: string[];
  agentAllowlist?: string[];
  taskProfileAllowlist?: string[];
  priority?: number;
  weight?: number;
  enabled?: boolean;
  status?: RuntimeCredentialStatus;
  authMethod?: string;
  sourceKind?: RuntimeCredentialSourceKind;
  strategyHint?: RuntimeCredentialPoolStrategy;
  sessionCompatibilityKey?: string;
  authProfileRef?: string;
  sensitiveEnvKeys?: string[];
  remoteForwardEnvKeys?: string[];
  notes?: string;
  bindings: Array<
    Omit<RuntimeCredentialSecretBinding, "id" | "credentialId" | "createdAt" | "updatedAt"> & { id?: string }
  >;
}

export interface RuntimeCredentialHealth {
  credentialId: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  resetAt?: number;
  consecutiveFailures: number;
  requestCount: number;
  lastFailureKind?: RuntimeCredentialFailureKind;
  lastFailureConfidence?: RuntimeCredentialFailureConfidence;
  lastRequestId?: string;
  updatedAt: number;
}

export type RuntimeCredentialFailureKind =
  | "rate_limited"
  | "quota_exhausted"
  | "billing_blocked"
  | "auth_invalid"
  | "permission_denied"
  | "provider_overloaded"
  | "network_transient"
  | "context_limit"
  | "invalid_request"
  | "unknown";

export type RuntimeCredentialFailureConfidence = "high" | "medium" | "low";
export type RuntimeCredentialFailureScope =
  | "credential"
  | "account"
  | "project"
  | "organization"
  | "model"
  | "provider"
  | "request"
  | "unknown";

export interface RuntimeCredentialLimitDimension {
  name: string;
  limit?: number;
  remaining?: number;
  resetAt?: number;
}

export interface RuntimeCredentialFailureSignal {
  kind: RuntimeCredentialFailureKind;
  confidence: RuntimeCredentialFailureConfidence;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  model?: string;
  credentialId?: string;
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  message?: string;
  retryAfterMs?: number;
  resetAt?: number;
  requestId?: string;
  rawHeaders?: Record<string, string>;
  scope?: RuntimeCredentialFailureScope;
  retryableByCredential?: boolean;
  source: "http" | "sdk-error" | "cli-event" | "stderr" | "rpc-error" | "heuristic";
  limitDimensions?: RuntimeCredentialLimitDimension[];
}

export interface RuntimeCredentialLimitPressure {
  nearLimit: boolean;
  exhausted: boolean;
  minRemainingRatio?: number;
  dimensions: RuntimeCredentialLimitDimension[];
}

export interface RuntimeCredentialSelectionRequest {
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  model?: string;
  agentId?: string;
  taskProfile?: string;
  sessionKey?: string;
  sessionName?: string;
  runId?: string;
  turnId?: string;
  now?: number;
}

export interface RuntimeCredentialAttemptBinding {
  attemptId?: string;
  credentialId: string;
  label: string;
  fingerprint: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  authMethod?: string;
  sessionCompatibilityKey?: string;
  authProfileRef?: string;
  resolvedEnv: Record<string, string>;
  sensitiveEnvKeys: string[];
  remoteForwardEnvKeys: string[];
  bindings: RuntimeCredentialSecretBinding[];
}

export interface RuntimeCredentialProviderHealth {
  id: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  model?: string;
  scope?: string;
  kind: RuntimeCredentialFailureKind;
  cooldownUntil?: number;
  lastRequestId?: string;
  reason?: string;
  updatedAt: number;
}

export type RuntimeCredentialRefreshReason =
  | "preselect"
  | "operator"
  | "retryable_failure"
  | "near_limit"
  | "expired_cooldown";

export type RuntimeCredentialRefreshAction =
  | "skipped"
  | "recovered"
  | "refreshed"
  | "adopted"
  | "unsupported"
  | "failed";

export interface RuntimeCredentialRefreshRequest {
  credential: RuntimeCredentialRecord;
  health: RuntimeCredentialHealth | null;
  reason: RuntimeCredentialRefreshReason;
  force?: boolean;
  now: number;
}

export interface RuntimeCredentialRefreshHookResult {
  action: Exclude<RuntimeCredentialRefreshAction, "recovered">;
  message?: string;
  resetHealth?: boolean;
  metadata?: Record<string, unknown>;
}

export type RuntimeCredentialRefreshHook = (
  request: RuntimeCredentialRefreshRequest,
) => Promise<RuntimeCredentialRefreshHookResult> | RuntimeCredentialRefreshHookResult;

export interface RuntimeCredentialRefreshResult {
  credentialId: string;
  label: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  statusBefore: RuntimeCredentialStatus;
  statusAfter: RuntimeCredentialStatus;
  action: RuntimeCredentialRefreshAction;
  reason: RuntimeCredentialRefreshReason;
  message?: string;
  resetAt?: number;
  cooldownUntil?: number;
  refreshedAt: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeCredentialSessionMetadata {
  attemptId?: string | null;
  credentialId: string;
  fingerprint: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider?: string;
  authMethod?: string;
  sessionCompatibilityKey?: string;
}
