/**
 * Agent-first contract tests for the `commands` CLI domain (Manual v2):
 * COMMAND_NOT_FOUND / AGENT_NOT_FOUND envelopes (exit 1) with suggestions
 * from the same local registry/config the lookup used, and compact `--fields`
 * mode on the listing. The domain is read-only — `run` only renders the
 * composed prompt — so there is no braked op to test. Follows the
 * tasks.test.ts pattern: no-op decorator mocks + service mocks with spies +
 * `hasContext: () => true` so the contract helpers throw ContractError
 * instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const discoverCalls: Array<Record<string, unknown>> = [];
const renderCalls: Array<Record<string, unknown>> = [];

function buildCommandFixture(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    description: `${id} description`,
    argumentHint: null,
    arguments: [],
    disabled: false,
    scope: "agent",
    path: `/tmp/agents/main/.ravi/commands/${id}.md`,
    relativePath: `${id}.md`,
    shadowedBy: null,
    shadows: [],
    issues: [],
    body: `body of ${id}`,
    frontmatter: {},
    ...overrides,
  };
}

let registryFixture: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../config-store.js", () => ({
  configStore: {
    getConfig: () => ({
      defaultAgent: "main",
      agents: {
        main: { id: "main", cwd: "/tmp/agents/main" },
        vendas: { id: "vendas", cwd: "/tmp/agents/vendas" },
      },
    }),
  },
}));

mock.module("../../commands/index.js", () => ({
  discoverRaviCommands: (input: Record<string, unknown>) => {
    discoverCalls.push(input);
    return registryFixture;
  },
  normalizeRaviCommandId: (name: string) => name.replace(/^#/, "").trim().toLowerCase(),
  resolveRaviCommand: (registry: { commands: Array<{ id: string }> }, id: string) =>
    registry.commands.find((command) => command.id === id) ?? null,
  renderRaviCommand: (command: { id: string }, invocation: { rawArguments: string }, args: string[]) => {
    renderCalls.push({ id: command.id, rawArguments: invocation.rawArguments, args });
    return {
      metadata: { commandId: command.id },
      positionalArguments: args,
      prompt: `rendered:${command.id}:${invocation.rawArguments}`,
    };
  },
}));

mock.module("../../tags/helpers.js", () => ({
  filterItemsByCanonicalTag: <T>(items: T[]) => items,
}));

const { RaviCommandsCommands } = await import("./commands.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  discoverCalls.length = 0;
  renderCalls.length = 0;
  registryFixture = {
    commands: [buildCommandFixture("review-pr"), buildCommandFixture("restart")],
    entries: [buildCommandFixture("review-pr"), buildCommandFixture("restart")],
    issues: [],
    agentCommandsDir: "/tmp/agents/main/.ravi/commands",
    globalCommandsDir: "/tmp/ravi-home/commands",
  };
});

// ---------------------------------------------------------------------------
// Not-found envelopes
// ---------------------------------------------------------------------------

describe("commands not-found envelopes", () => {
  it("show on an unknown command exits 1 with COMMAND_NOT_FOUND and suggestions from the registry", async () => {
    const commands = new RaviCommandsCommands();
    const error = await expectContractError(() => commands.show("#review", undefined, true), "COMMAND_NOT_FOUND", 1);

    expect(error.message).toContain("#review");
    expect(error.details.suggestions).toContain("review-pr");
    expect(error.details.suggestedAction).toContain("ravi commands list");
  });

  it("run on an unknown command exits 1 with COMMAND_NOT_FOUND and renders nothing", async () => {
    const commands = new RaviCommandsCommands();
    await expectContractError(() => commands.run("missing", [], undefined, true), "COMMAND_NOT_FOUND", 1);

    expect(renderCalls).toHaveLength(0);
  });

  it("an unknown --agent exits 1 with AGENT_NOT_FOUND and suggestions from the local config", async () => {
    const commands = new RaviCommandsCommands();
    const error = await expectContractError(() => commands.show("restart", "venda", true), "AGENT_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("vendas");
    expect(error.details.suggestedAction).toContain("ravi agents list");
    expect(discoverCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Read-only surface + compact mode
// ---------------------------------------------------------------------------

describe("commands read-only surface and compact mode", () => {
  it("run only RENDERS the composed prompt (read-only, no brake)", async () => {
    const commands = new RaviCommandsCommands();
    const payload = await silenced(() => commands.run("restart", ["ativar", "commands"], undefined, true));

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toMatchObject({ id: "restart", rawArguments: "ativar commands" });
    expect(payload).toMatchObject({ prompt: "rendered:restart:ativar commands" });
  });

  it("list --fields narrows each item to the requested fields", async () => {
    const commands = new RaviCommandsCommands();
    const payload = await silenced(() => commands.list(undefined, true, undefined, undefined, undefined, "id,scope"));

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "scope"]);
    }
    expect(payload.commands).toEqual(payload.items);
  });
});
