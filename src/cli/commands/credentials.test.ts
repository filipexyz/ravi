/**
 * Agent-first contract tests for the `credentials.connections`,
 * `credentials.policies`, and `credentials.broker` CLI domains (Manual v2):
 * write brake (exit 3) on `connections remove` and `broker exec`, not-found
 * envelopes (CREDENTIAL_CONNECTION_NOT_FOUND, exit 1) with local suggestions,
 * compact `--fields` mode, and a hard anti-leak guarantee: secret values and
 * secret refs never appear in plans or error envelopes. Follows the
 * tasks.test.ts pattern: no-op decorator mocks + service mocks with spies +
 * `hasContext: () => true` so contract helpers throw instead of exiting.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const SECRET_VALUE = "super-secret-token-value";
const SECRET_REF = "keychain:ravi/slack/main";

interface MockConnection {
  id: string;
  provider: string;
  connection: string;
  label: string | null;
  backend: "keychain" | "vault";
  secretRef: string;
  scopes: string[];
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
}

let connections: MockConnection[] = [];
const removeCalls: Array<{ provider: string; connection: string }> = [];
const statusCalls: Array<{ provider: string; connection: string; status: string }> = [];
const upsertCalls: Array<Record<string, unknown>> = [];
const execCalls: Array<Record<string, unknown>> = [];
const deleteSecretCalls: string[] = [];

function findConnection(provider: string, connection: string): MockConnection | null {
  return connections.find((item) => item.provider === provider && item.connection === connection) ?? null;
}

function publicConnection(record: MockConnection): Record<string, unknown> {
  return { ...record, secretRef: `${record.backend}:(redacted)` };
}

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

mock.module("../../credentials/index.js", () => ({
  deleteSecret: async (secretRef: string) => {
    deleteSecretCalls.push(secretRef);
    return true;
  },
  execCredentialBroker: async (input: Record<string, unknown>) => {
    execCalls.push(input);
    const record = findConnection(input.provider as string, input.connection as string);
    if (!record) throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
    return {
      status: input.dryRun ? "planned" : "executed",
      dryRun: Boolean(input.dryRun),
      connection: publicConnection(record),
      policy: {
        provider: record.provider,
        connection: record.connection,
        action: input.action,
        requiredCapabilities: [],
        approval: { required: false, reason: "read_only_provider_action" },
      },
      secretResolved: !input.dryRun,
      result: null,
    };
  },
  explainCredentialPolicy: (input: { provider: string; connection: string; action: string }) => ({
    provider: input.provider,
    connection: input.connection,
    action: input.action,
    requiredCapabilities: [
      `use:credential:${input.provider}:${input.connection}`,
      `execute:${input.provider}:${input.action}`,
    ],
    approval: { required: true, reason: "write_or_destructive_provider_action" },
  }),
  getCredentialConnection: (provider: string, connection: string) => findConnection(provider, connection),
  listCredentialConnections: (input: { includeDisabled?: boolean; status?: string } = {}) => {
    const items = connections.filter((item) =>
      input.status ? item.status === input.status : input.includeDisabled ? true : item.status === "active",
    );
    return { items, total: items.length, limit: 100, offset: 0 };
  },
  normalizeCredentialIdentifier: (value: string) => value.trim().toLowerCase(),
  publicCredentialConnection: (record: MockConnection) => publicConnection(record),
  readSecretFromStdin: async () => SECRET_VALUE,
  removeCredentialConnection: (provider: string, connection: string) => {
    const record = findConnection(provider, connection);
    if (!record) return null;
    removeCalls.push({ provider, connection });
    connections = connections.filter((item) => item !== record);
    return record;
  },
  setCredentialConnectionStatus: (provider: string, connection: string, status: "active" | "disabled") => {
    const record = findConnection(provider, connection);
    if (!record) return null;
    statusCalls.push({ provider, connection, status });
    record.status = status;
    return record;
  },
  upsertCredentialConnection: (input: Record<string, unknown>) => {
    upsertCalls.push(input);
    return {
      id: "cc_new",
      provider: input.provider,
      connection: input.connection,
      label: input.label ?? null,
      backend: input.backend,
      secretRef: input.secretRef,
      scopes: input.scopes ?? [],
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
  },
  writeSecret: async () => SECRET_REF,
}));

const { CredentialConnectionsCommands, CredentialBrokerCommands } = await import("./credentials.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

beforeEach(() => {
  connections = [
    {
      id: "cc_slack_main",
      provider: "slack",
      connection: "main",
      label: "PRIVATE_MESSAGE_8K2R",
      backend: "keychain",
      secretRef: SECRET_REF,
      scopes: ["chat:write"],
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "cc_slack_backup",
      provider: "slack",
      connection: "backup",
      label: null,
      backend: "vault",
      secretRef: "vault:secret/ravi/slack/backup#token",
      scopes: [],
      status: "disabled",
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  removeCalls.length = 0;
  statusCalls.length = 0;
  upsertCalls.length = 0;
  execCalls.length = 0;
  deleteSecretCalls.length = 0;
});

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
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

describe("credentials connections write brake", () => {
  it("minimizes the remove dry-run to identifiers and flags", async () => {
    const commands = new CredentialConnectionsCommands();
    const error = await expectContractError(
      () => commands.remove("slack", "main", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      provider: "slack",
      connection: "main",
      id: "cc_slack_main",
      labelPresent: true,
      backend: "keychain",
      status: "active",
      deleteBackendSecret: false,
    });
    const serialized = JSON.stringify(error.envelope());
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(removeCalls).toHaveLength(0);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  it("remove with --execute removes the connection metadata", async () => {
    const commands = new CredentialConnectionsCommands();
    const payload = await silenced(() => commands.remove("slack", "main", undefined, true, true));

    expect(removeCalls).toEqual([{ provider: "slack", connection: "main" }]);
    expect(deleteSecretCalls).toHaveLength(0);
    expect(payload).toMatchObject({ secretDeleted: false });
  });

  it("remove with --execute --delete-secret also deletes the backend secret", async () => {
    const commands = new CredentialConnectionsCommands();
    const payload = await silenced(() => commands.remove("slack", "main", true, true, true));

    expect(removeCalls).toHaveLength(1);
    expect(deleteSecretCalls).toEqual([SECRET_REF]);
    expect(payload).toMatchObject({ secretDeleted: true });
  });

  it("remove validates BEFORE the brake: unknown connection exits 1 with the not-found envelope", async () => {
    const commands = new CredentialConnectionsCommands();
    const error = await expectContractError(
      () => commands.remove("slack", "ghost", undefined, true, undefined),
      "CREDENTIAL_CONNECTION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("slack:main");
    expect(removeCalls).toHaveLength(0);
  });
});

describe("credentials broker exec contract", () => {
  it("minimizes the broker policy to approval and capability metadata", async () => {
    const commands = new CredentialBrokerCommands();
    const error = await expectContractError(
      () => commands.exec("slack", "main", "messages.send", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      provider: "slack",
      connection: "main",
      action: "messages.send",
      policy: {
        approvalRequired: true,
        requiredCapabilitiesCount: 2,
      },
    });
    const serialized = JSON.stringify(error.envelope());
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain("write_or_destructive_provider_action");
    expect(execCalls).toHaveLength(0);
  });

  it("exec with --execute resolves the credential through the broker", async () => {
    const commands = new CredentialBrokerCommands();
    const payload = await silenced(() => commands.exec("slack", "main", "messages.send", undefined, true, true));

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ provider: "slack", connection: "main", dryRun: false });
    expect(payload).toMatchObject({ status: "executed", secretResolved: true });
  });

  it("legacy --dry-run keeps the pre-existing exit-0 planned payload (documented equivalent)", async () => {
    const commands = new CredentialBrokerCommands();
    const payload = await silenced(() => commands.exec("slack", "main", "messages.send", true, true, undefined));

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ dryRun: true });
    expect(payload).toMatchObject({ status: "planned", dryRun: true, secretResolved: false });
  });

  it("exec on an unknown connection exits 1 with the not-found envelope before any broker call", async () => {
    const commands = new CredentialBrokerCommands();
    const error = await expectContractError(
      () => commands.exec("slack", "ghost", "messages.send", undefined, true, undefined),
      "CREDENTIAL_CONNECTION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("slack:main");
    expect(execCalls).toHaveLength(0);
  });
});

describe("credentials connections unbraked writes and envelopes", () => {
  it("add with --secret-ref is declared UNBRAKED: it writes immediately without --execute", async () => {
    const commands = new CredentialConnectionsCommands();
    await silenced(() =>
      commands.add(
        "slack",
        "sales",
        "keychain",
        "Sales",
        "chat:write",
        undefined,
        "keychain:ravi/slack/sales",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ provider: "slack", connection: "sales", backend: "keychain" });
  });

  it("enable/disable are declared UNBRAKED and write immediately", async () => {
    const commands = new CredentialConnectionsCommands();
    await silenced(() => commands.disable("slack", "main", true));
    await silenced(() => commands.enable("slack", "main", true));

    expect(statusCalls).toEqual([
      { provider: "slack", connection: "main", status: "disabled" },
      { provider: "slack", connection: "main", status: "active" },
    ]);
  });

  it("enable on an unknown connection exits 1 with the not-found envelope and suggestions", async () => {
    const commands = new CredentialConnectionsCommands();
    const error = await expectContractError(
      () => commands.enable("slack", "mian", true),
      "CREDENTIAL_CONNECTION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("slack:main");
  });

  it("show on an unknown connection exits 1 with the not-found envelope and suggestions", async () => {
    const commands = new CredentialConnectionsCommands();
    const error = await expectContractError(
      () => commands.show("slack", "bakup", true),
      "CREDENTIAL_CONNECTION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("slack:backup");
    expect(error.details.suggestedAction).toContain("ravi credentials connections list");
  });
});

describe("credentials connections compact mode", () => {
  it("list --fields narrows each item to the requested fields", async () => {
    const commands = new CredentialConnectionsCommands();
    const payload = await silenced(() =>
      commands.list(undefined, undefined, true, undefined, undefined, true, "provider,connection,status"),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["connection", "provider", "status"]);
    }
  });
});
