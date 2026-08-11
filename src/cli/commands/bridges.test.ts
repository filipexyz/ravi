import { afterAll, describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";

// Manual v2 contract: hasContext() true makes the contract helpers throw
// ContractError instead of process.exit, which is what tests need.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { BridgesCommands } = await import("./bridges.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

describe("bridges CLI commands", () => {
  it("lists Ravi MCP bridges with agent-friendly pagination metadata", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        bridges: [
          {
            id: "bridge_1",
            name: "Claude Desktop",
            status: "active",
            allowedCapabilityClasses: ["read"],
            calls24h: 3,
          },
        ],
      };
    });
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list("demo", undefined, undefined, undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/mcp/bridges?project=demo",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "demo",
      total: 1,
      pagination: {
        limit: 50,
        offset: 0,
        returned: 1,
        total: 1,
      },
      bridges: [{ id: "bridge_1", name: "Claude Desktop" }],
      items: [{ id: "bridge_1" }],
    });
  });

  it("creates a bridge and prints the returned MCP URL in JSON mode", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        bridge: {
          id: "bridge_1",
          name: "Claude Desktop",
          status: "active",
        },
        bridgeToken: "mcp_bridge_secret",
        bridgeUrl: "https://mcp.ravi.so/mcp_bridge_secret/mcp",
      };
    });
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.create("demo", "Claude Desktop", "Local Claude bridge", "read,write", undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/mcp/bridges",
        body: {
          projectRef: "demo",
          name: "Claude Desktop",
          description: "Local Claude bridge",
          allowedCapabilityClasses: ["read", "write"],
        },
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "demo",
      bridge: { id: "bridge_1" },
      bridgeUrl: "https://mcp.ravi.so/mcp_bridge_secret/mcp",
    });
  });

  it("revokes a bridge after explicit confirmation", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return { revoked: true, bridgeId: "bridge_1" };
    });
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.revoke("bridge_1", true, undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/mcp/bridges/bridge_1/revoke",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toEqual({
      success: true,
      consoleUrl: "https://console.example",
      revoked: true,
      bridgeId: "bridge_1",
    });
  });
});

// Manual v2 agent-first contract: write brake on the destructive revoke,
// `--fields` compact mode, and ContractError passing through the legacy
// CloudAuthError funnel untouched.
describe("bridges contract", () => {
  it("revoke without --yes/--execute is a dry-run: exit 3 and NO Console call", async () => {
    const calls: string[] = [];
    const client = makeClient(async (_method, path) => {
      calls.push(path);
      return { revoked: true, bridgeId: "bridge_1" };
    });
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.revoke("bridge_1", undefined, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({ bridgeId: "bridge_1", revokesClientTokens: true });
    expect(calls).toHaveLength(0);
  });

  it("revoke with --execute performs the Console call", async () => {
    const calls: string[] = [];
    const client = makeClient(async (_method, path) => {
      calls.push(path);
      return { revoked: true, bridgeId: "bridge_1" };
    });
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.revoke("bridge_1", undefined, undefined, true, true));

    expect(calls).toEqual(["/api/cli/mcp/bridges/bridge_1/revoke"]);
    expect(JSON.parse(output)).toMatchObject({ revoked: true, bridgeId: "bridge_1" });
  });

  it("list --fields narrows each bridge to the requested fields", async () => {
    const client = makeClient(async () => ({
      bridges: [
        { id: "bridge_1", name: "Claude Desktop", status: "active", calls24h: 3 },
        { id: "bridge_2", name: "Cursor", status: "active", calls24h: 0 },
      ],
    }));
    const command = new BridgesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.list("demo", undefined, undefined, undefined, true, "id,status"),
    );
    const payload = JSON.parse(output);

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "status"]);
    }
  });

  it("rethrows ContractError instead of wrapping it in the CloudAuthError funnel", async () => {
    const boom = new ContractError("bridges list", "SOME_CONTRACT_CODE", "boom", 1, {});
    const command = new BridgesCommands({
      client: makeClient(async () => ({ bridges: [] })),
      readCredentials: () => {
        throw boom;
      },
    });

    let caught: unknown;
    try {
      await captureConsole(() => command.list("demo", undefined, undefined, undefined, true));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect((caught as InstanceType<typeof ContractError>).exitCode).toBe(1);
  });
});

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  try {
    await captureConsole(async () => await run());
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials() {
  return () => makeCredentials();
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "console.projects.link"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
