import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { McpServerNameError } from "./names.js";
import {
  attachMcpServer,
  bumpMcpCredentialRev,
  createMcpServer,
  detachMcpServer,
  getMcpAttachment,
  getMcpServer,
  listMcpAttachments,
  listMcpServers,
  type McpConfigChangedEvent,
  McpRegistryError,
  MCP_ELICITATION_ROW_KEEP_MS,
  pruneMcpElicitationRequests,
  recordMcpServerProbe,
  removeMcpServer,
  setMcpConfigChangedEmitterForTests,
  updateMcpAttachments,
  updateMcpServerConfig,
} from "./registry-db.js";

let stateDir: string | null = null;
let events: McpConfigChangedEvent[] = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-registry-");
  events = [];
  setMcpConfigChangedEmitterForTests((event) => events.push(event));
});

afterEach(async () => {
  setMcpConfigChangedEmitterForTests(null);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const TOKEN_URL = "https://mcp.example.com/bridge/AbCdEf0123456789xyzTOKEN/mcp?key=sk-live-123";

function addHttp(name = "github") {
  return createMcpServer({ name, transport: "http", url: TOKEN_URL, authKind: "oauth", createdBy: "operator" });
}

describe("mcp registry tables", () => {
  it("are created by the lazy-init block of the isolated state database", () => {
    expect(listMcpServers()).toEqual([]);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mcp_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "mcp_agent_servers",
      "mcp_calls",
      "mcp_elicitation_requests",
      "mcp_server_rate_limits",
      "mcp_servers",
      "mcp_skill_pins",
    ]);
    expect(existsSync(join(stateDir!, "ravi.db"))).toBe(true);
  });

  it("refuse to open the real state when no isolated state is selected", () => {
    const home = mkdtempSync(join(tmpdir(), "ravi-mcp-real-home-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, RAVI_MCP_TEST_HOME: home, HOME: home };
      delete env.RAVI_STATE_DIR;
      const result = spawnSync(
        process.execPath,
        [
          "--eval",
          `
          import { mock } from 'bun:test';
          import * as os from 'node:os';
          const home = process.env.RAVI_MCP_TEST_HOME;
          mock.module('node:os', () => ({ ...os, homedir: () => home, default: { ...os, homedir: () => home } }));
          const { listMcpServers } = await import('./src/mcp/registry-db.ts');
          try { listMcpServers(); throw new Error('UNSAFE_OPEN'); }
          catch (error) { if (error.code !== 'REAL_STATE_ACCESS_REFUSED') throw error; }
        `,
        ],
        { cwd: resolve(import.meta.dir, "../.."), env, encoding: "utf8" },
      );
      expect(result.stderr).not.toContain("UNSAFE_OPEN");
      expect(result.status).toBe(0);
      expect(existsSync(join(home, ".ravi", "ravi.db"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mcp_servers", () => {
  it("stores only the display form of an http URL", () => {
    const server = addHttp();
    expect(server).toMatchObject({
      name: "github",
      transport: "http",
      urlDisplay: "https://mcp.example.com/bridge/…/mcp",
      urlSecret: true,
      authKind: "oauth",
      protocol: "auto",
      enabled: true,
      origin: "manual",
      status: "unknown",
      era: null,
      credentialRev: 0,
      createdBy: "operator",
    });
    const raw = JSON.stringify(getDb().prepare("SELECT * FROM mcp_servers").all());
    expect(raw).not.toContain("AbCdEf0123456789xyzTOKEN");
    expect(raw).not.toContain("sk-live-123");
    for (const suffix of ["", "-wal"]) {
      const path = join(stateDir!, `ravi.db${suffix}`);
      if (!existsSync(path)) continue;
      expect(readFileSync(path).includes(Buffer.from("AbCdEf0123456789xyzTOKEN"))).toBe(false);
    }
  });

  it("stores a stdio server with argument list and env key names only", () => {
    const server = createMcpServer({
      name: "local-fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/server", "--root", "/tmp"],
      envKeys: ["API_KEY", "API_KEY", "OTHER"],
    });
    expect(server).toMatchObject({
      transport: "stdio",
      urlDisplay: null,
      command: "npx",
      args: ["-y", "@scope/server", "--root", "/tmp"],
      envKeys: ["API_KEY", "OTHER"],
      authKind: "none",
    });
  });

  it("refuses an env value given as a key, bad names and credentialed stdio", () => {
    expect(() =>
      createMcpServer({ name: "x", transport: "stdio", command: "srv", envKeys: ["API_KEY=sk-123"] }),
    ).toThrow(McpRegistryError);
    expect(() => createMcpServer({ name: "my_srv", transport: "stdio", command: "srv" })).toThrow(McpServerNameError);
    expect(() => createMcpServer({ name: "spec", transport: "stdio", command: "srv" })).toThrow(McpServerNameError);
    expect(() => createMcpServer({ name: "x", transport: "stdio", command: "srv", authKind: "oauth" })).toThrow(
      McpRegistryError,
    );
    expect(() => createMcpServer({ name: "x", transport: "http", url: "http://example.com/mcp" })).toThrow();
    expect(listMcpServers()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses a second server with the same name", () => {
    addHttp();
    try {
      addHttp();
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as McpRegistryError).code).toBe("already_registered");
    }
  });

  it("emits ravi.config.changed with reason mcp_servers on every write", () => {
    addHttp();
    updateMcpServerConfig("github", { enabled: false });
    attachMcpServer({ agentId: "main", server: "github" });
    updateMcpAttachments({ server: "github", audience: "any" });
    recordMcpServerProbe("github", { status: "ok", era: "modern" });
    bumpMcpCredentialRev("github", 0);
    detachMcpServer("main", "github");
    removeMcpServer("github");
    expect(events.map((event) => [event.reason, event.change, event.servers])).toEqual([
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "status", ["github"]],
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "config", ["github"]],
      ["mcp_servers", "config", ["github"]],
    ]);
  });

  it("emits nothing when a write changes nothing", () => {
    expect(updateMcpServerConfig("missing", { enabled: false })).toBeNull();
    expect(detachMcpServer("main", "missing")).toBe(false);
    expect(removeMcpServer("missing")).toBeNull();
    expect(recordMcpServerProbe("missing", { status: "ok" })).toBeNull();
    expect(updateMcpAttachments({ server: "missing", audience: "operator" })).toBe(0);
    expect(events).toEqual([]);
  });

  it("caches status, era, extensions and catalog, and resets the probe when the protocol changes", () => {
    addHttp();
    const catalog = {
      tools: [{ name: "search", exposedName: "mcp__github__search", description: "Search", inputSchema: {} }],
      dropped: [{ name: "bad.name", reason: "dots" }],
    };
    const probed = recordMcpServerProbe("github", {
      status: "ok",
      statusDetail: "  connected  ",
      era: "modern",
      discover: { supportedVersions: ["2026-07-28"] },
      extensions: { "io.modelcontextprotocol/tasks": {} },
      catalog,
      catalogFingerprint: "sha256:abc",
      checkedAt: 1234,
    });
    expect(probed).toMatchObject({
      status: "ok",
      statusDetail: "connected",
      era: "modern",
      discover: { supportedVersions: ["2026-07-28"] },
      extensions: { "io.modelcontextprotocol/tasks": {} },
      catalog,
      catalogFingerprint: "sha256:abc",
      checkedAt: 1234,
    });
    const pinned = updateMcpServerConfig("github", { protocol: "2026-07-28" });
    expect(pinned).toMatchObject({ protocol: "2026-07-28", era: null, discover: null, status: "unknown" });
    expect(pinned?.catalog).toEqual(catalog);
  });

  it("reads a malformed catalog as no catalog", () => {
    addHttp();
    getDb().prepare("UPDATE mcp_servers SET catalog_json = ? WHERE name = 'github'").run('{"tools":[{"name":1}]}');
    expect(getMcpServer("github")?.catalog).toBeNull();
  });

  it("swaps the credential revision only from the expected value", () => {
    addHttp();
    expect(bumpMcpCredentialRev("github", 0)).toBe(1);
    expect(bumpMcpCredentialRev("github", 0)).toBeNull();
    expect(getMcpServer("github")?.credentialRev).toBe(1);
  });

  it("enforces transport-specific fields on update", () => {
    addHttp();
    expect(() => updateMcpServerConfig("github", { command: "x" })).toThrow(McpRegistryError);
    const moved = updateMcpServerConfig("github", { url: "https://other.example.com/abcdefghijklmnopqrstu" });
    expect(moved?.urlDisplay).toBe("https://other.example.com/…");
    expect(moved?.urlSecret).toBe(true);
    expect(updateMcpServerConfig("github", { url: "https://other.example.com/mcp" })?.urlSecret).toBe(false);
  });
});

describe("mcp_agent_servers", () => {
  it("attaches with operator audience and uploads off by default", () => {
    addHttp();
    const { attachment, created } = attachMcpServer({ agentId: "main", server: "github", createdBy: "operator" });
    expect(created).toBe(true);
    expect(attachment).toMatchObject({ agentId: "main", server: "github", audience: "operator", uploads: false });
  });

  it("returns an existing attachment unchanged instead of widening it", () => {
    addHttp();
    attachMcpServer({ agentId: "main", server: "github" });
    const again = attachMcpServer({ agentId: "main", server: "github", audience: "any", uploads: true });
    expect(again.created).toBe(false);
    expect(again.attachment).toMatchObject({ audience: "operator", uploads: false });
  });

  it("refuses to attach an unregistered server", () => {
    try {
      attachMcpServer({ agentId: "main", server: "github" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as McpRegistryError).code).toBe("not_registered");
    }
  });

  it("updates one agent's attachment or all of a server's", () => {
    addHttp();
    attachMcpServer({ agentId: "main", server: "github" });
    attachMcpServer({ agentId: "dev", server: "github" });
    expect(updateMcpAttachments({ server: "github", agentId: "dev", uploads: true })).toBe(1);
    expect(getMcpAttachment("dev", "github")?.uploads).toBe(true);
    expect(getMcpAttachment("main", "github")?.uploads).toBe(false);
    expect(updateMcpAttachments({ server: "github", audience: "any" })).toBe(2);
    expect(listMcpAttachments({ server: "github" }).map((row) => [row.agentId, row.audience])).toEqual([
      ["dev", "any"],
      ["main", "any"],
    ]);
  });

  it("drops a server's attachments with the server", () => {
    addHttp();
    addHttp("linear");
    attachMcpServer({ agentId: "main", server: "github" });
    attachMcpServer({ agentId: "main", server: "linear" });
    expect(removeMcpServer("github")?.name).toBe("github");
    expect(listMcpAttachments({ agentId: "main" }).map((row) => row.server)).toEqual(["linear"]);
    expect(getMcpServer("github")).toBeNull();
  });
});

describe("mcp elicitation rows", () => {
  it("are pruned a day after they settle or expire, and kept while they may still be answered", () => {
    const now = 10 * MCP_ELICITATION_ROW_KEEP_MS;
    const day = MCP_ELICITATION_ROW_KEEP_MS;
    const insert = getDb().prepare(
      `INSERT INTO mcp_elicitation_requests (id, account_id, chat_id, user_id, contact_id, server, tool, mode,
        request_json, status, created_at, expires_at, settled_at)
       VALUES (?, 'acct', 'C1', 'U1', 'c1', 'console', 'publish', 'form', '{}', ?, ?, ?, ?)`,
    );
    insert.run("open", "open", now - 60_000, now + 60_000, null);
    insert.run("settled-recently", "answered", now - day, now + day, now - day + 1);
    insert.run("settled-old", "answered", now - 3 * day, now + day, now - day - 1);
    insert.run("expired-recently", "expired", now - 2 * day, now - 60_000, null);
    insert.run("expired-old", "expired", now - 3 * day, now - day - 1, null);
    expect(pruneMcpElicitationRequests(now)).toBe(2);
    const left = getDb().prepare("SELECT id FROM mcp_elicitation_requests ORDER BY id").all() as Array<{ id: string }>;
    expect(left.map((row) => row.id)).toEqual(["expired-recently", "open", "settled-recently"]);
    expect(pruneMcpElicitationRequests(now)).toBe(0);
  });
});
