import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import {
  createMcpBridge,
  listMcpBridges,
  normalizeBridgeCapabilityClasses,
  resolveBridgeProjectRef,
  revokeMcpBridge,
} from "./client.js";

describe("Ravi MCP bridges Console client", () => {
  it("lists bridges through the Console MCP CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        bridges: [
          {
            id: "bridge_1",
            name: "Claude Desktop",
            status: "active",
          },
        ],
      };
    });

    const result = await listMcpBridges({ projectRef: "demo" }, { client, readCredentials: makeReadCredentials() });

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/mcp/bridges?project=demo",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(result).toMatchObject({
      success: true,
      projectRef: "demo",
      total: 1,
      bridges: [{ id: "bridge_1", name: "Claude Desktop" }],
    });
  });

  it("creates a bridge with explicit capability classes", async () => {
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

    const result = await createMcpBridge(
      {
        projectRef: "demo",
        name: "Claude Desktop",
        description: "Local Claude bridge",
        allowedCapabilityClasses: ["read", "write"],
      },
      { client, readCredentials: makeReadCredentials() },
    );

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
    expect(result).toMatchObject({
      success: true,
      projectRef: "demo",
      bridge: { id: "bridge_1" },
      bridgeUrl: "https://mcp.ravi.so/mcp_bridge_secret/mcp",
    });
  });

  it("revokes a bridge by id", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return { revoked: true, bridgeId: "bridge_1" };
    });

    const result = await revokeMcpBridge("bridge_1", {}, { client, readCredentials: makeReadCredentials() });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/mcp/bridges/bridge_1/revoke",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(result).toEqual({
      success: true,
      consoleUrl: "https://console.example",
      revoked: true,
      bridgeId: "bridge_1",
    });
  });

  it("normalizes project and capability inputs", () => {
    expect(resolveBridgeProjectRef(undefined, { RAVI_PROJECT: " demo " })).toBe("demo");
    expect(() => resolveBridgeProjectRef(undefined, {})).toThrow("Missing --project");
    expect(normalizeBridgeCapabilityClasses("read, write,read")).toEqual(["read", "write"]);
    expect(() => normalizeBridgeCapabilityClasses("admin")).toThrow("--allow must include only");
  });
});

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
