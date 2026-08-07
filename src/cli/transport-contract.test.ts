import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { z } from "zod";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { ContextRecord } from "../router/router-db.js";
import { dispatch } from "../sdk/gateway/dispatcher.js";
import { ContractError } from "./agent-contract.js";
import { runWithCliAudit, wasContractErrorAudited } from "./audit.js";
import { runWithContext } from "./context.js";
import { Command, CommandAccess, Group, Option, Returns } from "./decorators.js";
import { registerCommands } from "./registry.js";
import { buildRegistry } from "./registry-snapshot.js";
import { extractTools } from "./tools-export.js";

@Group({ name: "cloud.fixture", description: "Cross-transport contract fixture", scope: "open" })
class CloudFailureCommands {
  @Command({ name: "fail", description: "Raise a provider failure" })
  @CommandAccess({ kind: "read", resource: "cloud.fixture", action: "fail", risk: "low" })
  @Returns(z.object({ ok: z.literal(true) }))
  fail(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean) {
    throw new CloudAuthError("RATE_LIMITED", "provider rate limit reached", { status: 429 });
  }
}

const runtimeContext: ContextRecord = {
  contextId: "ctx_transport_cloud_test",
  contextKey: "rctx_transport_cloud_test",
  kind: "test-runtime",
  agentId: "transport-test",
  capabilities: [{ permission: "read", objectType: "cloud.fixture", objectId: "fail", source: "test" }],
  createdAt: Date.now(),
};

describe("global cloud failure contract", () => {
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
      error: { code: "RATE_LIMITED", retryable: true, status: 429 },
    });
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
});
