import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getCredentialConnection } from "../credentials/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  deleteMcpServerSecret,
  hasMcpServerSecret,
  MCP_CREDENTIAL_PROVIDER,
  McpSecretError,
  readMcpServerSecret,
  writeMcpServerSecret,
} from "./secrets.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-secrets-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function secretFiles(): string[] {
  const directory = join(stateDir as string, "credential-secrets");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("MCP server secrets", () => {
  it("keeps one credentials-store entry per server, provider mcp", async () => {
    await writeMcpServerSecret("console", { url: "https://mcp.example.com/b/abcdefghijklmnopqrstuvwxyz" });

    const connection = getCredentialConnection(MCP_CREDENTIAL_PROVIDER, "console");
    expect(connection).toMatchObject({ provider: "mcp", connection: "console", backend: "file", status: "active" });
    expect(connection?.secretRef).toMatch(/^file:[a-f0-9]{64}$/);
    expect(connection?.secretRef).not.toContain("abcdefghijklmnop");
    expect(hasMcpServerSecret("console")).toBe(true);
    expect(await readMcpServerSecret("console")).toEqual({
      url: "https://mcp.example.com/b/abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("stores stdio env values and replaces them on a second write", async () => {
    await writeMcpServerSecret("files", { env: { B_KEY: "two", A_KEY: "one" } });
    await writeMcpServerSecret("files", { env: { A_KEY: "three" } });

    expect(await readMcpServerSecret("files")).toEqual({ env: { A_KEY: "three" } });
    expect(secretFiles()).toHaveLength(1);
  });

  it("deletes the value and the entry, and reports an absent one", async () => {
    await writeMcpServerSecret("files", { env: { A_KEY: "one" } });

    expect(await deleteMcpServerSecret("files")).toBe(true);
    expect(hasMcpServerSecret("files")).toBe(false);
    expect(await readMcpServerSecret("files")).toBeNull();
    expect(secretFiles()).toHaveLength(0);
    expect(await deleteMcpServerSecret("files")).toBe(false);
  });

  it("refuses a document over 64 KB without echoing it", async () => {
    const huge = "x".repeat(70 * 1024);
    const error = await writeMcpServerSecret("big", { env: { A_KEY: huge } }).catch((caught) => caught);

    expect(error).toBeInstanceOf(McpSecretError);
    expect((error as McpSecretError).code).toBe("secret_too_large");
    expect((error as Error).message).not.toContain("xxxx");
    expect(hasMcpServerSecret("big")).toBe(false);
  });
});
