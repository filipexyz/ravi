import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { Arg, Command, Group, Option } from "./decorators.js";
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

interface CapturedCall {
  id: string;
  json: boolean | undefined;
}

const capturedDirect: CapturedCall[] = [];
const capturedNested: CapturedCall[] = [];

@Group({ name: "shadow", description: "Direct command + nested group with --json", scope: "open" })
class ShadowDirectCommands {
  @Command({ name: "item", description: "Show item directly" })
  item(@Arg("id") id: string, @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    capturedDirect.push({ id, json: asJson });
  }
}

@Group({ name: "shadow.item", description: "Nested item operations", scope: "open" })
class ShadowNestedCommands {
  @Command({ name: "show", description: "Show nested item" })
  show(@Arg("id") id: string, @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    capturedNested.push({ id, json: asJson });
  }
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

  describe("dotted groups colliding with same-named direct command", () => {
    let envBackup: string | undefined;

    beforeAll(() => {
      envBackup = process.env.RAVI_NO_AUDIT;
      // Disable audit emission so action handler doesn't try to reach NATS.
      process.env.RAVI_NO_AUDIT = "1";
    });

    afterAll(() => {
      if (envBackup === undefined) delete process.env.RAVI_NO_AUDIT;
      else process.env.RAVI_NO_AUDIT = envBackup;
    });

    function buildProgram() {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [ShadowDirectCommands, ShadowNestedCommands]);
      return program;
    }

    it("propagates --json to a nested subcommand when the parent declares the same flag", async () => {
      capturedNested.length = 0;
      const program = buildProgram();
      await program.parseAsync(["node", "test", "shadow", "item", "show", "id-123", "--json"]);

      expect(capturedNested).toEqual([{ id: "id-123", json: true }]);
    });

    it("still delivers --json to the parent direct command when used without a subcommand", async () => {
      capturedDirect.length = 0;
      const program = buildProgram();
      await program.parseAsync(["node", "test", "shadow", "item", "id-456", "--json"]);

      expect(capturedDirect).toEqual([{ id: "id-456", json: true }]);
    });

    it("omits --json from nested subcommand options when the user did not pass it", async () => {
      capturedNested.length = 0;
      const program = buildProgram();
      await program.parseAsync(["node", "test", "shadow", "item", "show", "id-789"]);

      expect(capturedNested).toEqual([{ id: "id-789", json: undefined }]);
    });
  });
});
