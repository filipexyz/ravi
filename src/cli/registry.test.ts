import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { Arg, Command, Group } from "./decorators.js";
import { registerCommands } from "./registry.js";

@Group({ name: "demo.child", description: "Nested child", scope: "open" })
class NestedChildCommands {
  @Command({ name: "show", description: "Show child" })
  show(@Arg("id") _id: string) {}
}

@Group({ name: "demo", description: "Demo", scope: "open" })
class DemoCommands {
  @Command({ name: "child", description: "Show child directly" })
  child(@Arg("id") _id: string) {}
}

describe("registerCommands", () => {
  it("reuses existing nested command nodes for direct commands with subcommands", () => {
    const program = new CommanderCommand();

    expect(() => registerCommands(program, [NestedChildCommands, DemoCommands])).not.toThrow();

    const demo = program.commands.find((command) => command.name() === "demo");
    const child = demo?.commands.find((command) => command.name() === "child");

    expect(child).toBeDefined();
    expect(child?.commands.some((command) => command.name() === "show")).toBe(true);
  });
});
