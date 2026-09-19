import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PagesCommands } from "../../cli/commands/pages.js";
import { remoteGatewayErrorToContractError } from "../../cli/remote-gateway.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import type { ContextCapability, ContextRecord } from "../../router/router-db.js";
import { dispatch } from "./dispatcher.js";

const registry = buildRegistry([PagesCommands]);
const pagesShip = registry.commands.find((command) => command.fullName === "pages.ship");
if (!pagesShip) throw new Error("pages.ship is missing from the registry");
const pagesShipCommand = pagesShip;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function pagesContext(): ContextRecord {
  const capabilities: ContextCapability[] = [
    { permission: "execute", objectType: "group", objectId: "pages", source: "test" },
  ];
  return {
    contextId: "ctx_pages_ship",
    contextKey: "rctx_pages_ship",
    kind: "test-runtime",
    agentId: "pages-agent",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

async function dispatchPagesShip(body: Record<string, unknown>, cwd?: string) {
  return dispatch(pagesShipCommand, body, {}, { contextRecord: pagesContext(), cwd });
}

describe("remote pages ship cwd and error projection", () => {
  it("resolves relative --html against the caller cwd and treats a found file as valid input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ravi-pages-ship-remote-ok-"));
    tempDirs.push(cwd);
    await writeFile(join(cwd, "index.html"), "<h1>OK</h1>");

    const result = await dispatchPagesShip({ title: "Weekly report", html: "./index.html" }, cwd);
    const body = (await result.response.json()) as {
      success: boolean;
      exitCode: number;
      error: { code: string };
    };

    expect(result.response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      exitCode: 3,
      error: { code: "WRITE_REQUIRES_EXECUTE" },
    });
  });

  it("keeps the relative html not-found reason after remote projection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ravi-pages-ship-remote-missing-"));
    tempDirs.push(cwd);

    const result = await dispatchPagesShip({ title: "Weekly report", html: "./index.html" }, cwd);
    expect(result.response.status).toBe(400);
    const remoteBody = await result.response.text();
    const error = remoteGatewayErrorToContractError("pages ship", {
      status: result.response.status,
      ok: false,
      body: remoteBody,
      contentType: result.response.headers.get("content-type"),
    });

    expect(error).toMatchObject({
      code: "PAYLOAD_INVALID",
      exitCode: 2,
    });
    expect(error?.message).toContain("--html file was not found: ./index.html");
    expect(JSON.stringify(error?.envelope())).toContain("--html file was not found: ./index.html");
    expect(error?.message).not.toBe("Remote gateway rejected the command input.");
    expect(JSON.stringify(error?.envelope())).not.toContain("Remote gateway rejected the command input");
  });
});
