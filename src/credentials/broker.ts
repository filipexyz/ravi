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
  try {
    const secret = await readSecret(connection.secretRef);
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision: "allow",
        approvalRequired: policy.approval.required,
        approvalStatus: policy.approval.required ? "not_requested" : null,
        resultStatus: "secret_resolved",
      },
      input.options,
    );
    return { connection, secret, policy };
  } catch (error) {
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision: "allow",
        approvalRequired: policy.approval.required,
        approvalStatus: policy.approval.required ? "not_requested" : null,
        resultStatus: "failed",
        errorCode: error instanceof Error ? error.message.slice(0, 120) : "unknown_error",
      },
      input.options,
    );
    throw error;
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
