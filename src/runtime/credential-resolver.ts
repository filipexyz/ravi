import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { selectRuntimeCredential, type RuntimeCredentialSelectionResult } from "./credential-pool.js";
import { refreshRuntimeCredentialPool } from "./credential-refresh.js";
import type {
  RuntimeCredentialAttemptBinding,
  RuntimeCredentialRecord,
  RuntimeCredentialSecretBinding,
  RuntimeCredentialSessionMetadata,
  RuntimeCredentialSelectionRequest,
} from "./credential-types.js";

export interface RuntimeCredentialResolutionResult {
  attemptBinding: RuntimeCredentialAttemptBinding | null;
  selected: RuntimeCredentialRecord | null;
  candidates: RuntimeCredentialRecord[];
  rejected: RuntimeCredentialSelectionResult["rejected"];
  managedPoolConfigured: boolean;
}

export interface RuntimeCredentialResolveOptions extends RuntimeCredentialSelectionRequest {
  env?: Record<string, string | undefined>;
  refreshPool?: boolean;
}

export async function resolveRuntimeCredentialAttemptBinding(
  options: RuntimeCredentialResolveOptions,
): Promise<RuntimeCredentialResolutionResult> {
  if (options.refreshPool !== false) {
    await refreshRuntimeCredentialPool({ ...options, reason: "preselect" });
  }
  return executeWrite(
    getDb(),
    (db) => {
      const selection = selectRuntimeCredential(options);
      const rejected = [...selection.rejected];
      const managedPoolConfigured = selection.candidates.length > 0 || selection.rejected.length > 0;

      for (const candidate of selection.candidates) {
        const attempt = tryResolveAttemptBinding(candidate, options.env ?? process.env);
        if (attempt.ok) {
          const attemptId = `rcatt_${randomUUID()}`;
          db.prepare(
            `
            INSERT INTO runtime_credential_attempts (
              id, session_key, session_name, run_id, turn_id, runtime_provider, upstream_provider,
              model, credential_id, status, started_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
          `,
          ).run(
            attemptId,
            options.sessionKey ?? null,
            options.sessionName ?? null,
            options.runId ?? null,
            options.turnId ?? null,
            options.runtimeProvider,
            options.upstreamProvider ?? candidate.upstreamProvider ?? null,
            options.model ?? null,
            candidate.id,
            options.now ?? Date.now(),
            JSON.stringify({ reason: "preselect" }),
          );
          return {
            attemptBinding: {
              ...attempt.binding,
              attemptId,
            },
            selected: candidate,
            candidates: selection.candidates,
            rejected,
            managedPoolConfigured,
          };
        }
        rejected.push({
          credentialId: candidate.id,
          label: candidate.label,
          reason: attempt.reason,
        });
      }

      return {
        attemptBinding: null,
        selected: null,
        candidates: selection.candidates,
        rejected,
        managedPoolConfigured,
      };
    },
    { label: "runtime-credential-resolve-attempt" },
  );
}

export function buildRuntimeCredentialSessionMetadata(
  binding: RuntimeCredentialAttemptBinding,
): RuntimeCredentialSessionMetadata {
  return {
    attemptId: binding.attemptId ?? null,
    credentialId: binding.credentialId,
    fingerprint: binding.fingerprint,
    runtimeProvider: binding.runtimeProvider,
    ...(binding.upstreamProvider ? { upstreamProvider: binding.upstreamProvider } : {}),
    ...(binding.authMethod ? { authMethod: binding.authMethod } : {}),
    ...(binding.sessionCompatibilityKey ? { sessionCompatibilityKey: binding.sessionCompatibilityKey } : {}),
  };
}

export function mergeRuntimeCredentialSessionMetadata(
  params: Record<string, unknown> | undefined,
  binding: RuntimeCredentialAttemptBinding | undefined,
): Record<string, unknown> | undefined {
  if (!binding) return params;
  return {
    ...(params ?? {}),
    runtimeCredential: buildRuntimeCredentialSessionMetadata(binding),
  };
}

export function readRuntimeCredentialSessionMetadata(
  params: Record<string, unknown> | undefined,
): RuntimeCredentialSessionMetadata | undefined {
  const raw = params?.runtimeCredential;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.credentialId !== "string" ||
    typeof record.fingerprint !== "string" ||
    typeof record.runtimeProvider !== "string"
  ) {
    return undefined;
  }
  return {
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
    credentialId: record.credentialId,
    fingerprint: record.fingerprint,
    runtimeProvider: record.runtimeProvider,
    ...(typeof record.upstreamProvider === "string" ? { upstreamProvider: record.upstreamProvider } : {}),
    ...(typeof record.authMethod === "string" ? { authMethod: record.authMethod } : {}),
    ...(typeof record.sessionCompatibilityKey === "string"
      ? { sessionCompatibilityKey: record.sessionCompatibilityKey }
      : {}),
  };
}

