import { readSecret, redactSecretRef } from "./backends.ts";
import { ConnectionStore } from "./store.ts";
import type { PolicyExplanation } from "./types.ts";

export function explainPolicy(input: {
  provider: string;
  connection: string;
  action: string;
}): PolicyExplanation {
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

export async function execBroker(input: {
  store: ConnectionStore;
  provider: string;
  connection: string;
  action: string;
  dryRun: boolean;
}) {
  const record = input.store.get(input.provider, input.connection);
  if (!record) throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
  const policy = explainPolicy(input);

  if (input.dryRun) {
    return {
      status: "planned" as const,
      dryRun: true,
      connection: publicConnection(record),
      policy,
      secretResolved: false,
      result: null,
    };
  }

  const secret = await readSecret(record.secretRef);
  return {
    status: "executed" as const,
    dryRun: false,
    connection: publicConnection(record),
    policy,
    secretResolved: Boolean(secret),
    result: {
      adapter: "poc",
      action: input.action,
      note: "Secret was resolved in-process and intentionally not returned.",
    },
  };
}

export function publicConnection(record: {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: string;
  secretRef: string;
  scopes: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}) {
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
