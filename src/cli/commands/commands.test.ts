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

class MockRaviCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RaviCommandError";
  }
}

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

mock.module("../../router/router-db.js", () => ({
  dbReadAgentDirectorySnapshot: () => ({
    defaultAgent: "main",
    agents: [
      { id: "main", cwd: "/tmp/agents/main" },
      { id: "vendas", cwd: "/tmp/agents/vendas" },
    ],
  }),
}));

mock.module("../../commands/index.js", () => ({
  RaviCommandError: MockRaviCommandError,
  discoverRaviCommands: (input: Record<string, unknown>) => {
    discoverCalls.push(input);
    return registryFixture;
  },
  normalizeRaviCommandId: (name: string) => {
    const normalized = name.trim().replace(/^#/, "");
    if (!normalized) {
      throw new MockRaviCommandError("Command name is required.", "invalid_command_name");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(normalized)) {
      throw new MockRaviCommandError(`Invalid command name "${name}".`, "invalid_command_name");
    }
    return normalized.toLowerCase();
  },
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
const { ContractError, expectedErrorToContractError } = await import("../agent-contract.js");
const { commandRunReturnSchema, commandShowReturnSchema, commandValidateReturnSchema, commandsListReturnSchema } =
  await import("./operational-return-schemas.js");

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

async function expectUsageError(run: () => Promise<unknown> | unknown): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  const contractError = expectedErrorToContractError("commands list", caught);
  expect(contractError).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  return contractError!;
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

describe("commands typed usage failures", () => {
  for (const [operation, invoke] of [
    ["show", (commands: InstanceType<typeof RaviCommandsCommands>, name: string) => commands.show(name, "ghost", true)],
    [
      "run",
      (commands: InstanceType<typeof RaviCommandsCommands>, name: string) => commands.run(name, [], "ghost", true),
    ],
  ] as const) {
    for (const name of ["", "#", "bad_name", "a".repeat(65)]) {
      it(`${operation} rejects ${JSON.stringify(name)} as INVALID_COMMAND_NAME before agent lookup`, async () => {
        const commands = new RaviCommandsCommands();
        const error = await expectContractError(() => invoke(commands, name), "INVALID_COMMAND_NAME", 2);

        expect(error.details.suggestedAction).toContain("[A-Za-z0-9]");
        expect(discoverCalls).toHaveLength(0);
      });
    }
  }

  for (const [limit, offset] of [
    ["many", undefined],
    ["0", undefined],
    ["501", undefined],
    [undefined, "-1"],
    [undefined, "1.5"],
  ] as const) {
    it(`list classifies invalid pagination limit=${limit ?? "default"} offset=${offset ?? "default"} as usage`, async () => {
      const commands = new RaviCommandsCommands();
      const error = await expectUsageError(() => commands.list(undefined, true, undefined, limit, offset));

      expect(error.envelope().error.message).not.toBe("Command could not be completed.");
    });
  }

  it("list rejects an unknown field in a mixed projection with the stable accepted set", async () => {
    const commands = new RaviCommandsCommands();
    const error = await expectUsageError(() =>
      commands.list(undefined, true, undefined, undefined, undefined, "id,unknown"),
    );

    expect(error.details.acceptedFields).toContain("id");
    expect(error.details.acceptedFields).not.toContain("unknown");
  });

  it("list rejects an unknown field even when the registry is empty", async () => {
    registryFixture = { ...registryFixture, commands: [], entries: [] };
    const commands = new RaviCommandsCommands();
    const error = await expectUsageError(() =>
      commands.list(undefined, true, undefined, undefined, undefined, "unknown"),
    );

    expect(error.details.acceptedFields).toEqual([
      "id",
      "token",
      "title",
      "description",
      "argumentHint",
      "arguments",
      "disabled",
      "scope",
      "path",
      "relativePath",
      "shadowedBy",
      "shadows",
      "issues",
    ]);
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

  it("list --fields survives JSON round-trip under the published Returns schema", async () => {
    const commands = new RaviCommandsCommands();
    const payload = await silenced(() => commands.list(undefined, true, undefined, undefined, undefined, "id,scope"));
    const serializedPayload = JSON.parse(JSON.stringify(payload));

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "scope"]);
      expect(Object.getOwnPropertyNames(item).sort()).toEqual(["id", "scope"]);
    }
    expect(payload.items).toBe(payload.commands);
    expect(payload.commands).toEqual(payload.items);
    expect(serializedPayload.items).toEqual(payload.items);
    expect(serializedPayload.commands).toEqual(serializedPayload.items);
    expect(commandsListReturnSchema.safeParse(serializedPayload).success).toBe(true);
  });

  it("list Returns rejects empty projected rows and accepts every declared singleton field", async () => {
    const commands = new RaviCommandsCommands();
    const emptyProjection = await silenced(() => commands.list(undefined, true, undefined, undefined, undefined, "id"));
    const serialized = JSON.parse(JSON.stringify(emptyProjection));
    serialized.items[0] = {};
    serialized.commands[0] = {};

    expect(commandsListReturnSchema.safeParse(serialized).success).toBe(false);

    for (const field of [
      "id",
      "token",
      "title",
      "description",
      "argumentHint",
      "arguments",
      "disabled",
      "scope",
      "path",
      "relativePath",
      "shadowedBy",
      "shadows",
      "issues",
    ]) {
      const payload = await silenced(() => commands.list(undefined, true, undefined, undefined, undefined, field));
      expect(commandsListReturnSchema.safeParse(JSON.parse(JSON.stringify(payload))).success).toBe(true);
    }
  });

  it("list Returns accepts complete records and rejects arbitrary projected fields", async () => {
    const commands = new RaviCommandsCommands();
    const completePayload = await silenced(() => commands.list(undefined, true));
    const projectedPayload = await silenced(() =>
      commands.list(undefined, true, undefined, undefined, undefined, "id"),
    );
    const invalidPayload = JSON.parse(JSON.stringify(projectedPayload));
    invalidPayload.items[0].unknown = "not-public";
    invalidPayload.commands[0].unknown = "not-public";

    expect(commandsListReturnSchema.safeParse(JSON.parse(JSON.stringify(completePayload))).success).toBe(true);
    expect(commandsListReturnSchema.safeParse(invalidPayload).success).toBe(false);
  });

  it("list paginates deterministically and emits a reproducible next command", async () => {
    const before = JSON.stringify(registryFixture);
    const commands = new RaviCommandsCommands();
    const first = await silenced(() => commands.list(undefined, true, undefined, "1", "0", "id"));
    const repeated = await silenced(() => commands.list(undefined, true, undefined, "1", "0", "id"));

    expect(first).toEqual(repeated);
    expect(first.items).toEqual([{ id: "review-pr" }]);
    expect(first.pagination).toMatchObject({ limit: 1, offset: 0, returned: 1, total: 2, nextOffset: 1 });
    expect(first.pagination.nextCommand).toContain("ravi commands list --json --limit 1 --offset 1 --fields id");
    expect(JSON.stringify(registryFixture)).toBe(before);
  });

  it("show is deterministic, schema-valid, and does not mutate discovered state", async () => {
    const before = JSON.stringify(registryFixture);
    const commands = new RaviCommandsCommands();
    const first = await silenced(() => commands.show("review-pr", undefined, true));
    const repeated = await silenced(() => commands.show("#REVIEW-PR", undefined, true));

    expect(first).toEqual(repeated);
    expect(commandShowReturnSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(registryFixture)).toBe(before);
  });

  it("validate is deterministic, schema-valid, and does not mutate discovered state", async () => {
    const before = JSON.stringify(registryFixture);
    const commands = new RaviCommandsCommands();
    const first = await silenced(() => commands.validate(undefined, true));
    const repeated = await silenced(() => commands.validate(undefined, true));

    expect(first).toEqual(repeated);
    expect(commandValidateReturnSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(registryFixture)).toBe(before);
  });

  it("run is deterministic, schema-valid, and does not mutate discovered state", async () => {
    const before = JSON.stringify(registryFixture);
    const commands = new RaviCommandsCommands();
    const first = await silenced(() => commands.run("restart", ["ativar", "commands"], undefined, true));
    const repeated = await silenced(() => commands.run("#RESTART", ["ativar", "commands"], undefined, true));

    expect(first).toEqual(repeated);
    expect(commandRunReturnSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(registryFixture)).toBe(before);
  });
});