export function isRuntimeCredentialSessionCompatible(
  params: Record<string, unknown> | undefined,
  binding: RuntimeCredentialAttemptBinding | null | undefined,
): boolean {
  if (!binding) return readRuntimeCredentialSessionMetadata(params) === undefined;
  const stored = readRuntimeCredentialSessionMetadata(params);
  if (!stored) return false;
  if (stored.runtimeProvider !== binding.runtimeProvider) return false;
  if ((stored.upstreamProvider ?? "") !== (binding.upstreamProvider ?? "")) return false;
  if (stored.fingerprint !== binding.fingerprint) return false;
  return (
    (stored.sessionCompatibilityKey ?? stored.credentialId) ===
    (binding.sessionCompatibilityKey ?? binding.credentialId)
  );
}

export function serializeRuntimeCredentialAttemptBinding(binding: RuntimeCredentialAttemptBinding) {
  return {
    attemptId: binding.attemptId ?? null,
    credentialId: binding.credentialId,
    label: binding.label,
    fingerprint: binding.fingerprint,
    runtimeProvider: binding.runtimeProvider,
    upstreamProvider: binding.upstreamProvider ?? null,
    authMethod: binding.authMethod ?? null,
    sessionCompatibilityKey: binding.sessionCompatibilityKey ?? null,
    authProfileRef: binding.authProfileRef ? redactPath(binding.authProfileRef) : null,
    envKeys: Object.keys(binding.resolvedEnv).map(redactEnvName).sort(),
    sensitiveEnvKeys: binding.sensitiveEnvKeys.map(redactEnvName).sort(),
    remoteForwardEnvKeys: binding.remoteForwardEnvKeys.map(redactEnvName).sort(),
    bindings: binding.bindings.map((item) => ({
      id: item.id,
      sourceKind: item.sourceKind,
      targetKind: item.targetKind,
      targetName: redactEnvName(item.targetName),
      secretRef: redactSecretRef(item.secretRef),
      sensitive: item.sensitive,
      remoteForward: item.remoteForward,
    })),
  };
}

function tryResolveAttemptBinding(
  credential: RuntimeCredentialRecord,
  env: Record<string, string | undefined>,
): { ok: true; binding: RuntimeCredentialAttemptBinding } | { ok: false; reason: string } {
  const resolvedEnv: Record<string, string> = {};

  for (const binding of credential.bindings) {
    if (binding.targetKind !== "env") continue;
    const resolved = resolveSecretBinding(binding, env);
    if (!resolved.ok) return resolved;
    resolvedEnv[binding.targetName] = resolved.value;
  }

  return {
    ok: true,
    binding: {
      credentialId: credential.id,
      label: credential.label,
      fingerprint: credential.fingerprint,
      runtimeProvider: credential.runtimeProvider,
      ...(credential.upstreamProvider ? { upstreamProvider: credential.upstreamProvider } : {}),
      ...(credential.authMethod ? { authMethod: credential.authMethod } : {}),
      ...(credential.sessionCompatibilityKey ? { sessionCompatibilityKey: credential.sessionCompatibilityKey } : {}),
      ...(credential.authProfileRef ? { authProfileRef: credential.authProfileRef } : {}),
      resolvedEnv,
      sensitiveEnvKeys: credential.sensitiveEnvKeys,
      remoteForwardEnvKeys: credential.remoteForwardEnvKeys,
      bindings: credential.bindings,
    },
  };
}

function resolveSecretBinding(
  binding: RuntimeCredentialSecretBinding,
  env: Record<string, string | undefined>,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (binding.sourceKind !== "env" || !binding.secretRef.startsWith("env:")) {
    return {
      ok: false,
      reason: `unsupported_secret_source:${binding.sourceKind}:${binding.targetKind}`,
    };
  }

  const envName = binding.secretRef.slice("env:".length);
  const value = env[envName]?.trim();
  if (!value) {
    return {
      ok: false,
      reason: `missing_secret:${redactSecretRef(binding.secretRef)}`,
    };
  }
  return { ok: true, value };
}

function redactSecretRef(secretRef: string): string {
  if (secretRef.startsWith("env:")) return `env:${redactEnvName(secretRef.slice(4))}`;
  if (secretRef.startsWith("file:")) return `file:${redactPath(secretRef.slice(5))}`;
  const [kind] = secretRef.split(":", 1);
  return kind ? `${kind}:[redacted]` : "[redacted]";
}

function redactEnvName(value: string): string {
  if (!value) return value;
  const parts = value.split("_");
  if (parts.length <= 2) return value;
  return `${parts[0]}_${parts[1]}_[redacted]`;
}

function redactPath(value: string): string {
  return value.replace(/\/Users\/[^/]+/g, "/Users/[redacted]");
}
