/**
 * Tools Commands - CLI Tools inspection and export
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { fail } from "../context.js";
import { extractTools, manifestToJSON } from "../tools-export.js";
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
  list() {
    const groups = getCliToolsByGroup();

    console.log("\n📋 Available CLI Tools\n");
    console.log("These are the CLI tools available as SDK tools.\n");
    console.log("─".repeat(50));

    for (const group of Object.keys(groups)) {
      console.log(`\n${group.toUpperCase()}:`);
      const sdkTools = createSdkTools(getAllCommandClasses(), {
        filter: new RegExp(`^${group}_`),
      });

      for (const tool of sdkTools) {
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

  @Command({ name: "show", description: "Show details for a specific tool" })
  show(@Arg("name", { description: "Tool name (e.g., agents_list)" }) name: string) {
    const tools = extractTools(getAllCommandClasses());
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      fail(`Tool not found: ${name}. Run 'ravi tools list' to see available tools`);
    }

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
    const sdkTool = createSdkTools(getAllCommandClasses(), { filter: new RegExp(`^${name}$`) })[0];
    if (sdkTool) {
      console.log(JSON.stringify(sdkTool.inputSchema, null, 2));
    }
  }

  @Command({ name: "manifest", description: "Export tools as JSON manifest" })
  manifest() {
    const tools = extractTools(getAllCommandClasses());
    console.log(manifestToJSON(tools));
  }

  @Command({ name: "schema", description: "Export tools as JSON Schema" })
  schema() {
    const schema = generateToolsJsonSchema(getAllCommandClasses());
    console.log(JSON.stringify(schema, null, 2));
  }

  @Command({ name: "test", description: "Test a tool execution" })
  async test(
    @Arg("name", { description: "Tool name" }) name: string,
    @Arg("args", { required: false, description: "JSON args (optional)" }) argsJson?: string,
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

    console.log(`\n🔧 Testing: ${name}`);
    console.log(`Args: ${JSON.stringify(args)}\n`);
    console.log("─".repeat(50));

    const result = await tool.handler(args);

    console.log("\n─".repeat(50));
    console.log("\nResult:");
    console.log(`  isError: ${result.isError ?? false}`);
    console.log(`  content:`);
    for (const c of result.content) {
      console.log(`    ${c.text}`);
    }
  }
}
