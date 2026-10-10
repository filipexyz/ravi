import "reflect-metadata";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { ContractError, contractDryRun, contractFail, pickFields } from "../agent-contract.js";
import { cloudAuthErrorFromUnknown } from "../../cloud-auth/errors.js";
import {
  execCapability,
  getConnectStatus,
  listConnectors,
  revokeConnector,
  showConnector,
  startConnect,
  type ConnectorDetail,
  type ConnectorListItem,
} from "../../link/connectors.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const POLL_INTERVAL_MS = 2_000;
/** Fallback when the start answer has no usable expiry; the Console grants 10 minutes. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_GRACE_MS = 15_000;
const PROJECT_FLAG_REMOVAL_DATE = "2027-01-01";
const IGNORED_PROJECT_WARNING = `--project is ignored: connections belong to you, not to a project (removed after ${PROJECT_FLAG_REMOVAL_DATE})`;

@Group({
  name: "connectors",
  description: "Connect and manage your own accounts (Gmail, Calendar, ...) through Ravi Console",
  scope: "open",
})
export class ConnectorsCommands {
  // Manual v2: `connect` is intentionally UNBRAKED — it is a human-in-the-loop
  // browser OAuth flow (the same Console user opens the connect page, continues
  // to the provider and approves; the CLI polls until then). A dry-run plan
  // would add exit-3 friction without preventing any write: nothing is granted
  // until that person consents.
  @Command({
    name: "connect",
    description: "Connect one of your accounts (Gmail, Calendar, ...) through Ravi Console",
    aliases: ["add", "link"],
  })
  @CommandAccess({ kind: "mutate", resource: "connectors", action: "connect", risk: "high" })
  @CliOnly()
  async connect(
    @Arg("provider", { description: "Provider id (e.g. google)" }) provider: string,
    @Option({
      flags: "--project <id-or-slug>",
      description: `Ignored: connections belong to you, not to a project (removed after ${PROJECT_FLAG_REMOVAL_DATE})`,
    })
    project?: string,
    @Option({ flags: "--scope <scope>", description: "Ignored: the Console picks the scopes (see --read-only)" })
    scope?: string,
    @Option({ flags: "--name <name>", description: "Display name for the connection" }) name?: string,
    @Option({ flags: "--no-open", description: "Do not open the browser automatically" }) noOpen?: boolean,
    @Option({ flags: "--json", description: "Print JSON status only" }) asJson?: boolean,
    @Option({ flags: "--read-only", description: "Ask only for read access (no sending email)" }) readOnly?: boolean,
    @Option({
      flags: "--reconnect <id>",
      description: "Reconnect an existing connection (same account) instead of adding one",
    })
    reconnect?: string,
  ) {
    return runConnectorCommand(asJson, async () => {
      warnIgnoredProject(project);
      if (scope?.trim()) {
        console.error("--scope is ignored: the Console picks the scopes; use --read-only to leave out writing.");
      }
      const start = await startConnect({
        provider,
        accessMode: readOnly ? "read_only" : undefined,
        reconnectConnectionId: reconnect?.trim() || undefined,
        displayName: name,
      });
      const started = {
        status: "started" as const,
        connectUrl: start.connectUrl,
        pendingGrantId: start.pendingGrantId,
        expiresAt: start.expiresAt,
        openAs: start.userEmail,
      };
      if (asJson && noOpen) {
        console.log(JSON.stringify(started, null, 2));
        return started;
      }
      if (!asJson) {
        console.log(`Open this link to connect ${provider}:`);
        console.log(`  ${start.connectUrl}`);
        console.log(
          start.userEmail
            ? `It works only for the person who started it: open it signed in to Ravi Console as ${start.userEmail}.`
            : "It works only for the person who started it: open it signed in to Ravi Console as yourself.",
        );
        console.log(`Expires at: ${start.expiresAt}`);
      }
      if (!noOpen) {
        try {
          await openExternal(start.connectUrl);
        } catch {
          // Browser open is best-effort; the URL is already printed above.
        }
      }

      const final = await pollUntilTerminal(start.pendingGrantId, start.expiresAt);
      switch (final.status) {
        case "consumed":
          if (asJson) {
            console.log(
              JSON.stringify(
                { status: final.status, provider: final.provider, connectorId: final.connectorId },
                null,
                2,
              ),
            );
          } else {
            console.log(`Connected ${final.provider}. Connection id: ${final.connectorId ?? "(pending)"}`);
          }
          return final;
        case "expired":
          contractFail("connectors connect", "CONNECTOR_AUTH_EXPIRED", "Authorization expired before completion.", {
            asJson,
            details: {
              retryable: true,
              suggestedAction: `Start a new authorization flow with: ravi connectors connect ${provider}`,
            },
          });
        case "rejected":
          contractFail("connectors connect", "CONNECTOR_AUTH_REJECTED", "Authorization was rejected by Console.", {
            asJson,
            details: {
              retryable: false,
              suggestedAction:
                "Open the link signed in as the same Console user who started it, or check that your organization allows the connector",
            },
          });
        default:
          contractFail(
            "connectors connect",
            "CONNECTOR_AUTH_STATE_INVALID",
            "Authorization ended in an invalid state.",
            {
              asJson,
              details: {
                retryable: false,
                suggestedAction: "Inspect connector status in Console before retrying",
              },
            },
          );
      }
    });
  }

  @Command({ name: "list", description: "List your connections" })
  @CommandAccess({ kind: "read", resource: "connectors", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider id" }) provider?: string,
    @Option({
      flags: "--project <id>",
      description: `Ignored: connections belong to you, not to a project (removed after ${PROJECT_FLAG_REMOVAL_DATE})`,
    })
    project?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limitOpt?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching connectors to skip (default: 0)" })
    offsetOpt?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    return runConnectorCommand(asJson, async () => {
      warnIgnoredProject(project);
      const all = await listConnectors({ provider });
      const limit = Math.min(Math.max(Number.parseInt(limitOpt ?? "", 10) || 50, 1), 500);
      const offset = Math.max(Number.parseInt(offsetOpt ?? "", 10) || 0, 0);
      const connections = pickFields(all.slice(offset, offset + limit), fields);
      const payload = {
        connections,
        pagination: { total: all.length, limit, offset, returned: connections.length },
      };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (all.length === 0) {
        console.log("No connections yet. Run `ravi connectors connect <provider>` to add one.");
      } else {
        console.log(`Your connections (${connections.length}/${all.length}):`);
        for (const conn of connections) printConnectorSummary(conn);
      }
      return payload;
    });
  }

  @Command({ name: "show", description: "Show details of one of your connections" })
  @CommandAccess({ kind: "read", resource: "connectors", action: "show", risk: "low" })
  async show(
    @Arg("id", { description: "Connector id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      const connection = await showConnector(id);
      const payload = { connection };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printConnectorDetail(connection);
      }
      return payload;
    });
  }

  @Command({ name: "revoke", description: "Disconnect one of your connections and delete its stored credentials" })
  @CommandAccess({
    kind: "mutate",
    resource: "connectors",
    action: "revoke",
    risk: "destructive",
    requiresConfirmation: true,
  })
  async revoke(
    @Arg("id", { description: "Connector id" }) id: string,
    @Option({ flags: "--yes", description: "Skip confirmation (pre-existing equivalent of --execute)" }) yes?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually revoke the connector; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      if (yes !== true && execute !== true) {
        // Write brake (Manual v2 7.8): revoking is destructive — it deletes the
        // stored provider tokens at Console/Link — so dry-run by default and
        // exit 3 before any remote call. The pre-existing `--yes` flag stays as
        // the documented equivalent of `--execute` (not renamed).
        contractDryRun("connectors revoke", { id, deletesStoredCredentials: true }, { asJson });
      }
      await revokeConnector(id);
      const payload = { revoked: true as const, id };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Disconnected ${id}.`);
      }
      return payload;
    });
  }
}

const connectorListItemSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  provider: z.string(),
  displayName: z.string(),
  status: z.string(),
  requiresReauth: z.boolean(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  externalAccountLogin: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  accessMode: z.enum(["full", "read_only"]).optional(),
  scopeKind: z.enum(["user", "organization"]).optional(),
});

const connectorDetailSchema = connectorListItemSchema.extend({
  capabilities: z.array(z.string()),
  externalAccountLogin: z.string().nullable(),
  grantedAt: z.string(),
  lastReauthAt: z.string().nullable(),
  lastUsedAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
});

declareCommandReturns(ConnectorsCommands, {
  list: z.object({
    connections: z.array(connectorListItemSchema),
    pagination: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      returned: z.number(),
    }),
  }),
  show: z.object({ connection: connectorDetailSchema }),
  revoke: z.object({ revoked: z.literal(true), id: z.string() }),
});

async function pollUntilTerminal(pendingId: string, expiresAt: string) {
  const expiry = Date.parse(expiresAt);
  const deadline = Number.isFinite(expiry)
    ? Math.min(expiry + POLL_GRACE_MS, Date.now() + POLL_TIMEOUT_MS + POLL_GRACE_MS)
    : Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getConnectStatus(pendingId);
    if (status.status !== "pending") return status;
    await delay(POLL_INTERVAL_MS);
  }
  return { status: "expired" as const, provider: "", connectorId: null, expiresAt: new Date().toISOString() };
}

function warnIgnoredProject(project: string | undefined): void {
  if (project !== undefined) console.error(IGNORED_PROJECT_WARNING);
}

function printConnectorSummary(conn: ConnectorListItem): void {
  const flags = [
    conn.isDefault ? "default" : null,
    conn.accessMode === "read_only" ? "read only" : null,
    conn.requiresReauth ? "reconnect needed" : null,
  ].filter(Boolean);
  console.log(`- ${conn.id}  ${conn.provider}  ${conn.status}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
  console.log(`    ${conn.externalAccountLogin ?? "(account email unknown)"} · ${conn.displayName}`);
}

function printConnectorDetail(conn: ConnectorDetail): void {
  console.log(`Connection ${conn.id}`);
  console.log(`  Account: ${conn.externalAccountLogin ?? "(unknown)"}`);
  console.log(`  Provider: ${conn.provider}`);
  console.log(`  Display: ${conn.displayName}`);
  console.log(`  Status: ${conn.status}${conn.requiresReauth ? " (reconnect needed)" : ""}`);
  if (conn.accessMode) console.log(`  Access: ${conn.accessMode === "read_only" ? "read only" : "full"}`);
  if (conn.isDefault !== undefined) console.log(`  Default: ${conn.isDefault ? "yes" : "no"}`);
  console.log(`  Granted at: ${conn.grantedAt}`);
  console.log(`  Last reauth: ${conn.lastReauthAt ?? "(never)"}`);
  if (conn.lastUsedAt !== undefined) console.log(`  Last used: ${conn.lastUsedAt ?? "(never)"}`);
  if (conn.scopes.length) {
    console.log("  Scopes:");
    for (const scope of conn.scopes) console.log(`    - ${scope}`);
  }
  if (conn.capabilities.length) {
    console.log("  Capabilities:");
    for (const capability of conn.capabilities) console.log(`    - ${capability}`);
  }
}

async function runConnectorCommand<T>(_asJson: boolean | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    // Manual v2 contract: contractFail/contractDryRun already emitted their
    // envelope and carry the exit taxonomy (1/2/3). Never let the legacy
    // CloudAuthError funnel swallow them.
    if (error instanceof ContractError) throw error;
    throw cloudAuthErrorFromUnknown(error);
  }
}

function openExternal(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// Re-export so the proxy executor helper has a single import path for
// downstream domain CLIs (gmail, calendar, drive) that wrap connector
// exec.
export { execCapability };
