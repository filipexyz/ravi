/**
 * Tools Commands - CLI Tools inspection and export
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { extractTools, generateManifest, manifestToJSON } from "../tools-export.js";
import {
  getAllCommandClasses,
  getCliToolsByGroup,
  createSdkTools,
  generateToolsJsonSchema,
} from "../tool-definitions.js";

@Group({
  name: "tools",
  description: "CLI tools inspection and export",
  scope: "open",
})
export class ToolsCommands {
  @Command({ name: "list", description: "List all available CLI tools" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const groups = getCliToolsByGroup();
    const sdkTools = createSdkTools(getAllCommandClasses());
    const payload = {
      total: sdkTools.length,
      groups: Object.keys(groups).map((group) => ({
        name: group,
        tools: sdkTools.filter((tool) => groups[group]?.includes(tool.name)),
      })),
      tools: sdkTools,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("\n📋 Available CLI Tools\n");
      console.log("These are the CLI tools available as SDK tools.\n");
      console.log("─".repeat(50));

      for (const group of Object.keys(groups)) {
        console.log(`\n${group.toUpperCase()}:`);
        const groupTools = createSdkTools(getAllCommandClasses(), {
          filter: new RegExp(`^${group}_`),
        });

        for (const tool of groupTools) {
          console.log(`  ${tool.name}`);
          console.log(`    ${tool.description}`);

          // Show parameters
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
      const total = Object.values(groups).flat().length;
      console.log(`\nTotal: ${total} tools`);
      console.log("\nUsage:");
      console.log("  ravi tools show <name>   # Show tool details");
      console.log("  ravi tools manifest      # Export as JSON manifest");
      console.log("  ravi tools schema        # Export as JSON Schema");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show details for a specific tool" })
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
  manifest(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    const tools = extractTools(getAllCommandClasses());
    const manifest = generateManifest(tools);
    console.log(manifestToJSON(tools));
    return { total: manifest.length, tools: manifest };
  }

  @Command({ name: "schema", description: "Export tools as JSON Schema" })
  schema(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    const schema = generateToolsJsonSchema(getAllCommandClasses());
    console.log(JSON.stringify(schema, null, 2));
    return { schema };
  }

  @Command({ name: "test", description: "Test a tool execution" })
  async test(
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
      console.log(`\n🔧 Testing: ${name}`);
      console.log(`Args: ${JSON.stringify(args)}\n`);
      console.log("─".repeat(50));
    }

    const result = await tool.handler(args);
    const payload = {
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
