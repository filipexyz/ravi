import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  createMcpBridge,
  listMcpBridges,
  normalizeBridgeCapabilityClasses,
  revokeMcpBridge,
  type McpBridgeCreateResult,
  type McpBridgeListResult,
  type McpBridgePayload,
  type McpBridgeRevokeResult,
  type McpBridgesClientDeps,
} from "../../bridges/client.js";
import { hasContext } from "../context.js";
import { jsonObjectSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

export interface BridgesCommandDeps extends McpBridgesClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "bridges",
  description: "Manage Ravi MCP bridges through Console",
  scope: "open",
})
export class BridgesCommands {
  constructor(private readonly deps: BridgesCommandDeps = defaultBridgesDeps()) {}

  @Command({ name: "list", description: "List Ravi MCP bridges for a Console project" })
  @CommandAccess({ kind: "read", resource: "bridges", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--project <ref>", description: "Console project id or slug; defaults to RAVI_PROJECT" })
    projectRef?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum bridges to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of bridges to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runBridgesCommand(asJson, async () => {
      const result = await listMcpBridges({ projectRef, console: consoleUrl }, this.deps);
      const page = paginateCliItems(result.bridges, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "bridges", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--project", result.projectRef, consoleUrl ? "--console" : null, consoleUrl],
      });
      const payload = {
        ...result,
        total: page.total,
        pagination,
        bridges: page.items,
        items: page.items,
      };
      printPayload(payload, asJson, () => printBridgeList(payload));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a Ravi MCP bridge URL for a Console project" })
  @CommandAccess({ kind: "mutate", resource: "bridges", action: "create", risk: "medium" })
  async create(
    @Option({ flags: "--project <ref>", description: "Console project id or slug; defaults to RAVI_PROJECT" })
    projectRef?: string,
    @Option({ flags: "--name <name>", description: "Bridge display name" }) name?: string,
    @Option({ flags: "--description <text>", description: "Bridge description" }) description?: string,
    @Option({
      flags: "--allow <classes>",
      description: "Comma-separated capability classes: read,write,destructive; defaults to Console policy",
    })
    allow?: string,
    @Option({
      flags: "--session <id>",
      description: "Existing session to expose; not supported by the current Console CLI API yet",
    })
    sessionId?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runBridgesCommand(asJson, async () => {
      if (sessionId?.trim()) {
        throw new CloudAuthError("PAYLOAD_INVALID", "--session is not supported by the current Console CLI API yet.");
      }
      const result = await createMcpBridge(
        {
          projectRef,
          name,
          description,
          allowedCapabilityClasses: normalizeBridgeCapabilityClasses(allow),
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printCreatedBridge(result));
      return result;
    });
  }

  @Command({ name: "revoke", description: "Revoke a Ravi MCP bridge and its client tokens" })
  @CommandAccess({ kind: "mutate", resource: "bridges", action: "revoke", risk: "destructive" })
  async revoke(
    @Arg("id", { description: "Bridge id" }) id: string,
    @Option({ flags: "--yes", description: "Skip confirmation prompt" }) yes?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runBridgesCommand(asJson, async () => {
      if (!yes) {
        if (!asJson && !hasContext()) {
          console.log(`This will revoke MCP bridge ${id} and all OAuth tokens minted for it.`);
          console.log("Re-run with --yes to confirm.");
        }
        throw new CloudAuthError("PAYLOAD_INVALID", "Confirmation required: pass --yes to revoke this bridge.");
      }
      const result = await revokeMcpBridge(id, { console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printRevokedBridge(result));
      return result;
    });
  }
}

function defaultBridgesDeps(): BridgesCommandDeps {
  return {};
}

const mcpBridgeSchema = jsonObjectSchema;

declareCommandReturns(BridgesCommands, {
  list: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    projectRef: z.string(),
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    bridges: z.array(mcpBridgeSchema),
    items: z.array(mcpBridgeSchema),
  }),
  create: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    projectRef: z.string(),
    bridge: mcpBridgeSchema,
    bridgeToken: z.string().nullable(),
    bridgeUrl: z.string().nullable(),
  }),
  revoke: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    revoked: z.boolean(),
    bridgeId: z.string(),
  }),
});

async function runBridgesCommand<T>(asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    if (hasContext()) throw cloudError;
    process.exit(cloudError.exitCode);
  }
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printBridgeList(
  result: McpBridgeListResult & { pagination?: { limit: number; nextCommand: string | null; offset: number } },
): void {
  if (result.bridges.length === 0) {
    console.log(`No Ravi MCP bridges found for project ${result.projectRef}.`);
    return;
  }

  const pagination = result.pagination;
  console.log(
    `Ravi MCP bridges for ${result.projectRef} (${result.bridges.length} returned of ${result.total}${
      pagination ? `, limit ${pagination.limit}, offset ${pagination.offset}` : ""
    })`,
  );
  for (const bridge of result.bridges) {
    console.log(`  - ${bridgeLabel(bridge)}`);
  }
  if (pagination?.nextCommand) {
    console.log("\nNext page:");
    console.log(`  ${pagination.nextCommand}`);
  }
}

function printCreatedBridge(result: McpBridgeCreateResult): void {
  console.log("Created Ravi MCP bridge");
  printBridgeFields(result.bridge);
  if (result.bridgeUrl) {
    console.log(`  MCP URL    ${result.bridgeUrl}`);
    console.log("");
    console.log("MCP client config:");
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            ravi: {
              url: result.bridgeUrl,
            },
          },
        },
        null,
        2,
      ),
    );
  }
}

function printRevokedBridge(result: McpBridgeRevokeResult): void {
  console.log(`Revoked Ravi MCP bridge ${result.bridgeId}.`);
}

function bridgeLabel(bridge: McpBridgePayload): string {
  const id = stringValue(bridge.id) ?? "bridge";
  const name = stringValue(bridge.name);
  const status = stringValue(bridge.status);
  const classes = stringArrayValue(bridge.allowedCapabilityClasses);
  const calls24h = numberValue(bridge.calls24h);
  return [
    id,
    name && name !== id ? name : null,
    status ? `status=${status}` : null,
    classes.length ? `allow=${classes.join(",")}` : null,
    calls24h !== null ? `calls24h=${calls24h}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

function printBridgeFields(bridge: McpBridgePayload): void {
  const classes = stringArrayValue(bridge.allowedCapabilityClasses);
  const fields = [
    ["Bridge", stringValue(bridge.id)],
    ["Project", stringValue(bridge.projectId)],
    ["Name", stringValue(bridge.name)],
    ["Status", stringValue(bridge.status)],
    ["Allowed", classes.length ? classes.join(", ") : null],
  ] as const;

  for (const [label, value] of fields) {
    if (value) console.log(`  ${label.padEnd(10)} ${value}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
}
