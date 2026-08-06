import "reflect-metadata";
import { z } from "zod";
import {
  deleteSecret,
  execCredentialBroker,
  explainCredentialPolicy,
  getCredentialConnection,
  listCredentialConnections,
  normalizeCredentialIdentifier,
  publicCredentialConnection,
  readSecretFromStdin,
  removeCredentialConnection,
  setCredentialConnectionStatus,
  upsertCredentialConnection,
  writeSecret,
  type CredentialBackend,
  type CredentialConnectionStatus,
} from "../../credentials/index.js";
import { buildCommand, buildOffsetPagination } from "../../utils/pagination.js";
import { contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { jsonObjectSchema } from "../return-schemas.js";

const publicCredentialConnectionSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    connection: z.string(),
    label: z.string().nullable(),
    backend: z.enum(["keychain", "vault"]),
    secretRef: z.string(),
    scopes: z.array(z.string()),
    status: z.enum(["active", "disabled"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const credentialPaginationSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean().optional(),
    nextOffset: z.number().nullable().optional(),
    nextCommand: z.string().nullable().optional(),
  })
  .strict();

const credentialConnectionsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: credentialPaginationSchema,
    items: z.array(publicCredentialConnectionSchema),
  })
  .strict();
const credentialConnectionReturnSchema = z.object({ connection: publicCredentialConnectionSchema }).strict();
const credentialRemoveReturnSchema = z
  .object({
    removed: publicCredentialConnectionSchema,
    secretDeleted: z.boolean(),
  })
  .strict();
const credentialStatusReturnSchema = z.object({ connection: publicCredentialConnectionSchema.nullable() }).strict();
const credentialPolicyReturnSchema = z
  .object({
    provider: z.string(),
    connection: z.string(),
    action: z.string(),
    requiredCapabilities: z.array(z.string()),
    approval: z
      .object({
        required: z.boolean(),
        reason: z.string(),
      })
      .strict(),
  })
  .strict();
const credentialBrokerReturnSchema = z
  .object({
    status: z.string(),
    dryRun: z.boolean(),
    connection: publicCredentialConnectionSchema,
    policy: credentialPolicyReturnSchema,
    secretResolved: z.boolean(),
    result: jsonObjectSchema.nullable(),
  })
  .strict();

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseIntOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

