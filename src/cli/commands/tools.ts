/**
 * Tools Commands - CLI Tools inspection, search, safe test, and explicit execution
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  declareCommandReturns,
  toolShowReturnSchema,
  toolTestReturnSchema,
  toolsListReturnSchema,
  toolsManifestReturnSchema,
  toolsSchemaReturnSchema,
  toolsSearchReturnSchema,
  toolInvokeReturnSchema,
} from "./operational-return-schemas.js";
import { extractTools, generateManifest, manifestToJSON } from "../tools-export.js";
import {
  getAllCommandClasses,
  getCliToolsByGroup,
  createSdkTools,
  generateToolsJsonSchema,
} from "../tool-definitions.js";

// ============================================================================
// Search helpers (local, deterministic, no LLM/network)
// ============================================================================

interface SearchHit {
  rank: number;
  score: number;
  name: string;
  description: string;
  group: string;
  command: string;
  matchedFields: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 0);
}

function searchTools(query: string, limit: number): { items: SearchHit[]; total: number } {
  const terms = tokenize(query);
  if (terms.length === 0) return { items: [], total: 0 };

  const tools = extractTools(getAllCommandClasses());
  const sdkTools = createSdkTools(getAllCommandClasses());

  const scored: SearchHit[] = [];

  for (const tool of tools) {
    let score = 0;
    const matchedFields: string[] = [];

    const sdkTool = sdkTools.find((s) => s.name === tool.name);
    const paramNames = sdkTool
      ? Object.keys(sdkTool.inputSchema.properties)
      : [...tool.metadata.args.map((a) => a.name), ...tool.metadata.options.map((o) => o.flags)];
    const paramDescs = sdkTool
      ? Object.values(sdkTool.inputSchema.properties)
          .map((p) => p.description ?? "")
          .filter(Boolean)
      : [];

    const accessStr = tool.metadata.access
      ? `${tool.metadata.access.kind} ${tool.metadata.access.resource} ${tool.metadata.access.action} ${tool.metadata.access.risk}`
      : "";
    const skillGateStr = tool.metadata.skillGate
      ? `${tool.metadata.skillGate.skill} ${tool.metadata.skillGate.source}`
      : "";

    const fields: Array<{ name: string; text: string; weight: number }> = [
      { name: "name", text: tool.name, weight: 3 },
      { name: "fullCommand", text: `${tool.metadata.group} ${tool.metadata.command}`, weight: 3 },
      { name: "group", text: tool.metadata.group, weight: 2 },
      { name: "command", text: tool.metadata.command, weight: 2 },
      { name: "description", text: tool.description, weight: 2 },
      { name: "parameters", text: paramNames.join(" "), weight: 1 },
      { name: "parameterDescriptions", text: paramDescs.join(" "), weight: 1 },
      { name: "access", text: accessStr, weight: 1 },
      { name: "skillGate", text: skillGateStr, weight: 1 },
    ];

    for (const term of terms) {
      for (const field of fields) {
        if (field.text.toLowerCase().includes(term)) {
          score += field.weight;
          if (!matchedFields.includes(field.name)) {
            matchedFields.push(field.name);
          }
        }
      }
    }

    if (score > 0) {
      scored.push({
        rank: 0,
        score,
        name: tool.name,
        description: tool.description,
        group: tool.metadata.group,
        command: tool.metadata.command,
        matchedFields,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const total = scored.length;
  const items = scored.slice(0, limit).map((hit, i) => ({ ...hit, rank: i + 1 }));

  return { items, total };
}

// ============================================================================
// Commands
// ============================================================================

@Group({
  name: "tools",
  description: "CLI tools inspection and export",
  scope: "open",
})
export class ToolsCommands {
  @Command({ name: "list", description: "List all available CLI tools" })
  @CommandAccess({ kind: "read", resource: "tools", action: "list", risk: "low" })
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching tools to skip (default: 0)" }) offset?: string,
  ) {
    const groups = getCliToolsByGroup();
    const sdkTools = createSdkTools(getAllCommandClasses());
    const page = paginateCliItems(sdkTools, { limit, offset });
    const pageTools = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "tools", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageTools.length,
      total: page.total,
    });
    const payload = {
      total: page.total,
      pagination,
      groups: Object.keys(groups).map((group) => ({
        name: group,
        tools: pageTools.filter((tool) => groups[group]?.includes(tool.name)),
      })),
      items: pageTools,
      tools: pageTools,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("\n📋 Available CLI Tools\n");
      console.log("These are the CLI tools available as SDK tools.\n");
      console.log("─".repeat(50));

      for (const group of Object.keys(groups)) {
        console.log(`\n${group.toUpperCase()}:`);
        const groupTools = pageTools.filter((tool) => groups[group]?.includes(tool.name));
        if (groupTools.length === 0) continue;

        for (const tool of groupTools) {
          console.log(`  ${tool.name}`);
          console.log(`    ${tool.description}`);

          const params = Object.entries(tool.inputSchema.properties);
          if (params.length > 0) {
            const paramStr = params
              .map(([name]) => {
                const required = tool.inputSchema.required.includes(name);
                return required ? `<${name}>` : `[${name}]`;
              })
              .join(" ");
            console.log(`    Usage: ${tool.name} ${paramStr}`);
          }
          console.log();
        }
      }

      console.log("─".repeat(50));
      console.log(
        `\nTotal: ${page.total} tools (${pageTools.length} returned, limit ${page.limit}, offset ${page.offset})`,
      );
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
      console.log("\nUsage:");
      console.log("  ravi tools show <name>     # Show tool details");
      console.log("  ravi tools search <query>  # Search by intent");
      console.log("  ravi tools manifest        # Export as JSON manifest");
      console.log("  ravi tools schema          # Export as JSON Schema");
    }
    return payload;
  }

  @Command({ name: "search", description: "Search tools by intent, name, description, or metadata" })
  @CommandAccess({ kind: "read", resource: "tools", action: "search", risk: "low" })
  search(
    @Arg("query", { description: "Search query (matches name, description, parameters, access metadata, skill gate)" })
    query: string,
    @Option({ flags: "--limit <n>", description: "Max results (default: 10)" }) limitStr?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const limit = Math.max(1, Math.min(100, parseInt(limitStr ?? "10", 10) || 10));
    const { items, total } = searchTools(query, limit);

    const payload = {
      query,
      limit,
      total,
      returned: items.length,
      items,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n🔍 Search: "${query}" (${items.length} of ${total} matches, limit ${limit})\n`);

      if (items.length === 0) {
        console.log("  No tools matched your query.");
        console.log("\nTry:");
        console.log("  ravi tools list --json  # Browse all tools");
      } else {
        console.log("─".repeat(60));
        for (const hit of items) {
          console.log(`  #${hit.rank}  ${hit.name}  (score: ${hit.score})`);
          console.log(`       ${hit.description}`);
          console.log(`       matched: ${hit.matchedFields.join(", ")}`);
          console.log();
        }
        console.log("─".repeat(60));
        console.log("\nNext steps:");
        console.log(`  ravi tools show <name>                  # Inspect tool details`);
        console.log(`  ravi tools test <name> '<args>' --json  # Dry-run plan`);
        console.log(`  ravi tools invoke <name> '<args>' --json  # Execute`);
      }

      if (total > items.length) {
        console.log(`\n  ${total - items.length} more matches. Use --limit ${Math.min(total, limit * 2)} to see more.`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show details for a specific tool" })
  @CommandAccess({ kind: "read", resource: "tools", action: "show", risk: "low" })
  show(
    @Arg("name", { description: "Tool name (e.g., agents_list)" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const tools = extractTools(getAllCommandClasses());
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      fail(`Tool not found: ${name}. Run 'ravi tools list' to see available tools`);
    }

    const sdkTool = createSdkTools(getAllCommandClasses(), { filter: new RegExp(`^${name}$`) })[0];
    const payload = {
      tool: {
        name: tool.name,
        description: tool.description,
        metadata: tool.metadata,
        inputSchema: sdkTool?.inputSchema,
        manifest: generateManifest([tool])[0],
      },
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n📋 Tool: ${tool.name}\n`);
      console.log(`Description: ${tool.description}`);
      console.log(`Group: ${tool.metadata.group}`);
      console.log(`Command: ${tool.metadata.command}`);
      console.log(`Method: ${tool.metadata.method}`);
      if (tool.metadata.skillGate) {
        console.log(`Skill Gate: ${tool.metadata.skillGate.skill} (${tool.metadata.skillGate.source})`);
      }

      console.log("\nParameters:");
      if (tool.metadata.args.length === 0 && tool.metadata.options.length === 0) {
        console.log("  (none)");
      }

      for (const arg of tool.metadata.args) {
        const required = arg.required ?? true;
        const reqStr = required ? "(required)" : "(optional)";
        console.log(`  ${arg.name} ${reqStr}`);
        if (arg.description) {
          console.log(`    ${arg.description}`);
        }
        if (arg.defaultValue !== undefined) {
          console.log(`    Default: ${arg.defaultValue}`);
        }
      }

      for (const opt of tool.metadata.options) {
        console.log(`  ${opt.flags} (optional)`);
        if (opt.description) {
          console.log(`    ${opt.description}`);
        }
        if (opt.defaultValue !== undefined) {
          console.log(`    Default: ${opt.defaultValue}`);
        }
      }

      console.log("\nJSON Schema:");
      if (sdkTool) {
        console.log(JSON.stringify(sdkTool.inputSchema, null, 2));
      }
    }
    return payload;
  }

  @Command({ name: "manifest", description: "Export tools as JSON manifest" })
  @CommandAccess({ kind: "read", resource: "tools", action: "manifest", risk: "low" })
  manifest(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    const tools = extractTools(getAllCommandClasses());
    const manifest = generateManifest(tools);
    console.log(manifestToJSON(tools));
    return { total: manifest.length, tools: manifest };
  }

  @Command({ name: "schema", description: "Export tools as JSON Schema" })
  @CommandAccess({ kind: "read", resource: "tools", action: "schema", risk: "low" })
  schema(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    const schema = generateToolsJsonSchema(getAllCommandClasses());
    console.log(JSON.stringify(schema, null, 2));
    return { schema };
  }

  @Command({ name: "test", description: "Dry-run plan for a tool (does not execute the handler)" })
  @CommandAccess({ kind: "read", resource: "tools", action: "test", risk: "low" })
  test(
    @Arg("name", { description: "Tool name" }) name: string,
    @Arg("args", { required: false, description: "JSON args (optional)" }) argsJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const tools = extractTools(getAllCommandClasses());
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      fail(`Tool not found: ${name}`);
    }

    let args: Record<string, unknown> = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson);
      } catch {
        fail("Invalid JSON args");
      }
    }

    const sdkTool = createSdkTools(getAllCommandClasses(), { filter: new RegExp(`^${name}$`) })[0];
    const invokeCommand = `ravi tools invoke ${name} '${JSON.stringify(args)}' --json`;

    const payload = {
      mode: "dry_run" as const,
      executed: false,
      tool: {
        name: tool.name,
        description: tool.description,
        metadata: tool.metadata,
      },
      args,
      schema: sdkTool?.inputSchema ?? null,
      access: tool.metadata.access ?? null,
      invokeCommand,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n🔧 Dry-run plan: ${name}`);
      console.log(`Mode: dry_run (handler NOT executed)\n`);
      console.log("─".repeat(50));
      console.log(`\nTool: ${tool.name}`);
      console.log(`Description: ${tool.description}`);
      console.log(`Group: ${tool.metadata.group}`);
      console.log(`Command: ${tool.metadata.command}`);

      if (tool.metadata.access) {
        const a = tool.metadata.access;
        console.log(`\nAccess: ${a.kind}/${a.risk} on ${a.resource}.${a.action}`);
      }
      if (tool.metadata.skillGate) {
        console.log(`Skill Gate: ${tool.metadata.skillGate.skill} (${tool.metadata.skillGate.source})`);
      }

      console.log(`\nParsed args: ${JSON.stringify(args, null, 2)}`);

      if (sdkTool) {
        console.log(`\nSchema: ${JSON.stringify(sdkTool.inputSchema, null, 2)}`);
      }

      console.log("\n─".repeat(50));
      console.log("\nTo execute for real:");
      console.log(`  ${invokeCommand}`);
    }

    return payload;
  }

  @Command({ name: "invoke", description: "Execute a tool handler (real execution with full authorization)" })
  @CommandAccess({ kind: "mutate", resource: "tools", action: "invoke", risk: "high" })
  async invoke(
    @Arg("name", { description: "Tool name" }) name: string,
    @Arg("args", { required: false, description: "JSON args (optional)" }) argsJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const tools = extractTools(getAllCommandClasses());
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      fail(`Tool not found: ${name}`);
    }

    let args: Record<string, unknown> = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson);
      } catch {
        fail("Invalid JSON args");
      }
    }

    if (!asJson) {
      console.log(`\n⚡ Invoking: ${name}`);
      console.log(`Args: ${JSON.stringify(args)}\n`);
      console.log("─".repeat(50));
    }

    const result = await tool.handler(args);
    const payload = {
      mode: "executed" as const,
      executed: true,
      tool: {
        name: tool.name,
        description: tool.description,
        metadata: tool.metadata,
      },
      args,
      result: {
        isError: result.isError ?? false,
        content: result.content,
      },
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("\n─".repeat(50));
      console.log("\nResult:");
      console.log(`  isError: ${result.isError ?? false}`);
      console.log(`  content:`);
      for (const c of result.content) {
        console.log(`    ${c.text}`);
      }
    }
    return payload;
  }
}

declareCommandReturns(ToolsCommands, {
  list: toolsListReturnSchema,
  search: toolsSearchReturnSchema,
  manifest: toolsManifestReturnSchema,
  schema: toolsSchemaReturnSchema,
  show: toolShowReturnSchema,
  test: toolTestReturnSchema,
  invoke: toolInvokeReturnSchema,
});
