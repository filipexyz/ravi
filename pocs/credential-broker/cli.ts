#!/usr/bin/env bun
import { Command } from "commander";
import { deleteSecret, readSecretFromStdin, writeSecret } from "./src/backends.ts";
import { execBroker, explainPolicy, publicConnection } from "./src/broker.ts";
import { ConnectionStore, normalizeIdentifier } from "./src/store.ts";
import type { CredentialBackend } from "./src/types.ts";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function collectCsv(value: string, previous: string[]): string[] {
  previous.push(
    ...value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return Array.from(new Set(previous)).sort();
}

function parseIntOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

function backendValue(value: string | undefined): CredentialBackend {
  if (value === "keychain" || value === "vault") return value;
  throw new Error("--backend must be keychain or vault");
}

function getStore(program: Command): ConnectionStore {
  const opts = program.optsWithGlobals() as { state?: string };
  return new ConnectionStore(opts.state);
}

const program = new Command();
program
  .name("credentials-poc")
  .description("PoC for ravi credentials Keychain/Vault broker")
  .option("--state <path>", "Metadata store path (defaults to pocs/credential-broker/.state/connections.json)");

const connections = program.command("connections").description("Manage provider connection metadata");

connections
  .command("list")
  .description("List provider connections without secret values")
  .option("--provider <id>", "Filter by provider")
  .option("--limit <n>", "Page size", "50")
  .option("--offset <n>", "Offset", "0")
  .option("--json", "Print JSON")
  .action((opts: { provider?: string; limit?: string; offset?: string; json?: boolean }) => {
    const store = getStore(program);
    const page = store.list({
      provider: opts.provider,
      limit: parseIntOption(opts.limit, 50),
      offset: parseIntOption(opts.offset, 0),
    });
    const payload = {
      total: page.total,
      pagination: {
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        hasMore: page.offset + page.items.length < page.total,
      },
      items: page.items.map(publicConnection),
    };
    if (opts.json) return printJson(payload);
    console.log(`Connections (${payload.items.length}/${payload.total})`);
    for (const item of payload.items) {
      console.log(`- ${item.provider}:${item.connection} ${item.status} backend=${item.backend}`);
    }
  });

connections
  .command("show")
  .description("Show one provider connection without secret values")
  .requiredOption("--provider <id>", "Provider id")
  .requiredOption("--connection <id>", "Connection id")
  .option("--json", "Print JSON")
  .action((opts: { provider: string; connection: string; json?: boolean }) => {
    const record = getStore(program).get(opts.provider, opts.connection);
    if (!record) throw new Error(`Connection not found: ${opts.provider}:${opts.connection}`);
    const payload = { connection: publicConnection(record) };
    if (opts.json) return printJson(payload);
    console.log(`${payload.connection.provider}:${payload.connection.connection}`);
    console.log(`  backend: ${payload.connection.backend}`);
    console.log(`  secretRef: ${payload.connection.secretRef}`);
  });

connections
  .command("add")
  .description("Add or update a provider connection")
  .requiredOption("--provider <id>", "Provider id, e.g. slack")
  .requiredOption("--connection <id>", "Connection id, e.g. rbbt")
  .requiredOption("--backend <backend>", "Secret backend: keychain or vault")
  .option("--label <text>", "Human label")
  .option("--scope <scope>", "Provider scope; repeatable or comma-separated", collectCsv, [])
  .option("--secret-stdin", "Read a secret value from stdin and write it to the backend")
  .option("--secret-ref <ref>", "Reference an existing backend secret without writing a value")
  .option("--vault-mount <mount>", "Vault KV v2 mount", "secret")
  .option("--vault-path <path>", "Vault logical path")
  .option("--vault-key <key>", "Vault data key", "token")
  .option("--json", "Print JSON")
  .action(
    async (opts: {
      provider: string;
      connection: string;
      backend: string;
      label?: string;
      scope: string[];
      secretStdin?: boolean;
      secretRef?: string;
      vaultMount?: string;
      vaultPath?: string;
      vaultKey?: string;
      json?: boolean;
    }) => {
      const provider = normalizeIdentifier(opts.provider, "provider");
      const connection = normalizeIdentifier(opts.connection, "connection");
      const backend = backendValue(opts.backend);
      if (opts.secretStdin && opts.secretRef) throw new Error("Use either --secret-stdin or --secret-ref, not both.");
      if (!opts.secretStdin && !opts.secretRef) throw new Error("Provide --secret-stdin or --secret-ref.");

      const secretRef = opts.secretRef
        ? opts.secretRef
        : await writeSecret({
            backend,
            provider,
            connection,
            secret: await readSecretFromStdin(),
            vaultMount: opts.vaultMount,
            vaultPath: opts.vaultPath,
            vaultKey: opts.vaultKey,
          });

      const record = getStore(program).upsert({
        provider,
        connection,
        backend,
        secretRef,
        label: opts.label?.trim() || null,
        scopes: opts.scope,
        status: "active",
      });
      const payload = { connection: publicConnection(record) };
      if (opts.json) return printJson(payload);
      console.log(`Stored connection ${record.id} (${record.backend})`);
    },
  );

connections
  .command("remove")
  .description("Remove provider connection metadata")
  .requiredOption("--provider <id>", "Provider id")
  .requiredOption("--connection <id>", "Connection id")
  .option("--delete-secret", "Also delete the backend secret")
  .option("--json", "Print JSON")
  .action(async (opts: { provider: string; connection: string; deleteSecret?: boolean; json?: boolean }) => {
    const store = getStore(program);
    const removed = store.remove(opts.provider, opts.connection);
    if (!removed) throw new Error(`Connection not found: ${opts.provider}:${opts.connection}`);
    const secretDeleted = opts.deleteSecret ? await deleteSecret(removed.secretRef) : false;
    const payload = { removed: publicConnection(removed), secretDeleted };
    if (opts.json) return printJson(payload);
    console.log(`Removed connection ${removed.id}${secretDeleted ? " and backend secret" : ""}`);
  });

program
  .command("policies")
  .description("Explain credential broker policy")
  .command("explain")
  .requiredOption("--provider <id>", "Provider id")
  .requiredOption("--connection <id>", "Connection id")
  .requiredOption("--action <name>", "Provider action")
  .option("--json", "Print JSON")
  .action((opts: { provider: string; connection: string; action: string; json?: boolean }) => {
    const payload = explainPolicy(opts);
    if (opts.json) return printJson(payload);
    console.log(`Policy for ${opts.provider}:${opts.connection} ${opts.action}`);
    for (const cap of payload.requiredCapabilities) console.log(`- ${cap}`);
    console.log(`approval=${payload.approval.required ? "required" : "not-required"} reason=${payload.approval.reason}`);
  });

program
  .command("broker")
  .description("Execute provider actions through the broker")
  .command("exec")
  .requiredOption("--provider <id>", "Provider id")
  .requiredOption("--connection <id>", "Connection id")
  .requiredOption("--action <name>", "Provider action")
  .option("--dry-run", "Plan without resolving the backend secret", false)
  .option("--json", "Print JSON")
  .action(async (opts: { provider: string; connection: string; action: string; dryRun: boolean; json?: boolean }) => {
    const payload = await execBroker({
      store: getStore(program),
      provider: opts.provider,
      connection: opts.connection,
      action: opts.action,
      dryRun: opts.dryRun,
    });
    if (opts.json) return printJson(payload);
    console.log(`${payload.status}: ${opts.provider}:${opts.connection} ${opts.action}`);
    console.log(`secretResolved=${payload.secretResolved ? "yes" : "no"}`);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
