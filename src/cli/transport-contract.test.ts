import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { z } from "zod";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { ContextRecord } from "../router/router-db.js";
import { dispatch } from "../sdk/gateway/dispatcher.js";
import {
  ContractError,
  contractDryRun,
  contractFailureOutcome,
  expectedErrorToContractError,
} from "./agent-contract.js";
import { runWithCliAudit, wasContractErrorAudited } from "./audit.js";
import { runWithContext } from "./context.js";
import { Command, CommandAccess, Group, Option, Returns } from "./decorators.js";
import { CliExpectedError } from "./expected-error.js";
import { registerCommands } from "./registry.js";
import { buildRegistry } from "./registry-snapshot.js";
import { extractTools } from "./tools-export.js";

@Group({ name: "cloud.fixture", description: "Cross-transport contract fixture", scope: "open" })
class CloudFailureCommands {
  @Command({ name: "fail", description: "Raise a provider failure" })
  @CommandAccess({ kind: "read", resource: "cloud.fixture", action: "fail", risk: "low" })
  @Returns(z.object({ ok: z.literal(true) }))
  fail(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    throw new CloudAuthError("RATE_LIMITED", "PRIVATE_PROVIDER_BODY_8K2R", { status: 429 });
  }

  @Command({ name: "expected", description: "Raise a compatibility failure" })
  @CommandAccess({ kind: "read", resource: "cloud.fixture", action: "expected", risk: "low" })
  @Returns(z.object({ ok: z.literal(true) }))
  expected(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    throw new CliExpectedError("PRIVATE_EXPECTED_MESSAGE_7M4Q");
  }

  @Command({ name: "confirm", description: "Return a sentinel-rich policy brake" })
  @CommandAccess({ kind: "mutate", resource: "cloud.fixture", action: "confirm", risk: "high" })
  confirm(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    contractDryRun(
      "cloud fixture confirm",
      {
        caption: "PRIVATE_MESSAGE_8K2R",
        filePath: "C:/sentinel/private/file-9P3X.txt",
        key: "custom.password",
        value: "SENTINEL_SECRET_7M4Q",
        count: 2,
      },
      { asJson },
    );
  }
}

const runtimeContext: ContextRecord = {
  contextId: "ctx_transport_cloud_test",
  contextKey: "rctx_transport_cloud_test",
  kind: "test-runtime",
  agentId: "transport-test",
  capabilities: [
    { permission: "read", objectType: "cloud.fixture", objectId: "fail", source: "test" },
    { permission: "read", objectType: "cloud.fixture", objectId: "expected", source: "test" },
    { permission: "mutate", objectType: "cloud.fixture", objectId: "confirm", source: "test" },
  ],
  createdAt: Date.now(),
};

const deniedContext: ContextRecord = {
  contextId: "ctx_transport_denied_test",
  contextKey: "rctx_transport_denied_test",
  kind: "test-runtime",
  agentId: "transport-denied-test",
  capabilities: [],
  createdAt: Date.now(),
};

