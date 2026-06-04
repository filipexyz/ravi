import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { BridgesCommands } from "./bridges.js";

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
