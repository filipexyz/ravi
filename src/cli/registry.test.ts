import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { runWithContext } from "./context.js";
import { Arg, Command, CommandAccess, Group, Option } from "./decorators.js";
import { registerCommands } from "./registry.js";
import type { ContextRecord } from "../router/router-db.js";

@Group({ name: "demo.child", description: "Nested child", scope: "open" })
class NestedChildCommands {
  @Command({ name: "show", description: "Show child" })
  @CommandAccess({ kind: "read", resource: "demo.child", action: "show", risk: "low", input: ["id"] })
  show(@Arg("id") _id: string) {}
}

@Group({ name: "demo", description: "Demo", scope: "open" })
class DemoCommands {
  @Command({ name: "child", description: "Show child directly" })
  @CommandAccess({ kind: "read", resource: "demo", action: "child", risk: "low", input: ["id"] })
  child(@Arg("id") _id: string) {}
}

@Group({ name: "plural", description: "Plural root", scope: "open", aliases: ["singular"] })
class GroupAliasCommands {
  @Command({ name: "show", description: "Show alias target" })
  @CommandAccess({ kind: "read", resource: "plural", action: "show", risk: "low" })
  show() {}
}

@Group({ name: "internal", description: "Internal commands", scope: "open", hidden: true })
class HiddenGroupCommands {
  @Command({ name: "debug", description: "Hidden debug command" })
  @CommandAccess({ kind: "read", resource: "internal", action: "debug", risk: "low" })
  debug() {}
}

interface CapturedCall {
  id: string;
  json: boolean | undefined;
}

const capturedDirect: CapturedCall[] = [];
const capturedNested: CapturedCall[] = [];
const capturedNegated: boolean[] = [];
const capturedPaired: Array<{ resumable: boolean | undefined; noResumable: boolean }> = [];

const semanticOnlyContext: ContextRecord = {
  contextId: "ctx_registry_semantic_only",
  contextKey: "rctx_registry_semantic_only",
  kind: "test-runtime",
  agentId: "registry-test",
  capabilities: [{ permission: "read", objectType: "negative", objectId: "run", source: "test" }],
  createdAt: Date.now(),
};

@Group({ name: "shadow", description: "Direct command + nested group with --json", scope: "open" })
class ShadowDirectCommands {
  @Command({ name: "item", description: "Show item directly" })
  @CommandAccess({ kind: "read", resource: "shadow", action: "item", risk: "low", input: ["id"] })
  item(@Arg("id") id: string, @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    capturedDirect.push({ id, json: asJson });
  }
}

@Group({ name: "shadow.item", description: "Nested item operations", scope: "open" })
class ShadowNestedCommands {
  @Command({ name: "show", description: "Show nested item" })
  @CommandAccess({ kind: "read", resource: "shadow.item", action: "show", risk: "low", input: ["id"] })
  show(@Arg("id") id: string, @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    capturedNested.push({ id, json: asJson });
  }
}

@Group({ name: "negative", description: "Negated options", scope: "open" })
class NegatedOptionCommands {
  @Command({ name: "run", description: "Capture a negated option" })
  @CommandAccess({ kind: "read", resource: "negative", action: "run", risk: "low" })
  run(@Option({ flags: "--no-cascade", description: "Preserve descendants" }) noCascade = false) {
    capturedNegated.push(noCascade);
  }
}

@Group({ name: "paired", description: "Positive and negated options", scope: "open" })
class PairedOptionCommands {
  @Command({ name: "run", description: "Capture paired options" })
  @CommandAccess({ kind: "read", resource: "paired", action: "run", risk: "low" })
  run(
    @Option({ flags: "--resumable", description: "Enable resume" }) resumable?: boolean,
    @Option({ flags: "--no-resumable", description: "Disable resume" }) noResumable = false,
  ) {
    capturedPaired.push({ resumable, noResumable });
  }
}

