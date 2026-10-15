import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { runWithContext } from "./context.js";
import { Arg, Command, CommandAccess, CliOnly, Group, Option } from "./decorators.js";
import { setCliInvocationTarget } from "./home-mode.js";
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

@Group({ name: "clionly", description: "CLI-only commands", scope: "open" })
class CliOnlyCommands {
  @Command({ name: "run", description: "Run only from the local CLI" })
  @CommandAccess({ kind: "read", resource: "clionly", action: "run", risk: "low" })
  @CliOnly()
  run() {
    capturedCliOnlyRan = true;
  }
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
let capturedCliOnlyRan = false;

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

@Group({ name: "collide", description: "Arg and option share one name", scope: "open" })
class CollidingNameCommands {
  @Command({ name: "send", description: "Positional channel plus a config --channel" })
  @CommandAccess({ kind: "read", resource: "collide", action: "send", risk: "low", input: ["channel"] })
  send(
    @Arg("channel", { description: "Provider conversation id" }) _channel: string,
    @Option({ flags: "--channel <name>", description: "Config name" }) _configName?: string,
  ) {}

  @Command({ name: "list", description: "Optional positional project plus a same-meaning --project" })
  @CommandAccess({ kind: "read", resource: "collide", action: "list", risk: "low", input: ["project"] })
  list(
    @Arg("project", { required: false, description: "Project ref" }) _project?: string,
    @Option({ flags: "--project <ref>", description: "Project ref" }) _projectOption?: string,
  ) {}
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

