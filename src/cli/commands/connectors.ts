import "reflect-metadata";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Arg, CliOnly, Command, Group, Option } from "../decorators.js";
import { cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
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

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

@Group({
  name: "connectors",
  description: "Connect and manage external services (Gmail, Calendar, ...) through Ravi Console",
  scope: "open",
})
export class ConnectorsCommands {
  @Command({
    name: "connect",
    description: "Connect a new external service via OAuth",
    aliases: ["add", "link"],
  })
  @CliOnly()
  async connect(
    @Arg("provider", { description: "Provider id (e.g. google)" }) provider: string,
    @Option({ flags: "--scope <scope>", description: "Extra OAuth scope; repeat for multiple" }) scope?: string,
    @Option({ flags: "--name <name>", description: "Display name for the connector" }) name?: string,
    @Option({ flags: "--no-open", description: "Do not open the browser automatically" }) noOpen?: boolean,
    @Option({ flags: "--json", description: "Print JSON status only" }) asJson?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      const scopes = scope
        ? scope
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const start = await startConnect({ provider, scopes, displayName: name });
      if (asJson) {
        console.log(JSON.stringify({ status: "started", ...start }, null, 2));
      } else {
        console.log(`Open the following URL to finish connecting ${provider}:`);
        console.log(`  ${start.connectUrl}`);
        console.log(`Pending grant id: ${start.pendingGrantId}`);
        console.log(`Expires at: ${start.expiresAt}`);
      }
      if (!noOpen) {
        try {
          await openExternal(start.connectUrl);
        } catch {
          // Browser open is best-effort; the URL is already printed above.
        }
      }

      const final = await pollUntilTerminal(start.pendingGrantId);
      if (asJson) {
        console.log(JSON.stringify({ status: final.status, connectorId: final.connectorId }, null, 2));
      } else {
        switch (final.status) {
          case "consumed":
            console.log(`Connected ${final.provider}. Connector id: ${final.connectorId ?? "(pending)"}`);
            break;
          case "expired":
            console.error("Authorization timed out before the user completed the flow.");
            process.exit(2);
            return undefined;
          case "rejected":
            console.error("Authorization rejected by Console.");
            process.exit(2);
            return undefined;
          default:
            console.error(`Polling ended in unexpected state: ${final.status}`);
            process.exit(2);
            return undefined;
        }
      }
      return final;
    });
  }

  @Command({ name: "list", description: "List your connectors" })
  @CliOnly()
  async list(
    @Option({ flags: "--provider <provider>", description: "Filter by provider id" }) provider?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limitOpt?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching connectors to skip (default: 0)" })
    offsetOpt?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      const all = await listConnectors({ provider });
      const limit = Math.min(Math.max(Number.parseInt(limitOpt ?? "", 10) || 50, 1), 500);
      const offset = Math.max(Number.parseInt(offsetOpt ?? "", 10) || 0, 0);
      const connections = all.slice(offset, offset + limit);
      if (asJson) {
        console.log(
          JSON.stringify(
            {
              connections,
              pagination: { total: all.length, limit, offset, returned: connections.length },
            },
            null,
            2,
          ),
        );
      } else if (all.length === 0) {
        console.log("No connectors configured. Run `ravi connectors connect <provider>` to add one.");
      } else {
        console.log(`Connectors (${connections.length}/${all.length}):`);
        for (const conn of connections) printConnectorSummary(conn);
      }
      return connections;
    });
  }

  @Command({ name: "show", description: "Show details of a single connector" })
  @CliOnly()
  async show(
    @Arg("id", { description: "Connector id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      const connection = await showConnector(id);
      if (asJson) {
        console.log(JSON.stringify({ connection }, null, 2));
      } else {
        printConnectorDetail(connection);
      }
      return connection;
    });
  }

  @Command({ name: "revoke", description: "Revoke a connector and delete its stored credentials" })
  @CliOnly()
  async revoke(
    @Arg("id", { description: "Connector id" }) id: string,
    @Option({ flags: "--yes", description: "Skip confirmation prompt" }) yes?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runConnectorCommand(asJson, async () => {
      if (!yes && !asJson) {
        console.log(`This will revoke connector ${id} at the provider and delete its stored tokens.`);
        console.log("Re-run with --yes to confirm.");
        process.exit(1);
        return undefined;
      }
      await revokeConnector(id);
      if (asJson) {
        console.log(JSON.stringify({ revoked: true, id }, null, 2));
      } else {
        console.log(`Revoked connector ${id}.`);
      }
      return { revoked: true } as const;
    });
  }
}

async function pollUntilTerminal(pendingId: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getConnectStatus(pendingId);
    if (status.status !== "pending") return status;
    await delay(POLL_INTERVAL_MS);
  }
  return { status: "expired" as const, provider: "", connectorId: null, expiresAt: new Date().toISOString() };
}

function printConnectorSummary(conn: ConnectorListItem): void {
  const flag = conn.requiresReauth ? " [reauth required]" : "";
  console.log(`- ${conn.id}  ${conn.provider}  ${conn.status}${flag}`);
  console.log(`    ${conn.displayName}`);
}

function printConnectorDetail(conn: ConnectorDetail): void {
  console.log(`Connector ${conn.id}`);
  console.log(`  Provider: ${conn.provider}`);
  console.log(`  Display: ${conn.displayName}`);
  console.log(`  Status: ${conn.status}${conn.requiresReauth ? " (reauth required)" : ""}`);
  console.log(`  External account: ${conn.externalAccountLogin ?? "(unknown)"}`);
  console.log(`  Granted at: ${conn.grantedAt}`);
  console.log(`  Last reauth: ${conn.lastReauthAt ?? "(never)"}`);
  if (conn.scopes.length) {
    console.log("  Scopes:");
    for (const scope of conn.scopes) console.log(`    - ${scope}`);
  }
  if (conn.capabilities.length) {
    console.log("  Capabilities:");
    for (const capability of conn.capabilities) console.log(`    - ${capability}`);
  }
}

async function runConnectorCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      console.log(JSON.stringify(formatCloudAuthError(cloudError), null, 2));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(cloudError.exitCode);
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