async function parseAsLocalOperator(program: CommanderCommand, argv: string[]): Promise<void> {
  const contextKey = process.env.RAVI_CONTEXT_KEY;
  delete process.env.RAVI_CONTEXT_KEY;
  try {
    await runWithContext({}, () => program.parseAsync(argv));
  } finally {
    if (contextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
    else process.env.RAVI_CONTEXT_KEY = contextKey;
  }
}

describe("registerCommands", () => {
  it("binds negated Commander options as no-prefixed flag presence", async () => {
    capturedNegated.length = 0;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [NegatedOptionCommands]);

    await parseAsLocalOperator(program, ["node", "test", "negative", "run"]);
    await parseAsLocalOperator(program, ["node", "test", "negative", "run", "--no-cascade"]);

    expect(capturedNegated).toEqual([false, true]);
  });

  it("keeps paired positive and negated flags distinguishable", async () => {
    capturedPaired.length = 0;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [PairedOptionCommands]);

    await parseAsLocalOperator(program, ["node", "test", "paired", "run"]);
    await parseAsLocalOperator(program, ["node", "test", "paired", "run", "--resumable"]);
    await parseAsLocalOperator(program, ["node", "test", "paired", "run", "--no-resumable"]);

    expect(capturedPaired).toEqual([
      { resumable: undefined, noResumable: false },
      { resumable: true, noResumable: false },
      { resumable: undefined, noResumable: true },
    ]);
  });

  it("executes a CLI command with its semantic capability and no legacy group grant", async () => {
    capturedNegated.length = 0;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [NegatedOptionCommands]);

    const previousNoAudit = process.env.RAVI_NO_AUDIT;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    process.env.RAVI_NO_AUDIT = "1";
    process.env.RAVI_CONTEXT_KEY = semanticOnlyContext.contextKey;
    try {
      await runWithContext({ agentId: semanticOnlyContext.agentId, context: semanticOnlyContext }, () =>
        program.parseAsync(["node", "test", "negative", "run"]),
      );
    } finally {
      if (previousNoAudit === undefined) delete process.env.RAVI_NO_AUDIT;
      else process.env.RAVI_NO_AUDIT = previousNoAudit;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
    }

    expect(capturedNegated).toEqual([false]);
  });

  it("reuses existing nested command nodes for direct commands with subcommands", () => {
    const program = new CommanderCommand();

    expect(() => registerCommands(program, [NestedChildCommands, DemoCommands])).not.toThrow();

    const demo = program.commands.find((command) => command.name() === "demo");
    const child = demo?.commands.find((command) => command.name() === "child");

    expect(child).toBeDefined();
    expect(child?.commands.some((command) => command.name() === "show")).toBe(true);
  });

  it("registers aliases on command groups", () => {
    const program = new CommanderCommand();

    registerCommands(program, [GroupAliasCommands]);

    const plural = program.commands.find((command) => command.name() === "plural");
    expect(plural?.aliases()).toContain("singular");
  });

  it("skips hidden command groups", () => {
    const program = new CommanderCommand();

    registerCommands(program, [HiddenGroupCommands]);

    expect(program.commands.some((command) => command.name() === "internal")).toBe(false);
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
      await parseAsLocalOperator(program, ["node", "test", "shadow", "item", "show", "id-123", "--json"]);

      expect(capturedNested).toEqual([{ id: "id-123", json: true }]);
    });

    it("still delivers --json to the parent direct command when used without a subcommand", async () => {
      capturedDirect.length = 0;
      const program = buildProgram();
      await parseAsLocalOperator(program, ["node", "test", "shadow", "item", "id-456", "--json"]);

      expect(capturedDirect).toEqual([{ id: "id-456", json: true }]);
    });

    it("omits --json from nested subcommand options when the user did not pass it", async () => {
      capturedNested.length = 0;
      const program = buildProgram();
      await parseAsLocalOperator(program, ["node", "test", "shadow", "item", "show", "id-789"]);

      expect(capturedNested).toEqual([{ id: "id-789", json: undefined }]);
    });
  });
});