  it("refuses to run a keyed command locally when no gateway is reachable", async () => {
    capturedNegated.length = 0;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [NegatedOptionCommands]);

    const previousNoAudit = process.env.RAVI_NO_AUDIT;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousHostGateway = process.env.RAVI_HOST_CLI_GATEWAY;
    const originalExit = process.exit;
    const originalError = console.error;
    const output: string[] = [];
    let exitCode: number | undefined;
    process.env.RAVI_NO_AUDIT = "1";
    // Even a context that would be allowed locally must not be evaluated here.
    process.env.RAVI_CONTEXT_KEY = semanticOnlyContext.contextKey;
    delete process.env.RAVI_GATEWAY_URL;
    process.env.RAVI_HOST_CLI_GATEWAY = "0";
    console.error = (...args: unknown[]) => output.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("__gateway_required_exit__");
    }) as typeof process.exit;
    try {
      await expect(
        runWithContext({ agentId: semanticOnlyContext.agentId, context: semanticOnlyContext }, () =>
          program.parseAsync(["node", "test", "negative", "run"]),
        ),
      ).rejects.toThrow("__gateway_required_exit__");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      if (previousNoAudit === undefined) delete process.env.RAVI_NO_AUDIT;
      else process.env.RAVI_NO_AUDIT = previousNoAudit;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousHostGateway === undefined) delete process.env.RAVI_HOST_CLI_GATEWAY;
      else process.env.RAVI_HOST_CLI_GATEWAY = previousHostGateway;
    }

    expect(exitCode).toBe(1);
    expect(capturedNegated).toEqual([]);
    expect(output.join("\n")).toContain("must go through the Ravi gateway");
  });

  it("refuses a CLI-only command instead of dispatching it to the gateway", async () => {
    capturedCliOnlyRan = false;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [CliOnlyCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const originalExit = process.exit;
    const requests: string[] = [];
    const output: string[] = [];
    let exitCode: number | undefined;
    // A reachable gateway is what used to turn this into a 404: the route table
    // excludes CLI-only commands by design, so the dispatch could never succeed.
    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_cli_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input));
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.error = (...args: unknown[]) => output.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("__cli_only_exit__");
    }) as typeof process.exit;

    try {
      await expect(runWithContext({}, () => program.parseAsync(["node", "test", "clionly", "run"]))).rejects.toThrow(
        "__cli_only_exit__",
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(requests).toEqual([]);
    expect(capturedCliOnlyRan).toBe(false);
    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("exclusive to the local CLI");
  });

  it("lets the remote gateway authorize a context key that is not registered locally", async () => {
    capturedNegated.length = 0;
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [NegatedOptionCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalExit = process.exit;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.log = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await runWithContext({}, () => program.parseAsync(["node", "test", "negative", "run"]));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(capturedNegated).toEqual([]);
    expect(requests).toEqual([
      {
        url: "https://gateway.example.test/api/v1/negative/run",
        authorization: "Bearer rctx_remote_only",
      },
    ]);
  });

  it("omits --json from the remote gateway body while keeping it for local rendering", async () => {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [ShadowDirectCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalExit = process.exit;
    const bodies: unknown[] = [];

    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.log = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await runWithContext({}, () => program.parseAsync(["node", "test", "shadow", "item", "demo", "--json"]));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(bodies).toEqual([{ id: "demo" }]);
    expect(JSON.stringify(bodies)).not.toContain('"json"');
  });

  it("keeps the positional value when an option shares the arg's name in the remote body", async () => {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [CollidingNameCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalExit = process.exit;
    const bodies: unknown[] = [];

    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.log = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await runWithContext({}, () =>
        program.parseAsync(["node", "test", "collide", "send", "C0PRIVATE1", "--channel", "workspace-a"]),
      );
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(bodies).toEqual([{ channel: "C0PRIVATE1" }]);
  });

  it("lets an option fill the shared key when the positional is left out in the remote body", async () => {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [CollidingNameCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalExit = process.exit;
    const bodies: unknown[] = [];

    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.log = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await runWithContext({}, () => program.parseAsync(["node", "test", "collide", "list", "--project", "project-a"]));
      await runWithContext({}, () => program.parseAsync(["node", "test", "collide", "list", "project-b"]));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(bodies).toEqual([{ project: "project-a" }, { project: "project-b" }]);
  });

  it("renders a projected contract instead of a raw non-success remote body", async () => {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [ShadowDirectCommands]);

    const previousGatewayUrl = process.env.RAVI_GATEWAY_URL;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalExit = process.exit;
    const rendered: string[] = [];
    const exitCodes: Array<number | undefined> = [];
    const exitSignal = new Error("remote exit signal");
    let failure: unknown;

    process.env.RAVI_GATEWAY_URL = "https://gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (_input, _init) =>
      Response.json(
        {
          success: false,
          op: "shadow item",
          exitCode: 3,
          outcome: "blocked",
          providerBody: "PRIVATE_MESSAGE_8K2R",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            plan: { token: "SENTINEL_SECRET_7M4Q" },
          },
        },
        { status: 409 },
      )) as typeof fetch;
    console.log = (...args: unknown[]) => rendered.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      exitCodes.push(code);
      throw exitSignal;
    }) as typeof process.exit;

    try {
      await runWithContext({}, () => program.parseAsync(["node", "test", "shadow", "item", "demo", "--json"]));
    } catch (error) {
      failure = error;
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      process.exit = originalExit;
      if (previousGatewayUrl === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = previousGatewayUrl;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    const output = rendered.join("\n");
    expect(failure).toBe(exitSignal);
    expect(exitCodes).toEqual([3]);
    expect(output).toContain("WRITE_REQUIRES_EXECUTE");
    expect(output).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(output).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(output).not.toContain("providerBody");
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

// `ravi home …`: a fake `tasks` group stands in for the real one, so these
// tests exercise the registry transport only.
const capturedHomeLocal: string[] = [];

@Group({ name: "tasks", description: "Fake tasks for home mode", scope: "open" })
class FakeHomeTaskCommands {
  @Command({ name: "report", description: "Fake report" })
  @CommandAccess({ kind: "mutate", resource: "tasks", action: "report", risk: "low", input: ["taskId"] })
  report(
    @Arg("taskId", { description: "Task ID" }) taskId: string,
    @Option({ flags: "--message <text>", description: "Message" }) _message?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean,
  ) {
    capturedHomeLocal.push(taskId);
  }

  @Command({ name: "comment", description: "Fake comment" })
  @CommandAccess({ kind: "mutate", resource: "tasks", action: "comment", risk: "low", input: ["taskId"] })
  comment(@Arg("taskId", { description: "Task ID" }) taskId: string, @Arg("body") _body: string) {
    capturedHomeLocal.push(taskId);
  }
}

const HOME_URL = "https://gw.example.test/i/0b6c2f0e-6a3b-4f0e-9d7a-2c1f3e4d5a6b";
const HOME_GRANT_SENTINEL = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzYW5kYm94In0.SENTINEL_GRANT_SIG_9Q3Z";
const HOME_REQUEST_ID = "4f1d2c3b-5a6e-4b7c-8d9e-0a1b2c3d4e5f";

interface HomeRunResult {
  requests: Array<{ url: string; headers: Record<string, string>; body: unknown; redirect?: string }>;
  exitCodes: Array<number | undefined>;
  output: string;
}

async function runHome(
  argv: string[],
  env: Record<string, string | undefined>,
  respond: () => Response = () => Response.json({ ok: true }),
): Promise<HomeRunResult> {
  const program = new CommanderCommand();
  program.exitOverride();
  registerCommands(program, [FakeHomeTaskCommands]);
  const keys = [
    "RAVI_HOME_GATEWAY_URL",
    "RAVI_HOME_COMMANDS",
    "RAVI_SANDBOX_GRANT",
    "RAVI_GATEWAY_URL",
    "RAVI_CONTEXT_KEY",
    "RAVI_AGENT_ID",
    "RAVI_SESSION_KEY",
    "RAVI_SESSION_NAME",
    "RAVI_HOST_CLI_GATEWAY",
    "RAVI_SUPPRESS_AUDIT_EVENTS",
    "RAVI_NO_AUDIT",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const result: HomeRunResult = { requests: [], exitCodes: [], output: "" };
  const lines: string[] = [];
  const exitSignal = new Error("home exit signal");
  for (const key of keys) delete process.env[key];
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  process.env.RAVI_NO_AUDIT = "1";
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  globalThis.fetch = (async (input, init) => {
    result.requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "null")),
      redirect: init?.redirect,
    });
    return respond();
  }) as typeof fetch;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    result.exitCodes.push(code);
    throw exitSignal;
  }) as typeof process.exit;
  setCliInvocationTarget("home");
  try {
    await runWithContext({}, () => program.parseAsync(["node", "test", ...argv]));
  } catch (error) {
    if (error !== exitSignal) throw error;
  } finally {
    setCliInvocationTarget("local");
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
    process.exit = originalExit;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  result.output = lines.join("\n");
  return result;
}

