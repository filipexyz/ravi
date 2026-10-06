import { readSecret, redactSecretRef } from "./backends.js";
import { getCredentialConnection, recordCredentialAuditEvent, type CredentialStoreOptions } from "./store.js";
import type { CredentialConnectionRecord, CredentialPolicyExplanation, PublicCredentialConnection } from "./types.js";

export function explainCredentialPolicy(input: {
  provider: string;
  connection: string;
  action: string;
}): CredentialPolicyExplanation {
  return {
    provider: input.provider,
    connection: input.connection,
    action: input.action,
    requiredCapabilities: [
      `use:credential:${input.provider}:${input.connection}`,
      `execute:${input.provider}:${input.action}`,
    ],
    approval: {
      required: isSensitiveAction(input.action),
      reason: isSensitiveAction(input.action) ? "write_or_destructive_provider_action" : "read_only_provider_action",
    },
  };
}

export async function resolveCredentialSecret(input: {
  provider: string;
  connection: string;
  action: string;
  options?: CredentialStoreOptions;
}): Promise<{ connection: CredentialConnectionRecord; secret: string; policy: CredentialPolicyExplanation }> {
  const connection = getCredentialConnection(input.provider, input.connection, input.options);
  if (!connection) {
    throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
  }
  if (connection.status !== "active") {
    throw new Error(`Connection disabled: ${input.provider}:${input.connection}`);
  }
  const policy = explainCredentialPolicy({
    provider: connection.provider,
    connection: connection.connection,
    action: input.action,
  });
  const audit = (resultStatus: string, errorCode?: CredentialSecretErrorCode) =>
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision: "allow",
        approvalRequired: policy.approval.required,
        approvalStatus: policy.approval.required ? "not_requested" : null,
        resultStatus,
        ...(errorCode ? { errorCode } : {}),
      },
      input.options,
    );

  // Decision evidence goes first: if it cannot be written, the secret is never read.
  try {
    audit("secret_requested");
  } catch {
    throw new CredentialAuditWriteError();
  }

  let secret: string;
  try {
    secret = await readSecret(connection.secretRef);
  } catch (error) {
    try {
      audit("failed", classifySecretReadError(error));
    } catch {
      // The read already failed and nothing is released; keep the original error.
    }
    throw error;
  }

  // Result evidence goes before release: if it cannot be written, the secret is dropped.
  try {
    audit("secret_resolved");
  } catch {
    throw new CredentialAuditWriteError();
  }
  return { connection, secret, policy };
}

/**
 * Closed set of codes stored in `credential_audit_events.error_code`. Raw
 * exception text never reaches audit evidence: it can carry secret coordinates
 * or backend output.
 */
export const CREDENTIAL_SECRET_ERROR_CODES = [
  "unsupported_secret_ref",
  "invalid_secret_ref",
  "secret_not_found",
  "backend_not_configured",
  "backend_request_failed",
  "secret_read_failed",
] as const;

export type CredentialSecretErrorCode = (typeof CREDENTIAL_SECRET_ERROR_CODES)[number];

export function classifySecretReadError(error: unknown): CredentialSecretErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (/^Unsupported secret ref:/.test(message)) return "unsupported_secret_ref";
  if (/^Invalid (keychain|vault) secret ref:/.test(message)) return "invalid_secret_ref";
  if (/^Vault secret key not found:/.test(message) || /could not be found/.test(message)) return "secret_not_found";
  if (/^VAULT_ADDR and VAULT_TOKEN are required/.test(message)) return "backend_not_configured";
  if (/^Vault request failed/.test(message) || /^security failed:/.test(message)) return "backend_request_failed";
  return "secret_read_failed";
}

export class CredentialAuditWriteError extends Error {
  readonly code = "credential_audit_write_failed";

  constructor() {
    super("Credential audit evidence could not be recorded; the secret was not released.");
    this.name = "CredentialAuditWriteError";
  }
}

export async function execCredentialBroker(input: {
  provider: string;
  connection: string;
  action: string;
  dryRun: boolean;
  options?: CredentialStoreOptions;
}) {
  const record = getCredentialConnection(input.provider, input.connection, input.options);
  if (!record) throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
  const policy = explainCredentialPolicy({
    provider: record.provider,
    connection: record.connection,
    action: input.action,
  });

  if (input.dryRun) {
    return {
      status: "planned" as const,
      dryRun: true,
      connection: publicCredentialConnection(record),
      policy,
      secretResolved: false,
      result: null,
    };
  }

  const { secret } = await resolveCredentialSecret({
    provider: record.provider,
    connection: record.connection,
    action: input.action,
    options: input.options,
  });
  return {
    status: "executed" as const,
    dryRun: false,
    connection: publicCredentialConnection(record),
    policy,
    secretResolved: Boolean(secret),
    result: {
      adapter: "credentials",
      action: input.action,
      note: "Secret was resolved in-process and intentionally not returned.",
    },
  };
}

export function publicCredentialConnection(record: CredentialConnectionRecord): PublicCredentialConnection {
  return {
    id: record.id,
    provider: record.provider,
    connection: record.connection,
    label: record.label,
    backend: record.backend,
    secretRef: redactSecretRef(record.secretRef),
    scopes: record.scopes,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isSensitiveAction(action: string): boolean {
  return !/^(auth\.check|whoami|channels\.list|channels\.info|users\.list|users\.info)$/.test(action);
}