describe("global cloud failure contract", () => {
  it("keeps custom CliExpectedError messages out of the internal contract error", () => {
    const contract = expectedErrorToContractError(
      "cloud fixture custom",
      new CliExpectedError("PRIVATE_CUSTOM_EXPECTED_4N7K", "CUSTOM_EXPECTED", 1),
    );

    expect(contract).toMatchObject({
      code: "CUSTOM_EXPECTED",
      message: "Command could not be completed.",
      exitCode: 1,
    });
    expect(JSON.stringify(contract)).not.toContain("PRIVATE_CUSTOM_EXPECTED_4N7K");
  });

  it("classifies an internal PERMISSION_DENIED contract as denied", () => {
    expect(contractFailureOutcome(new ContractError("apps run", "PERMISSION_DENIED", "denied", 1))).toBe("denied");
  });

  it("rejects invalid or semantically incoherent exit taxonomy at the contract source", () => {
    const attempts = [
      () => new ContractError("demo invalid", "CUSTOM_ERROR", "private", 9),
      () => new ContractError("demo invalid", "PERMISSION_DENIED", "private", 3),
      () => new ContractError("demo invalid", "WRITE_REQUIRES_EXECUTE", "private", 1),
      () => new ContractError("demo invalid", "USAGE_ERROR", "private", 1),
    ];

    for (const attempt of attempts) {
      let thrown = false;
      try {
        attempt();
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(true);
    }
  });

  it("sanitizes contract details before every transport can observe them", () => {
    const failure = new ContractError("media send", "WRITE_REQUIRES_EXECUTE", "confirmation required", 3, {
      dryRun: true,
      plan: {
        caption: "PRIVATE_MESSAGE_8K2R",
        filePath: "C:/sentinel/private/file-9P3X.txt",
        key: "custom.password",
        value: "SENTINEL_SECRET_7M4Q",
        count: 2,
        captionPresent: true,
      },
    });

    expect(failure.envelope().error.plan).toEqual({
      caption: "[REDACTED:content length=20]",
      filePath: "[REDACTED:path]",
      key: "custom.password",
      value: "[REDACTED]",
      count: 2,
      captionPresent: true,
    });
    expect(JSON.stringify(failure.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(JSON.stringify(failure.envelope())).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(JSON.stringify(failure.envelope())).not.toContain("C:/sentinel/private");
  });

  it("renders the sanitized ContractError plan in human dry-run mode", () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));

    let failure: unknown;
    try {
      contractDryRun("media send", {
        caption: "PRIVATE_MESSAGE_8K2R",
        filePath: "C:/sentinel/private/file-9P3X.txt",
        key: "custom.password",
        value: "SENTINEL_SECRET_7M4Q",
      });
    } catch (error) {
      failure = error;
    } finally {
      console.log = originalLog;
    }

    expect(failure).toBeInstanceOf(ContractError);
    const rendered = output.join("\n");
    expect(rendered).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(rendered).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(rendered).not.toContain("C:/sentinel/private");
    expect(rendered).toContain("[REDACTED:content length=20]");
    expect(rendered).toContain("[REDACTED:path]");
  });

  it("preserves one sanitized policy envelope across CLI, tool and gateway", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalExit = process.exit;
    const originalLog = console.log;
    const cliOutput: string[] = [];
    let cliExitCode: number | undefined;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    console.log = (...args: unknown[]) => cliOutput.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      cliExitCode = code;
      throw new Error("__dry_run_exit__");
    }) as typeof process.exit;

    try {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [CloudFailureCommands]);
      await expect(
        runWithContext({ agentId: runtimeContext.agentId, context: runtimeContext }, () =>
          program.parseAsync(["node", "test", "cloud", "fixture", "confirm", "--json"]),
        ),
      ).rejects.toThrow("__dry_run_exit__");
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(cliExitCode).toBe(3);
    expect(cliOutput).toHaveLength(1);
    const cliEnvelope = JSON.parse(cliOutput[0] ?? "{}");

    const tool = extractTools([CloudFailureCommands]).find((candidate) => candidate.name === "cloud_fixture_confirm");
    expect(tool).toBeDefined();
    const toolResult = await runWithContext({ agentId: runtimeContext.agentId, context: runtimeContext }, () =>
      tool!.handler({ json: true }),
    );
    expect(toolResult).toMatchObject({ isError: false, outcome: "blocked", exitCode: 3 });
    const toolEnvelope = JSON.parse(toolResult.content[0]?.text ?? "{}");

    const registry = buildRegistry([CloudFailureCommands]);
    const command = registry.commands.find((candidate) => candidate.fullName === "cloud.fixture.confirm");
    expect(command).toBeDefined();
    const gatewayResult = await dispatch(command!, {}, {}, { contextRecord: runtimeContext, emitAudit: () => {} });
    expect(gatewayResult.response.status).toBe(409);
    const gatewayBody = (await gatewayResult.response.json()) as Record<string, unknown>;
    const { exitCode, outcome, ...gatewayEnvelope } = gatewayBody;

    expect(exitCode).toBe(3);
    expect(outcome).toBe("blocked");
    expect(toolEnvelope).toEqual(cliEnvelope);
    expect(gatewayEnvelope).toEqual(cliEnvelope);
    const serialized = JSON.stringify(cliEnvelope);
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(serialized).not.toContain("C:/sentinel/private");
    expect(cliEnvelope).toMatchObject({
      success: false,
      op: "cloud fixture confirm",
      error: {
        code: "WRITE_REQUIRES_EXECUTE",
        plan: {
          caption: "[REDACTED:content length=20]",
          filePath: "[REDACTED:path]",
          key: "custom.password",
          value: "[REDACTED]",
          count: 2,
        },
      },
    });
  });

  it("preserves the same op, code, envelope and exit taxonomy in CLI, tool and gateway", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalExit = process.exit;
    const originalLog = console.log;
    const cliOutput: string[] = [];
    let cliExitCode: number | undefined;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    console.log = (...args: unknown[]) => cliOutput.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      cliExitCode = code;
      throw new Error("__transport_exit__");
    }) as typeof process.exit;

    try {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [CloudFailureCommands]);
      await expect(
        runWithContext({}, () => program.parseAsync(["node", "test", "cloud", "fixture", "fail", "--json"])),
      ).rejects.toThrow("__transport_exit__");
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(cliExitCode).toBe(1);
    expect(cliOutput).toHaveLength(1);
    const cliEnvelope = JSON.parse(cliOutput[0] ?? "{}");

    const tool = extractTools([CloudFailureCommands]).find((candidate) => candidate.name === "cloud_fixture_fail");
    expect(tool).toBeDefined();
    const toolResult = await runWithContext({ agentId: runtimeContext.agentId, context: runtimeContext }, () =>
      tool!.handler({}),
    );
    expect(toolResult).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const toolEnvelope = JSON.parse(toolResult.content[0]?.text ?? "{}");

    const registry = buildRegistry([CloudFailureCommands]);
    const command = registry.commands.find((candidate) => candidate.fullName === "cloud.fixture.fail");
    expect(command).toBeDefined();
    const gatewayResult = await dispatch(
      command!,
      {},
      {},
      {
        contextRecord: runtimeContext,
        emitAudit: () => {},
      },
    );
    expect(gatewayResult.response.status).toBe(422);
    const gatewayBody = (await gatewayResult.response.json()) as Record<string, unknown>;
    const { exitCode, outcome, ...gatewayEnvelope } = gatewayBody;

    expect(exitCode).toBe(1);
    expect(outcome).toBe("failed");
    expect(toolEnvelope).toEqual(cliEnvelope);
    expect(gatewayEnvelope).toEqual(cliEnvelope);
    expect(cliEnvelope).toMatchObject({
      success: false,
      op: "cloud fixture fail",
      error: {
        code: "RATE_LIMITED",
        message: "Console request was rate limited.",
        retryable: true,
        status: 429,
      },
    });
    expect(JSON.stringify(cliEnvelope)).not.toContain("PRIVATE_PROVIDER_BODY_8K2R");
  });

  it("keeps CliExpectedError messages private across CLI, tool and gateway", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const originalExit = process.exit;
    const originalLog = console.log;
    const cliOutput: string[] = [];
    let cliExitCode: number | undefined;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    console.log = (...args: unknown[]) => cliOutput.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      cliExitCode = code;
      throw new Error("__expected_exit__");
    }) as typeof process.exit;

    try {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [CloudFailureCommands]);
      await expect(
        runWithContext({}, () => program.parseAsync(["node", "test", "cloud", "fixture", "expected", "--json"])),
      ).rejects.toThrow("__expected_exit__");
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(cliExitCode).toBe(1);
    expect(cliOutput).toHaveLength(1);
    const cliEnvelope = JSON.parse(cliOutput[0] ?? "{}");

    const tool = extractTools([CloudFailureCommands]).find((candidate) => candidate.name === "cloud_fixture_expected");
    expect(tool).toBeDefined();
    const toolResult = await runWithContext({ agentId: runtimeContext.agentId, context: runtimeContext }, () =>
      tool!.handler({}),
    );
    expect(toolResult).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const toolEnvelope = JSON.parse(toolResult.content[0]?.text ?? "{}");

    const registry = buildRegistry([CloudFailureCommands]);
    const command = registry.commands.find((candidate) => candidate.fullName === "cloud.fixture.expected");
    expect(command).toBeDefined();
    const gatewayResult = await dispatch(command!, {}, {}, { contextRecord: runtimeContext, emitAudit: () => {} });
    expect(gatewayResult.response.status).toBe(422);
    const gatewayBody = (await gatewayResult.response.json()) as Record<string, unknown>;
    const { exitCode, outcome, ...gatewayEnvelope } = gatewayBody;

    expect(exitCode).toBe(1);
    expect(outcome).toBe("failed");
    expect(toolEnvelope).toEqual(cliEnvelope);
    expect(gatewayEnvelope).toEqual(cliEnvelope);
    expect(cliEnvelope).toMatchObject({
      success: false,
      op: "cloud fixture expected",
      error: {
        code: "COMMAND_FAILED",
        message: "Command could not be completed.",
        retryable: false,
      },
    });
    expect(JSON.stringify(cliEnvelope)).not.toContain("PRIVATE_EXPECTED_MESSAGE_7M4Q");
  });

  it("marks root contract failures after their semantic audit is emitted", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    const failure = new ContractError("login", "AUTH_REQUIRED", "login required", 1);
    try {
      await expect(
        runWithCliAudit({ group: "_root", name: "login", input: {} }, () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    } finally {
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(wasContractErrorAudited(failure)).toBe(true);
  });

  it("preserves one PERMISSION_DENIED envelope across CLI, tool and gateway", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const originalExit = process.exit;
    const originalLog = console.log;
    const originalError = console.error;
    const cliOutput: string[] = [];
    const cliError: string[] = [];
    let cliExitCode: number | undefined;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    process.env.RAVI_CONTEXT_KEY = deniedContext.contextKey;
    console.log = (...args: unknown[]) => cliOutput.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => cliError.push(args.map(String).join(" "));
    process.exit = ((code?: number) => {
      cliExitCode = code;
      throw new Error("__permission_exit__");
    }) as typeof process.exit;

    try {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [CloudFailureCommands]);
      await expect(
        runWithContext({ agentId: deniedContext.agentId, context: deniedContext }, () =>
          program.parseAsync(["node", "test", "cloud", "fixture", "fail", "--json"]),
        ),
      ).rejects.toThrow("__permission_exit__");
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
    }

    expect(cliExitCode).toBe(1);
    expect(cliError).toEqual([]);
    expect(cliOutput).toHaveLength(1);
    const cliEnvelope = JSON.parse(cliOutput[0] ?? "{}");

    const tool = extractTools([CloudFailureCommands]).find((candidate) => candidate.name === "cloud_fixture_fail");
    expect(tool).toBeDefined();
    const toolResult = await runWithContext({ agentId: deniedContext.agentId, context: deniedContext }, () =>
      tool!.handler({ json: true }),
    );
    const toolEnvelope = JSON.parse(toolResult.content[0]?.text ?? "{}");

    const registry = buildRegistry([CloudFailureCommands]);
    const command = registry.commands.find((candidate) => candidate.fullName === "cloud.fixture.fail");
    expect(command).toBeDefined();
    const gatewayResult = await dispatch(command!, {}, {}, { contextRecord: deniedContext, emitAudit: () => {} });
    expect(gatewayResult.response.status).toBe(403);
    const gatewayBody = (await gatewayResult.response.json()) as Record<string, unknown>;
    const { exitCode, outcome, ...gatewayEnvelope } = gatewayBody;

    expect(exitCode).toBe(1);
    expect(outcome).toBe("denied");
    expect(toolResult).toMatchObject({ isError: true, outcome: "denied", exitCode: 1 });
    expect(toolEnvelope).toEqual(cliEnvelope);
    expect(gatewayEnvelope).toEqual(cliEnvelope);
    expect(cliEnvelope).toMatchObject({
      success: false,
      op: "cloud fixture fail",
      error: { code: "PERMISSION_DENIED" },
    });
  });
});