describe("ravi home transport", () => {
  it("sends only the grant: no bearer, no cwd, no internal marker, even with a context key and RAVI_GATEWAY_URL", async () => {
    capturedHomeLocal.length = 0;
    const run = await runHome(["tasks", "report", "task-1", "--message", "hi", "--json"], {
      RAVI_HOME_GATEWAY_URL: `${HOME_URL}/`,
      RAVI_CONTEXT_KEY: "rctx_SENTINEL_CONTEXT_KEY_4R2W",
      RAVI_GATEWAY_URL: "https://local-gateway.example.test",
      RAVI_AGENT_ID: "SENTINEL_AGENT_7P1M",
      RAVI_SESSION_KEY: "agent:SENTINEL_SESSION_3K8D:main",
      RAVI_SESSION_NAME: "SENTINEL_SESSION_NAME_5T6Y",
    });

    expect(run.exitCodes).toEqual([]);
    expect(capturedHomeLocal).toEqual([]);
    expect(run.requests).toHaveLength(1);
    const [request] = run.requests;
    expect(request?.url).toBe(`${HOME_URL}/api/v1/tasks/report`);
    expect(request?.redirect).toBe("manual");
    expect(request?.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(request?.body).toEqual({ taskId: "task-1", message: "hi" });
    const wire = JSON.stringify(request);
    for (const sentinel of ["SENTINEL_CONTEXT_KEY", "SENTINEL_AGENT", "SENTINEL_SESSION", "local-gateway"]) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it("adds X-Ravi-Sandbox-Grant only from the RAVI_SANDBOX_GRANT fallback", async () => {
    const withGrant = await runHome(["tasks", "report", "task-1"], {
      RAVI_HOME_GATEWAY_URL: HOME_URL,
      RAVI_SANDBOX_GRANT: HOME_GRANT_SENTINEL,
    });
    expect(withGrant.requests[0]?.headers["x-ravi-sandbox-grant"]).toBe(HOME_GRANT_SENTINEL);
    expect(withGrant.output).not.toContain("SENTINEL_GRANT_SIG");
  });

  it("refuses a command outside the HOME allowlist with exit 3 and sends nothing", async () => {
    capturedHomeLocal.length = 0;
    const run = await runHome(["tasks", "comment", "task-1", "hello"], { RAVI_HOME_GATEWAY_URL: HOME_URL });
    expect(run.exitCodes).toEqual([3]);
    expect(run.requests).toEqual([]);
    expect(capturedHomeLocal).toEqual([]);
    expect(run.output).toContain("not a HOME command");
  });

  it("refuses a command RAVI_HOME_COMMANDS leaves out with exit 3", async () => {
    const run = await runHome(["tasks", "report", "task-1"], {
      RAVI_HOME_GATEWAY_URL: HOME_URL,
      RAVI_HOME_COMMANDS: "tasks.show,tasks.done",
    });
    expect(run.exitCodes).toEqual([3]);
    expect(run.requests).toEqual([]);
  });

  it("fails without a HOME gateway instead of falling back to the local or remote gateway", async () => {
    capturedHomeLocal.length = 0;
    const run = await runHome(["tasks", "report", "task-1"], {
      RAVI_GATEWAY_URL: "https://local-gateway.example.test",
      RAVI_CONTEXT_KEY: "rctx_remote_only",
    });
    expect(run.exitCodes).toEqual([1]);
    expect(run.requests).toEqual([]);
    expect(capturedHomeLocal).toEqual([]);
    expect(run.output).toContain("RAVI_HOME_GATEWAY_URL");
  });

  it("projects a HOME error envelope with its request id and never prints the grant", async () => {
    const run = await runHome(
      ["tasks", "report", "task-1", "--json"],
      { RAVI_HOME_GATEWAY_URL: HOME_URL, RAVI_SANDBOX_GRANT: HOME_GRANT_SENTINEL },
      () =>
        Response.json(
          {
            error: {
              code: "grant_revoked",
              requestId: HOME_REQUEST_ID,
              source: "ravi-listener",
              detail: HOME_GRANT_SENTINEL,
            },
          },
          { status: 401 },
        ),
    );
    expect(run.exitCodes).toEqual([1]);
    expect(run.output).toContain("HOME_GRANT_REVOKED");
    expect(run.output).toContain(HOME_REQUEST_ID);
    expect(run.output).not.toContain("SENTINEL_GRANT_SIG");
    expect(run.output).not.toContain("detail");
  });

  it("scrubs the grant from a 2xx body, in text and --json output", async () => {
    for (const json of [false, true]) {
      const run = await runHome(
        ["tasks", "report", "task-1", ...(json ? ["--json"] : [])],
        { RAVI_HOME_GATEWAY_URL: HOME_URL, RAVI_SANDBOX_GRANT: HOME_GRANT_SENTINEL },
        () => Response.json({ ok: true, echo: `grant=${HOME_GRANT_SENTINEL}`, [HOME_GRANT_SENTINEL]: 1 }),
      );
      expect(run.exitCodes).toEqual([]);
      expect(run.output).not.toContain("SENTINEL_GRANT_SIG");
      expect(run.output).toContain("grant=[grant]");
    }
  });

  it("scrubs the grant from a relayed contract envelope in text mode", async () => {
    const run = await runHome(
      ["tasks", "report", "task-1"],
      { RAVI_HOME_GATEWAY_URL: HOME_URL, RAVI_SANDBOX_GRANT: HOME_GRANT_SENTINEL },
      () =>
        Response.json(
          {
            success: false,
            op: "tasks report",
            exitCode: 2,
            outcome: "usage_error",
            error: {
              code: "PAYLOAD_INVALID",
              message: `bad ${HOME_GRANT_SENTINEL}`,
              retryable: false,
              issues: [{ path: ["taskId"], code: "invalid", message: `bad ${HOME_GRANT_SENTINEL}` }],
              suggestions: [HOME_GRANT_SENTINEL],
            },
          },
          { status: 400 },
        ),
    );
    expect(run.exitCodes).toEqual([2]);
    expect(run.output).not.toContain("SENTINEL_GRANT_SIG");
    expect(run.output).toContain("[grant]");
  });

  it("strips terminal controls from a 2xx body in text mode and escapes them with --json", async () => {
    const hostile = "\u001b]0;pwned\u0007\u001b[2Jok\u009b31m\u202etxt\u202c\tend";
    const respond = () =>
      new Response(JSON.stringify({ ok: true, note: hostile }), { headers: { "content-type": "application/json" } });

    const text = await runHome(["tasks", "report", "task-1"], { RAVI_HOME_GATEWAY_URL: HOME_URL }, respond);
    expect(text.exitCodes).toEqual([]);
    expect(text.output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(text.output).not.toContain("pwned");
    expect(text.output).not.toContain("\\u001b");
    expect(JSON.parse(text.output)).toEqual({ ok: true, note: "oktxt\tend" });

    const json = await runHome(["tasks", "report", "task-1", "--json"], { RAVI_HOME_GATEWAY_URL: HOME_URL }, respond);
    expect(json.output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(json.output).toContain("\\u009b");
    expect(json.output).toContain("\\u202e");
    expect(JSON.parse(json.output)).toEqual({ ok: true, note: hostile });

    // The reviewer's fake Gate: raw controls inside a JSON-typed body, which
    // is then not JSON and prints as stripped text.
    const raw = await runHome(
      ["tasks", "report", "task-1"],
      { RAVI_HOME_GATEWAY_URL: HOME_URL },
      () =>
        new Response('{"ok":true,"note":"\u001b]0;pwned\u0007\u001b[2J"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(raw.output).toBe('{"ok":true,"note":""}\n');

    const plain = await runHome(
      ["tasks", "report", "task-1"],
      { RAVI_HOME_GATEWAY_URL: HOME_URL },
      () => new Response(`done${hostile}`, { headers: { "content-type": "text/plain" } }),
    );
    expect(plain.output).toBe("doneoktxt\tend\n");
  });

  it("strips terminal controls from a HOME error in text mode", async () => {
    const run = await runHome(["tasks", "report", "task-1"], { RAVI_HOME_GATEWAY_URL: HOME_URL }, () =>
      Response.json(
        {
          success: false,
          op: "tasks report",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "PAYLOAD_INVALID",
            message: "x",
            retryable: false,
            issues: [{ path: ["taskId"], code: "invalid", message: "bad\u001b]0;pwned\u0007\u001b[2J\u202eid" }],
          },
        },
        { status: 400 },
      ),
    );
    expect(run.exitCodes).toEqual([2]);
    expect(run.output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(run.output).not.toContain("pwned");
  });

  it("fails HOME_RESPONSE_TOO_LARGE with exit 1 on an endless body", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    const run = await runHome(
      ["tasks", "report", "task-1", "--json"],
      { RAVI_HOME_GATEWAY_URL: HOME_URL },
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(run.exitCodes).toEqual([1]);
    expect(run.output).toContain("HOME_RESPONSE_TOO_LARGE");
    expect(run.output).not.toContain("aaaa");
  });

  it("refuses home mode when RAVI_GATEWAY_URL shares the HOME origin, with exit 2", async () => {
    const run = await runHome(["tasks", "report", "task-1"], {
      RAVI_HOME_GATEWAY_URL: HOME_URL,
      RAVI_GATEWAY_URL: "https://gw.example.test",
      RAVI_CONTEXT_KEY: "rctx_remote_only",
    });
    expect(run.exitCodes).toEqual([2]);
    expect(run.requests).toEqual([]);
    expect(run.output).toContain("share an origin");
  });

  it("keeps the local transport when the invocation target is not home", async () => {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [FakeHomeTaskCommands]);
    const saved = {
      home: process.env.RAVI_HOME_GATEWAY_URL,
      grant: process.env.RAVI_SANDBOX_GRANT,
      gateway: process.env.RAVI_GATEWAY_URL,
      key: process.env.RAVI_CONTEXT_KEY,
      audit: process.env.RAVI_SUPPRESS_AUDIT_EVENTS,
    };
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const requests: Array<{ url: string; authorization: string | null; grant: string | null }> = [];
    process.env.RAVI_HOME_GATEWAY_URL = HOME_URL;
    process.env.RAVI_SANDBOX_GRANT = HOME_GRANT_SENTINEL;
    process.env.RAVI_GATEWAY_URL = "https://local-gateway.example.test";
    process.env.RAVI_CONTEXT_KEY = "rctx_remote_only";
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        grant: headers.get("x-ravi-sandbox-grant"),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    console.log = () => {};
    try {
      await runWithContext({}, () => program.parseAsync(["node", "test", "tasks", "report", "task-1"]));
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("RAVI_HOME_GATEWAY_URL", saved.home);
      restore("RAVI_SANDBOX_GRANT", saved.grant);
      restore("RAVI_GATEWAY_URL", saved.gateway);
      restore("RAVI_CONTEXT_KEY", saved.key);
      restore("RAVI_SUPPRESS_AUDIT_EVENTS", saved.audit);
    }
    expect(requests).toEqual([
      {
        url: "https://local-gateway.example.test/api/v1/tasks/report",
        authorization: "Bearer rctx_remote_only",
        grant: null,
      },
    ]);
  });
});