function collectCsv(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function backendValue(value: string | undefined): CredentialBackend {
  if (value === "keychain" || value === "vault") return value;
  throw new Error("--backend must be keychain or vault");
}

function statusValue(value: string | undefined): CredentialConnectionStatus | undefined {
  if (!value) return undefined;
  if (value === "active" || value === "disabled") return value;
  throw new Error("--status must be active or disabled");
}

/**
 * Manual v2 not-found envelope (exit 1). Connections live in the cheap local
 * credential store, so `provider:connection` pairs and ids feed `suggestions`.
 * Secret values, secret refs, and backend paths NEVER appear in the envelope.
 */
function failCredentialConnectionNotFound(op: string, provider: string, connection: string, asJson?: boolean): never {
  const candidates = listCredentialConnections({ includeDisabled: true, limit: 100 }).items.flatMap((record) => [
    `${record.provider}:${record.connection}`,
    record.id,
  ]);
  contractFail(op, "CREDENTIAL_CONNECTION_NOT_FOUND", `Connection not found: ${provider}:${connection}`, {
    asJson,
    details: {
      suggestedAction:
        "Check provider/connection ids (see suggestions; list with: ravi credentials connections list --json)",
      suggestions: suggestSimilar(`${provider}:${connection}`, candidates),
    },
  });
}

function printConnection(connection: ReturnType<typeof publicCredentialConnection>): void {
  console.log(`${connection.provider}:${connection.connection}`);
  console.log(`  id: ${connection.id}`);
  console.log(`  label: ${connection.label ?? "-"}`);
  console.log(`  backend: ${connection.backend}`);
  console.log(`  status: ${connection.status}`);
  console.log(`  secretRef: ${connection.secretRef}`);
  console.log(`  scopes: ${connection.scopes.length ? connection.scopes.join(", ") : "-"}`);
}

@Group({
  name: "credentials.connections",
  description: "Manage provider/action credential connections",
  scope: "admin",
})
export class CredentialConnectionsCommands {
  @Command({ name: "list", description: "List provider credential connections without secret values" })
  @CommandAccess({ kind: "read", resource: "credentials.connections", action: "list", risk: "low" })
  @Returns(credentialConnectionsListReturnSchema)
  list(
    @Option({ flags: "--provider <id>", description: "Filter by provider, e.g. slack" }) provider?: string,
    @Option({ flags: "--status <status>", description: "Filter by status: active or disabled" }) status?: string,
    @Option({ flags: "--all", description: "Include disabled connections" }) includeDisabled?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset", defaultValue: "0" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const page = listCredentialConnections({
      provider,
      status: statusValue(status),
      includeDisabled,
      limit: parseIntOption(limit, 50),
      offset: parseIntOption(offset, 0),
    });
    const items = pickFields(page.items.map(publicCredentialConnection), fields);
    const payload = {
      total: page.total,
      pagination: buildOffsetPagination({
        limit: page.limit,
        offset: page.offset,
        returned: items.length,
        total: page.total,
        nextCommand: (nextOffset) =>
          buildCommand([
            "ravi",
            "credentials",
            "connections",
            "list",
            provider && "--provider",
            provider,
            status && "--status",
            status,
            includeDisabled && "--all",
            "--limit",
            page.limit,
            "--offset",
            nextOffset,
          ]),
      }),
      items,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Connections (${items.length}/${page.total})`);
    for (const item of items) {
      console.log(`- ${item.provider}:${item.connection} ${item.status} backend=${item.backend}`);
    }
    if (payload.pagination.nextCommand) console.log(`Next: ${payload.pagination.nextCommand}`);
    return payload;
  }

  @Command({ name: "show", description: "Show one credential connection without secret values" })
  @CommandAccess({ kind: "read", resource: "credentials.connections", action: "show", risk: "low" })
  @Returns(credentialConnectionReturnSchema)
  show(
    @Option({ flags: "--provider <id>", description: "Provider id, e.g. slack" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id, e.g. main" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    const record = getCredentialConnection(provider, connection);
    if (!record) failCredentialConnectionNotFound("credentials connections show", provider, connection, asJson);
    const payload = { connection: publicCredentialConnection(record) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printConnection(payload.connection);
    return payload;
  }

  @Command({ name: "add", description: "Add or update a provider credential connection" })
  @CommandAccess({
    kind: "mutate",
    resource: "credentials.connections",
    action: "add",
    risk: "high",
    redactions: ["secret"],
  })
  @CliOnly()
  @Returns(credentialConnectionReturnSchema)
  async add(
    @Option({ flags: "--provider <id>", description: "Provider id, e.g. slack" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id, e.g. main" }) connection?: string,
    @Option({ flags: "--backend <backend>", description: "Secret backend: keychain or vault" }) backend?: string,
    @Option({ flags: "--label <text>", description: "Human label" }) label?: string,
    @Option({ flags: "--scope <scope>", description: "Scopes, comma-separated" }) scopes?: string,
    @Option({ flags: "--secret-stdin", description: "Read secret value from stdin and write it to backend" })
    secretStdin?: boolean,
    @Option({ flags: "--secret-ref <ref>", description: "Reference an existing backend secret" }) secretRef?: string,
    @Option({ flags: "--vault-mount <mount>", description: "Vault KV v2 mount", defaultValue: "secret" })
    vaultMount?: string,
    @Option({ flags: "--vault-path <path>", description: "Vault logical path" }) vaultPath?: string,
    @Option({ flags: "--vault-key <key>", description: "Vault data key", defaultValue: "token" }) vaultKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    const providerId = normalizeCredentialIdentifier(provider, "provider");
    const connectionId = normalizeCredentialIdentifier(connection, "connection");
    const resolvedBackend = backendValue(backend);
    if (secretStdin && secretRef) fail("Use either --secret-stdin or --secret-ref, not both.");
    if (!secretStdin && !secretRef) fail("Provide --secret-stdin or --secret-ref.");
    const resolvedSecretRef = secretRef
      ? secretRef
      : await writeSecret({
          backend: resolvedBackend,
          provider: providerId,
          connection: connectionId,
          secret: await readSecretFromStdin(),
          vaultMount,
          vaultPath,
          vaultKey,
        });
    const record = upsertCredentialConnection({
      provider: providerId,
      connection: connectionId,
      label,
      backend: resolvedBackend,
      secretRef: resolvedSecretRef,
      scopes: collectCsv(scopes),
      status: "active",
    });
    const payload = { connection: publicCredentialConnection(record) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Stored connection ${record.id} (${record.backend})`);
    return payload;
  }

  @Command({ name: "remove", description: "Remove provider credential connection metadata" })
  @CommandAccess({ kind: "mutate", resource: "credentials.connections", action: "remove", risk: "destructive" })
  @CliOnly()
  @Returns(credentialRemoveReturnSchema)
  async remove(
    @Option({ flags: "--provider <id>", description: "Provider id" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id" }) connection?: string,
    @Option({ flags: "--delete-secret", description: "Also delete the backend secret" }) deleteBackendSecret?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually remove the connection; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    // Validation runs BEFORE the brake: unknown targets exit 1 with the
    // not-found envelope instead of a useless dry-run plan.
    const existing = getCredentialConnection(provider, connection);
    if (!existing) failCredentialConnectionNotFound("credentials connections remove", provider, connection, asJson);
    if (execute !== true) {
      // Write brake (Manual v2 7.8): removing credential metadata (and
      // optionally the backend secret) is destructive, so dry-run by default
      // and exit 3 before any store/backend write. The plan intentionally
      // carries NO secret value and NO secret ref.
      contractDryRun(
        "credentials connections remove",
        {
          provider: existing.provider,
          connection: existing.connection,
          id: existing.id,
          label: existing.label ?? null,
          backend: existing.backend,
          status: existing.status,
          deleteBackendSecret: deleteBackendSecret === true,
        },
        { asJson },
      );
    }
    const removed = removeCredentialConnection(provider, connection);
    if (!removed) failCredentialConnectionNotFound("credentials connections remove", provider, connection, asJson);
    const secretDeleted = deleteBackendSecret ? await deleteSecret(removed.secretRef) : false;
    const payload = { removed: publicCredentialConnection(removed), secretDeleted };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Removed connection ${removed.id}${secretDeleted ? " and backend secret" : ""}`);
    return payload;
  }

  @Command({ name: "enable", description: "Enable a credential connection" })
  @CommandAccess({ kind: "mutate", resource: "credentials.connections", action: "enable", risk: "medium" })
  @Returns(credentialStatusReturnSchema)
  enable(
    @Option({ flags: "--provider <id>", description: "Provider id" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.setStatus(provider, connection, "active", asJson);
  }

  @Command({ name: "disable", description: "Disable a credential connection" })
  @CommandAccess({ kind: "mutate", resource: "credentials.connections", action: "disable", risk: "medium" })
  @Returns(credentialStatusReturnSchema)
  disable(
    @Option({ flags: "--provider <id>", description: "Provider id" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id" }) connection?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.setStatus(provider, connection, "disabled", asJson);
  }

  private setStatus(
    provider: string | undefined,
    connection: string | undefined,
    status: CredentialConnectionStatus,
    asJson?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    const op = status === "active" ? "credentials connections enable" : "credentials connections disable";
    const record = setCredentialConnectionStatus(provider, connection, status);
    if (!record) failCredentialConnectionNotFound(op, provider, connection, asJson);
    const payload = { connection: publicCredentialConnection(record) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`${status === "active" ? "Enabled" : "Disabled"} ${record.id}`);
    return payload;
  }
}

@Group({
  name: "credentials.policies",
  description: "Explain credential broker policies",
  scope: "admin",
})
export class CredentialPolicyCommands {
  @Command({ name: "explain", description: "Explain capabilities required for a provider credential action" })
  @CommandAccess({ kind: "read", resource: "credentials.policies", action: "explain", risk: "low" })
  @Returns(credentialPolicyReturnSchema)
  explain(
    @Option({ flags: "--provider <id>", description: "Provider id" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id" }) connection?: string,
    @Option({ flags: "--action <name>", description: "Provider action, e.g. messages.send" }) action?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    if (!action) fail("--action is required");
    const payload = explainCredentialPolicy({ provider, connection, action });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Policy for ${provider}:${connection} ${action}`);
    for (const cap of payload.requiredCapabilities) console.log(`- ${cap}`);
    console.log(
      `approval=${payload.approval.required ? "required" : "not-required"} reason=${payload.approval.reason}`,
    );
    return payload;
  }
}

