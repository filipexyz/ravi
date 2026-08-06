/**
 * Agent-first contract tests for the `connectors` CLI domain (Manual v2):
 * write brake (exit 3) on the destructive `revoke` — with the pre-existing
 * `--yes` flag kept as documented equivalent of `--execute` — compact
 * `--fields` mode on `list`, and ContractError passing through the legacy
 * CloudAuthError funnel untouched. `connect` is intentionally NOT covered:
 * it is a declared human-in-the-loop browser OAuth flow (unbraked).
 * Follows the tasks.test.ts pattern: no-op decorator mocks + service mocks
 * with spies + `hasContext: () => true` so contract helpers throw instead of
 * exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const revokeCalls: string[] = [];
let listResult: Array<Record<string, unknown>> = [];
let listError: unknown = null;

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

mock.module("./operational-return-schemas.js", () => ({
  commandEnvelopeReturnSchema: {},
  declareCommandReturns: () => {},
}));

mock.module("../../link/connectors.js", () => ({
  execCapability: async () => ({ result: null, capability: "", refreshed: false }),
  getConnectStatus: async () => ({
    status: "consumed" as const,
    provider: "google",
    connectorId: "conn_1",
    expiresAt: new Date().toISOString(),
  }),
  listConnectors: async () => {
    if (listError) throw listError;
    return listResult;
  },
  revokeConnector: async (id: string) => {
    revokeCalls.push(id);
  },
  showConnector: async (id: string) => ({
    id,
    projectId: "proj_1",
    provider: "google",
    displayName: "Google",
    status: "active",
    requiresReauth: false,
    scopes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    capabilities: [],
    externalAccountLogin: null,
    grantedAt: "2026-01-01T00:00:00.000Z",
    lastReauthAt: null,
  }),
  startConnect: async () => ({
    connectUrl: "https://link.example/connect",
    pendingGrantId: "pg_1",
    expiresAt: new Date().toISOString(),
  }),
}));

const { ConnectorsCommands } = await import("./connectors.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

beforeEach(() => {
  revokeCalls.length = 0;
  listResult = [
    { id: "conn_1", projectId: "proj_1", provider: "google", displayName: "Gmail", status: "active" },
    { id: "conn_2", projectId: "proj_1", provider: "google", displayName: "Calendar", status: "active" },
  ];
  listError = null;
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

describe("connectors revoke write brake", () => {
  it("revoke without --yes/--execute is a dry-run: exit 3 and NO Link call", async () => {
    const commands = new ConnectorsCommands();
    const error = await expectContractError(
      () => commands.revoke("conn_1", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({ id: "conn_1", deletesStoredCredentials: true });
    expect(revokeCalls).toHaveLength(0);
  });

  it("revoke with --execute revokes the connector", async () => {
    const commands = new ConnectorsCommands();
    const payload = await silenced(() => commands.revoke("conn_1", undefined, true, true));

    expect(revokeCalls).toEqual(["conn_1"]);
    expect(payload).toMatchObject({ revoked: true, id: "conn_1" });
  });

  it("legacy --yes stays the documented equivalent of --execute", async () => {
    const commands = new ConnectorsCommands();
    const payload = await silenced(() => commands.revoke("conn_1", true, true, undefined));

    expect(revokeCalls).toEqual(["conn_1"]);
    expect(payload).toMatchObject({ revoked: true, id: "conn_1" });
  });
});

describe("connectors list contract", () => {
  it("list --fields narrows each connector to the requested fields", async () => {
    const commands = new ConnectorsCommands();
    const payload = await silenced(() =>
      commands.list(undefined, undefined, undefined, undefined, true, "id,provider"),
    );

    const connections = (payload as unknown as { connections: Array<Record<string, unknown>> }).connections;
    expect(connections).toHaveLength(2);
    for (const item of connections) {
      expect(Object.keys(item).sort()).toEqual(["id", "provider"]);
    }
  });

  it("rethrows ContractError instead of wrapping it in the CloudAuthError funnel", async () => {
    const boom = new ContractError("connectors list", "SOME_CONTRACT_CODE", "boom", 1, {});
    listError = boom;
    const commands = new ConnectorsCommands();

    let caught: unknown;
    await silenced(async () => {
      try {
        await commands.list(undefined, undefined, undefined, undefined, true);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(boom);
    expect((caught as InstanceType<typeof ContractError>).exitCode).toBe(1);
  });
});