@Group({
  name: "credentials.broker",
  description: "Execute provider actions through the credential broker",
  scope: "admin",
})
export class CredentialBrokerCommands {
  @Command({ name: "exec", description: "Resolve a provider credential inside broker boundary" })
  @CommandAccess({ kind: "mutate", resource: "credentials.broker", action: "exec", risk: "high" })
  @CliOnly()
  @Returns(credentialBrokerReturnSchema)
  async exec(
    @Option({ flags: "--provider <id>", description: "Provider id" }) provider?: string,
    @Option({ flags: "--connection <id>", description: "Connection id" }) connection?: string,
    @Option({ flags: "--action <name>", description: "Provider action" }) action?: string,
    @Option({ flags: "--dry-run", description: "Legacy planned payload (exit 0) without resolving the backend secret" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually resolve the credential in the broker; default is a dry-run plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (!provider) fail("--provider is required");
    if (!connection) fail("--connection is required");
    if (!action) fail("--action is required");
    // Validation runs BEFORE the brake: unknown connections exit 1 with the
    // not-found envelope on every path (plan, legacy --dry-run, --execute).
    const record = getCredentialConnection(provider, connection);
    if (!record) failCredentialConnectionNotFound("credentials broker exec", provider, connection, asJson);
    if (dryRun !== true && execute !== true) {
      // Write brake (Manual v2 7.8): exec is the broker boundary that resolves
      // a REAL backend credential for a provider action, so dry-run by default
      // and exit 3 before any secret resolution. The pre-existing `--dry-run`
      // flag stays as the legacy exit-0 planned payload (documented
      // equivalent, not renamed). The plan carries policy metadata only —
      // never a secret value or secret ref.
      contractDryRun(
        "credentials broker exec",
        {
          provider: record.provider,
          connection: record.connection,
          action,
          policy: explainCredentialPolicy({ provider: record.provider, connection: record.connection, action }),
        },
        { asJson },
      );
    }
    const payload = await execCredentialBroker({
      provider,
      connection,
      action,
      dryRun: Boolean(dryRun),
    });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`${payload.status}: ${provider}:${connection} ${action}`);
    console.log(`secretResolved=${payload.secretResolved ? "yes" : "no"}`);
    return payload;
  }
}
