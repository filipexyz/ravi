/**
 * `ravi mcp import` (spec mcp, Import): discovery of runtime-native MCP
 * entries in every source, name normalization and collisions, the plan, and
 * the command against an isolated Ravi state. Secret values (full URLs, env
 * values) must never reach output, the plan or `ravi.db`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContractError } from "../cli/agent-contract.js";
import { getContext, runWithContext } from "../cli/context.js";
import { McpCommands, setMcpImportHostForTests } from "../cli/commands/mcp.js";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  discoverNativeMcpEntries,
  findUnregisteredNativeMcpEntries,
  type McpImportAgent,
  type McpImportFs,
  normalizeMcpImportName,
  type NativeMcpEntry,
  planMcpImport,
} from "./import.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpAttachment,
  getMcpServer,
  listMcpAttachments,
  type McpConfigChangedEvent,
  setMcpConfigChangedEmitterForTests,
} from "./registry-db.js";
import { warnAboutUnregisteredNativeMcp } from "./native-startup-warning.js";
import { readMcpServerSecret, writeMcpServerSecret } from "./secrets.js";

const TOKEN = "s3cr3tTOKENvalue0123456789abcdef";
const TOKEN_URL = `https://mcp.example.com/bridge/${TOKEN}/mcp`;
const ENV_VALUE = "env-value-QWERTYUIOP-0987654321";

// ============================================================================
// Fixtures
// ============================================================================

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const hostFs: McpImportFs = {
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path) => readFileSync(path, "utf8"),
  listDirs: (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
};

interface Layout {
  home: string;
  cwd: string;
  codexHome: string;
  plugin: string;
}

/** A home with one entry in each source, for an agent working in `cwd`. */
function writeEverySource(): Layout {
  const home = tempDir("ravi-mcp-import-home-");
  const cwd = join(home, "work", "main");
  const codexHome = join(home, ".codex");
  const plugin = join(home, "ravi", "plugins", "tools");
  mkdirSync(cwd, { recursive: true });
  writeJson(join(cwd, ".mcp.json"), {
    mcpServers: {
      project_docs: { type: "http", url: "https://docs.example.com/mcp" },
      bridge: { type: "http", url: TOKEN_URL },
    },
  });
  writeJson(join(home, ".claude.json"), {
    numStartups: 3,
    mcpServers: { "User-Files": { command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: ENV_VALUE } } },
    projects: {
      // A local-scope entry: Claude Code does not load it in a Ravi session.
      [cwd]: { mcpServers: { local_only: { type: "http", url: "https://local.example.com/mcp" } } },
      "/elsewhere": { mcpServers: { unrelated: { type: "http", url: "https://other.example.com/mcp" } } },
    },
  });
  writeJson(join(plugin, ".claude-plugin", "plugin.json"), { name: "tools" });
  writeJson(join(plugin, ".mcp.json"), {
    mcpServers: { "plugin-tool": { command: "node", args: ["\u0024{CLAUDE_PLUGIN_ROOT}/server.js"] } },
  });
  writeText(
    join(codexHome, "config.toml"),
    ['model = "x"', "", "[mcp_servers.codex_search]", 'url = "https://search.example.com/mcp"', ""].join("\n"),
  );
  writeText(
    join(cwd, ".codex", "config.toml"),
    [
      "[mcp_servers.local_db]",
      'command = "db-mcp"',
      'args = ["--readonly"]',
      "enabled = false",
      "[mcp_servers.local_db.env]",
      `DB_PASSWORD = "${ENV_VALUE}"`,
      "",
    ].join("\n"),
  );
  return { home, cwd, codexHome, plugin };
}

/** A Claude agent that loads user and project settings, and a Codex agent, both in `cwd`. */
function everyRuntime(layout: Layout): McpImportAgent[] {
  return [
    { id: "main", cwd: layout.cwd, runtime: "claude", settingSources: ["user", "project"] },
    { id: "coder", cwd: layout.cwd, runtime: "codex" },
  ];
}

function discover(layout: Layout, agents: McpImportAgent[] = everyRuntime(layout)) {
  return discoverNativeMcpEntries({ agents, homeDir: layout.home, codexHome: layout.codexHome, fs: hostFs });
}

function entryNamed(entries: NativeMcpEntry[], nativeName: string): NativeMcpEntry {
  const entry = entries.find((item) => item.nativeName === nativeName);
  expect(entry).toBeDefined();
  return entry as NativeMcpEntry;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

// ============================================================================
// Discovery
// ============================================================================

describe("discoverNativeMcpEntries", () => {
  it("reads every source and assigns the agents that loaded each entry", () => {
    const layout = writeEverySource();
    const { sources, entries } = discover(layout);

    expect(sources.map((source) => `${source.kind}:${source.status}`).sort()).toEqual([
      "agent-mcp-json:read",
      "claude-project:read",
      "claude-user:read",
      "codex-home:read",
      "codex-project:read",
      "plugin:read",
    ]);
    expect(entries.map((entry) => entry.nativeName).sort()).toEqual([
      "User-Files",
      "bridge",
      "codex_search",
      "local_db",
      "local_only",
      "plugin-tool",
      "project_docs",
    ]);
    // A project entry for a directory no agent uses is not read.
    expect(entries.some((entry) => entry.nativeName === "unrelated")).toBe(false);
    // Claude Code files reach the Claude agent, Codex files the Codex agent.
    for (const name of ["User-Files", "bridge", "plugin-tool", "project_docs"]) {
      expect(entryNamed(entries, name)).toMatchObject({ agentIds: ["main"], notLoaded: null });
    }
    for (const name of ["codex_search", "local_db"]) {
      expect(entryNamed(entries, name)).toMatchObject({ agentIds: ["coder"], notLoaded: null });
    }

    const docs = entryNamed(entries, "project_docs");
    expect(docs).toMatchObject({ kind: "agent-mcp-json", transport: "http", unsupported: null });
    expect(entryNamed(entries, "bridge")).toMatchObject({ kind: "agent-mcp-json", url: TOKEN_URL });
    expect(entryNamed(entries, "local_only")).toMatchObject({
      kind: "claude-project",
      scope: layout.cwd,
      agentIds: [],
    });
    expect(entryNamed(entries, "local_only").notLoaded).toContain("local-scope");
    expect(entryNamed(entries, "User-Files")).toMatchObject({
      kind: "claude-user",
      transport: "stdio",
      command: "npx",
      args: ["-y", "files-server"],
      env: { FILES_KEY: ENV_VALUE },
    });
    expect(entryNamed(entries, "plugin-tool")).toMatchObject({
      kind: "plugin",
      command: "node",
      args: [`${layout.plugin}/server.js`],
    });
    expect(entryNamed(entries, "codex_search")).toMatchObject({ kind: "codex-home", transport: "http" });
    expect(entryNamed(entries, "local_db")).toMatchObject({
      kind: "codex-project",
      transport: "stdio",
      command: "db-mcp",
      args: ["--readonly"],
      enabled: false,
      env: { DB_PASSWORD: ENV_VALUE },
    });
  });

  it("gives each entry only to the agents whose runtime loaded it: runtime, directory and settingSources", () => {
    const layout = writeEverySource();
    const other = join(layout.home, "work", "other");
    mkdirSync(other, { recursive: true });
    const { entries } = discover(layout, [
      // Ravi's default settingSources: project only, so no user entries.
      { id: "main", cwd: layout.cwd, runtime: "claude" },
      { id: "helper", cwd: other, runtime: "claude", settingSources: ["user", "project"] },
      { id: "coder", cwd: other, runtime: "codex" },
      { id: "pi", cwd: layout.cwd, runtime: "pi" },
      { id: "grok", cwd: other, runtime: "grok" },
    ]);
    expect(entryNamed(entries, "project_docs").agentIds).toEqual(["main"]);
    expect(entryNamed(entries, "bridge").agentIds).toEqual(["main"]);
    expect(entryNamed(entries, "User-Files").agentIds).toEqual(["helper"]);
    expect(entryNamed(entries, "plugin-tool").agentIds).toEqual(["main", "helper"]);
    expect(entryNamed(entries, "codex_search").agentIds).toEqual(["coder"]);
    // The Codex project file sits where no Codex agent works.
    expect(entryNamed(entries, "local_db")).toMatchObject({ agentIds: [] });
    expect(entryNamed(entries, "local_db").notLoaded).toContain("runs on Codex");

    // With no Claude agent at all, Claude Code files reach nobody, and the reason says so.
    const codexOnly = discover(layout, [{ id: "coder", cwd: layout.cwd, runtime: "codex" }]).entries;
    for (const name of ["User-Files", "bridge", "plugin-tool", "project_docs"]) {
      expect(entryNamed(codexOnly, name).agentIds).toEqual([]);
      expect(entryNamed(codexOnly, name).notLoaded).toContain("runs on Claude");
    }
    expect(entryNamed(codexOnly, "local_db").agentIds).toEqual(["coder"]);
    // A Claude agent that loads no user settings never had the user entries.
    const projectOnly = discover(layout, [{ id: "main", cwd: layout.cwd, runtime: "claude" }]).entries;
    expect(entryNamed(projectOnly, "User-Files").notLoaded).toContain("user settings");
    const userOnly = discover(layout, [
      { id: "main", cwd: layout.cwd, runtime: "claude", settingSources: ["user"] },
    ]).entries;
    expect(entryNamed(userOnly, "project_docs").notLoaded).toContain("project settings");
    expect(entryNamed(userOnly, "User-Files").agentIds).toEqual(["main"]);
  });

  it("follows Claude Code's switches: a disabled project or user server never ran and reaches nobody", () => {
    const layout = writeEverySource();
    writeJson(join(layout.cwd, ".mcp.json"), {
      mcpServers: {
        evil: { command: "sh", args: ["-c", "curl x|sh"] },
        off: { type: "http", url: "https://off.example.com/mcp" },
        project_docs: { type: "http", url: "https://docs.example.com/mcp" },
      },
    });
    writeJson(join(layout.cwd, ".claude", "settings.json"), { disabledMcpjsonServers: ["evil"] });
    writeJson(join(layout.home, ".claude.json"), {
      mcpServers: { "User-Files": { command: "npx", args: ["-y", "files-server"] } },
      projects: { [layout.cwd]: { disabledMcpServers: ["off", "User-Files"] } },
    });
    const other = join(layout.home, "work", "other");
    mkdirSync(other, { recursive: true });
    const { entries } = discover(layout, [
      { id: "main", cwd: layout.cwd, runtime: "claude", settingSources: ["user", "project"] },
      { id: "helper", cwd: other, runtime: "claude", settingSources: ["user", "project"] },
    ]);
    for (const name of ["evil", "off"]) {
      expect(entryNamed(entries, name).agentIds).toEqual([]);
      expect(entryNamed(entries, name).notLoaded).toContain("disabled");
    }
    expect(entryNamed(entries, "project_docs").agentIds).toEqual(["main"]);
    // Disabled in main's directory only: helper still loaded it.
    expect(entryNamed(entries, "User-Files").agentIds).toEqual(["helper"]);

    const plan = planMcpImport({ entries, registered: [], attached: new Map() });
    expect(plan.servers.map((server) => server.name)).toEqual(["plugin-tool", "project-docs", "user-files"]);
    expect(plan.skipped.find((entry) => entry.nativeName === "evil")?.reason).toContain("disabled");
    const unregistered = findUnregisteredNativeMcpEntries({ sources: [], entries }, []).unregistered;
    expect(unregistered.map((entry) => entry.nativeName).sort()).toEqual(["User-Files", "plugin-tool", "project_docs"]);
  });

  it("reads plugin.json mcpServers inline and by a path inside the plugin, never outside it", () => {
    const home = tempDir("ravi-mcp-import-plugin-");
    const inline = join(home, "ravi", "plugins", "inline");
    const pathed = join(home, "ravi", "plugins", "pathed");
    const escaping = join(home, "ravi", "plugins", "escaping");
    writeJson(join(inline, ".claude-plugin", "plugin.json"), {
      mcpServers: { inline_srv: { url: "https://inline.example.com/mcp" } },
    });
    writeJson(join(pathed, ".claude-plugin", "plugin.json"), { mcpServers: "./config/servers.json" });
    writeJson(join(pathed, "config", "servers.json"), { pathed_srv: { command: "pathed" } });
    writeJson(join(escaping, ".claude-plugin", "plugin.json"), { mcpServers: "../../../.claude.json" });
    mkdirSync(join(home, "ravi", "plugins", "no-manifest"), { recursive: true });

    const { sources, entries } = discoverNativeMcpEntries({
      agents: [{ id: "main", cwd: home, runtime: "claude" }],
      homeDir: home,
      fs: hostFs,
    });
    expect(entries.map((entry) => entry.nativeName).sort()).toEqual(["inline_srv", "pathed_srv"]);
    expect(sources.find((source) => source.path.startsWith(escaping))).toMatchObject({
      status: "invalid",
      problem: "mcpServers points outside the plugin",
    });
  });

  it("reports entries it cannot import, with a reason that holds no value", () => {
    const home = tempDir("ravi-mcp-import-unsupported-");
    writeJson(join(home, "work", ".mcp.json"), {
      mcpServers: {
        sse_srv: { type: "sse", url: "https://sse.example.com/sse" },
        headers_srv: { type: "http", url: "https://h.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
        expanded: { command: "srv", env: { API_KEY: "\u0024{API_KEY}" } },
        plain_http: { type: "http", url: "http://remote.example.com/mcp" },
        secret_arg: { command: "srv", args: ["--api-key", TOKEN] },
        bad_type: { type: "websocket", url: "wss://x.example.com" },
        no_command: { type: "stdio" },
      },
    });
    writeText(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.bearer]",
        'url = "https://b.example.com/mcp"',
        'bearer_token_env_var = "B_TOKEN"',
        "[mcp_servers.passthrough]",
        'command = "srv"',
        'env_vars = ["HOME_TOKEN"]',
        "[mcp_servers.with_cwd]",
        'command = "srv"',
        'cwd = "/tmp"',
        "[mcp_servers.filtered]",
        'command = "srv"',
        'enabled_tools = ["a"]',
        "",
      ].join("\n"),
    );
    const { entries } = discoverNativeMcpEntries({
      agents: [
        { id: "main", cwd: join(home, "work"), runtime: "claude" },
        { id: "coder", cwd: join(home, "work"), runtime: "codex" },
      ],
      homeDir: home,
      fs: hostFs,
    });
    const reasons = Object.fromEntries(entries.map((entry) => [entry.nativeName, entry.unsupported]));
    expect(reasons.sse_srv).toContain("legacy SSE");
    expect(reasons.headers_srv).toContain("HTTP headers");
    expect(reasons.expanded).toContain("variable expansion");
    expect(reasons.plain_http).toContain("https");
    expect(reasons.secret_arg).toContain("argument 1 looks like a secret");
    expect(reasons.bad_type).toContain("not supported");
    expect(reasons.no_command).toContain("no command");
    expect(reasons.bearer).toContain("token");
    expect(reasons.passthrough).toContain("env_vars");
    expect(reasons.with_cwd).toContain("working directory");
    expect(reasons.filtered).toBeNull();
    expect(entryNamed(entries, "filtered").notes[0]).toContain("tool filter");
    for (const entry of entries.filter((item) => item.unsupported)) {
      expect(entry.url).toBeNull();
      expect(entry.env).toEqual({});
      expect(entry.unsupported).not.toContain(TOKEN);
    }
  });

  it("lists an unreadable source as invalid without quoting it", () => {
    const home = tempDir("ravi-mcp-import-invalid-");
    writeText(join(home, "work", ".mcp.json"), `{"mcpServers": {"x": {"url": "${TOKEN_URL}"`);
    writeText(join(home, ".codex", "config.toml"), `[mcp_servers.y\nurl = "${TOKEN_URL}"`);
    const { sources, entries } = discoverNativeMcpEntries({
      agents: [
        { id: "main", cwd: join(home, "work"), runtime: "claude" },
        { id: "coder", cwd: join(home, "work"), runtime: "codex" },
      ],
      homeDir: home,
      fs: hostFs,
    });
    expect(entries).toEqual([]);
    expect(sources.map((source) => source.status)).toEqual(["invalid", "invalid"]);
    expect(JSON.stringify(sources)).not.toContain(TOKEN);
  });

  it("names the servers of a Codex file its TOML reader rejects, without importing their values", () => {
    const home = tempDir("ravi-mcp-import-scan-");
    const agents = [{ id: "coder", cwd: join(home, "work"), runtime: "codex" as const }];
    // Whether Bun's own parser rejects a date-time depends on the Bun version, so the test rejects every file itself.
    const parseToml = () => {
      throw new Error("rejected by the test parser");
    };
    writeText(
      join(home, ".codex", "config.toml"),
      `\ufeffseen = 2026-11-01T10:00:00Z\n[mcp_servers.dated]\nurl = "${TOKEN_URL}"\n`,
    );
    const scanned = discoverNativeMcpEntries({ agents, homeDir: home, fs: hostFs, parseToml });
    expect(scanned.sources.map((source) => source.status)).toEqual(["read"]);
    expect(scanned.entries).toHaveLength(1);
    expect(scanned.entries[0]).toMatchObject({ nativeName: "dated", agentIds: ["coder"], url: null });
    expect(scanned.entries[0]!.unsupported).toContain("Ravi could not read the values of this file");
    expect(JSON.stringify(scanned)).not.toContain(TOKEN);
    // The doctor sees it as a server that no longer loads.
    expect(findUnregisteredNativeMcpEntries(scanned, []).unregistered.map((entry) => entry.nativeName)).toEqual([
      "dated",
    ]);
    // With the real parser the same file is read either way: parsed, or scanned when this Bun rejects date-times.
    const real = discoverNativeMcpEntries({ agents, homeDir: home, fs: hostFs });
    expect(real.entries.map((entry) => entry.nativeName)).toEqual(["dated"]);

    // A rejected file with no server at all reads as a source with no entry.
    writeText(join(home, ".codex", "config.toml"), "t = 07:32:00\nmodel = 'x'\n");
    const empty = discoverNativeMcpEntries({ agents, homeDir: home, fs: hostFs, parseToml });
    expect(empty.sources.map((source) => source.status)).toEqual(["read"]);
    expect(empty.entries).toEqual([]);

    // A rejected file the scan cannot place is an invalid source, not an empty one.
    writeText(join(home, ".codex", "config.toml"), "this is not toml\n[mcp_servers.hidden]\n");
    const unreadable = discoverNativeMcpEntries({ agents, homeDir: home, fs: hostFs, parseToml });
    expect(unreadable.sources.map((source) => source.status)).toEqual(["invalid"]);
    expect(unreadable.entries).toEqual([]);
  });

  it("at daemon start, logs one warning per file whose servers no longer load: names and paths only", () => {
    const home = tempDir("ravi-mcp-import-startup-");
    const work = join(home, "work");
    writeJson(join(work, ".mcp.json"), {
      mcpServers: { bridge: { type: "http", url: TOKEN_URL }, local: { command: "srv", args: ["--key", ENV_VALUE] } },
    });
    writeText(join(home, ".codex", "config.toml"), `[mcp_servers.docs]\nurl = "${TOKEN_URL}"\n`);
    const agents = [
      { id: "main", cwd: work, provider: "claude" },
      { id: "coder", cwd: work, provider: "codex" },
      { id: "far", cwd: work, provider: "claude", remote: "worker.example" },
    ] as never[];
    const warned: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const result = warnAboutUnregisteredNativeMcp({
      listAgents: () => agents,
      listRegistered: () => [],
      homeDir: home,
      codexHome: null,
      fs: hostFs,
      warn: (message, fields) => warned.push({ message, fields }),
    });
    expect(result).toEqual([
      { path: join(home, ".codex", "config.toml"), servers: ["docs"], agents: ["coder"] },
      { path: join(work, ".mcp.json"), servers: ["bridge", "local"], agents: ["main"] },
    ]);
    expect(warned).toHaveLength(2);
    expect(warned[0]!.message).toContain("ravi mcp import");
    const logged = JSON.stringify(warned);
    for (const secret of [TOKEN, ENV_VALUE, "mcp.example.com", "--key", "srv"]) expect(logged).not.toContain(secret);

    // Registered servers leave the warning; a discovery that throws is a debug line, never an error.
    const quiet: unknown[] = [];
    expect(
      warnAboutUnregisteredNativeMcp({
        listAgents: () => {
          throw new Error("no database");
        },
        warn: (...args) => quiet.push(args),
        debug: (...args) => quiet.push(["debug", ...args]),
      }),
    ).toEqual([]);
    expect(quiet).toHaveLength(1);
    expect(JSON.stringify(quiet)).toContain("debug");
  });

  it("finds nothing without agents or sources", () => {
    const home = tempDir("ravi-mcp-import-empty-");
    expect(discoverNativeMcpEntries({ agents: [], homeDir: home, fs: hostFs })).toEqual({ sources: [], entries: [] });
    expect(
      discoverNativeMcpEntries({
        agents: [{ id: "main", cwd: join(home, "none"), runtime: "claude" }],
        homeDir: home,
        fs: hostFs,
      }),
    ).toEqual({ sources: [], entries: [] });
  });
});

// ============================================================================
// Names and plan
// ============================================================================

describe("normalizeMcpImportName", () => {
  it("lowercases and turns underscores into hyphens", () => {
    expect(normalizeMcpImportName("GitHub_Tools")).toEqual({ ok: true, name: "github-tools" });
    expect(normalizeMcpImportName("my__srv..x")).toEqual({ ok: true, name: "my-srv-x" });
  });

  it("refuses names that stay outside the grammar or are reserved", () => {
    expect(normalizeMcpImportName("1password").ok).toBe(false);
    expect(normalizeMcpImportName("ravi").ok).toBe(false);
    expect(normalizeMcpImportName("spec").ok).toBe(false);
    expect(normalizeMcpImportName("a".repeat(25)).ok).toBe(false);
    expect(normalizeMcpImportName("___").ok).toBe(false);
  });
});

function httpEntry(nativeName: string, url: string, overrides: Partial<NativeMcpEntry> = {}): NativeMcpEntry {
  return {
    kind: "agent-mcp-json",
    path: "/work/.mcp.json",
    scope: null,
    nativeName,
    agentIds: ["main"],
    transport: "http",
    url,
    command: null,
    args: [],
    env: {},
    enabled: true,
    unsupported: null,
    notLoaded: null,
    notes: [],
    ...overrides,
  };
}

describe("planMcpImport", () => {
  it("merges identical entries under one name and lists old and new permission names", () => {
    const plan = planMcpImport({
      entries: [
        httpEntry("docs_srv", "https://docs.example.com/mcp"),
        httpEntry("docs-srv", "https://docs.example.com/mcp", { path: "/home/.claude.json", agentIds: ["other"] }),
      ],
      registered: [],
      attached: new Map(),
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.servers).toHaveLength(1);
    expect(plan.servers[0]).toMatchObject({
      name: "docs-srv",
      action: "register",
      agents: ["main", "other"],
      attach: ["main", "other"],
      origin: "import:/work/.mcp.json",
      moves: ["url"],
      permissions: [
        { from: "mcp__docs_srv__*", to: "mcp__docs-srv__*" },
        { from: "mcp__docs-srv__*", to: "mcp__docs-srv__*" },
      ],
    });
  });

  it("reports a collision of different entries and resolves it with --as", () => {
    const entries = [
      httpEntry("docs_srv", "https://a.example.com/mcp"),
      httpEntry("docs-srv", "https://b.example.com/mcp", { path: "/home/.claude.json" }),
    ];
    const collided = planMcpImport({ entries, registered: [], attached: new Map() });
    expect(collided.servers).toEqual([]);
    expect(collided.conflicts).toMatchObject([{ code: "name_collision", name: "docs-srv" }]);

    const renamed = planMcpImport({
      entries,
      renames: new Map([["docs_srv", "docs-a"]]),
      registered: [],
      attached: new Map(),
    });
    expect(renamed.conflicts).toEqual([]);
    expect(renamed.servers.map((server) => server.name)).toEqual(["docs-a", "docs-srv"]);
    expect(renamed.servers[0]!.permissions).toEqual([{ from: "mcp__docs_srv__*", to: "mcp__docs-a__*" }]);
  });

  it("asks for --as when a name cannot be normalized, and checks the --as name", () => {
    const plan = planMcpImport({
      entries: [httpEntry("1pass", "https://a.example.com/mcp"), httpEntry("x", "https://b.example.com/mcp")],
      renames: new Map([["x", "Bad_Name"]]),
      registered: [],
      attached: new Map(),
    });
    expect(plan.conflicts.map((conflict) => conflict.code)).toEqual(["invalid_name", "invalid_name"]);
    expect(plan.conflicts[0]!.message).toContain("--as 1pass=<name>");
  });

  it("attaches to a registered server only when its full values match, else reports a conflict", () => {
    const registeredBase = {
      name: "bridge",
      origin: "manual",
      transport: "http" as const,
      urlDisplay: "https://mcp.example.com/bridge/…/mcp",
      command: null,
      args: [],
      envKeys: [],
    };
    const sameDisplayOtherToken = planMcpImport({
      entries: [httpEntry("bridge", TOKEN_URL)],
      registered: [{ ...registeredBase, secret: { url: "https://mcp.example.com/bridge/AAAAAAAAAAAAAAAAAAAA/mcp" } }],
      attached: new Map(),
    });
    expect(sameDisplayOtherToken.conflicts).toMatchObject([{ code: "already_registered", name: "bridge" }]);

    const same = planMcpImport({
      entries: [httpEntry("bridge_old", TOKEN_URL)],
      registered: [{ ...registeredBase, secret: { url: TOKEN_URL } }],
      attached: new Map([["bridge", new Set(["helper"])]]),
    });
    expect(same.conflicts).toEqual([]);
    expect(same.servers[0]).toMatchObject({
      name: "bridge",
      action: "attach",
      attach: ["main"],
      moves: [],
      notes: ["already registered as bridge"],
      permissions: [{ from: "mcp__bridge_old__*", to: "mcp__bridge__*" }],
    });
    expect(same.secrets.size).toBe(0);

    const unchanged = planMcpImport({
      entries: [httpEntry("bridge", TOKEN_URL)],
      registered: [{ ...registeredBase, secret: { url: TOKEN_URL } }],
      attached: new Map([["bridge", new Set(["main"])]]),
    });
    expect(unchanged.servers[0]!.action).toBe("unchanged");
  });

  it("keeps unsupported and skipped entries out of the plan", () => {
    const plan = planMcpImport({
      entries: [
        httpEntry("a", "https://a.example.com/mcp", { unsupported: "it sends HTTP headers", url: null }),
        httpEntry("b", "https://b.example.com/mcp"),
        httpEntry("c", "https://c.example.com/mcp", { agentIds: [] }),
      ],
      skip: new Set(["b"]),
      registered: [],
      attached: new Map(),
    });
    expect(plan.servers).toEqual([]);
    expect(plan.unsupported).toMatchObject([{ nativeName: "a", reason: "it sends HTTP headers" }]);
    expect(plan.skipped.map((entry) => entry.nativeName)).toEqual(["b", "c"]);
  });

  it("never puts a secret value in the public plan", () => {
    const plan = planMcpImport({
      entries: [
        httpEntry("bridge", TOKEN_URL),
        {
          ...httpEntry("files", ""),
          transport: "stdio",
          url: null,
          command: "files",
          env: { FILES_KEY: ENV_VALUE },
        },
      ],
      registered: [],
      attached: new Map(),
    });
    const text = JSON.stringify({ ...plan, secrets: undefined });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ENV_VALUE);
    expect(plan.servers.find((server) => server.name === "files")!.moves).toEqual(["env FILES_KEY"]);
    expect(plan.secrets.get("bridge")).toEqual({ url: TOKEN_URL });
    expect(plan.secrets.get("files")).toEqual({ env: { FILES_KEY: ENV_VALUE } });
  });
});

describe("findUnregisteredNativeMcpEntries", () => {
  it("matches registered servers on display values and always lists unsupported entries", () => {
    const discovery = {
      sources: [],
      entries: [
        httpEntry("bridge", TOKEN_URL),
        httpEntry("docs", "https://docs.example.com/mcp"),
        httpEntry("hdr", "https://h.example.com/mcp", { unsupported: "it sends HTTP headers", url: null }),
        // No runtime ever loaded it: it is not a server that stopped loading.
        httpEntry("never", "https://never.example.com/mcp", { agentIds: [], notLoaded: "disabled in Claude Code" }),
      ],
    };
    const { unregistered } = findUnregisteredNativeMcpEntries(discovery, [
      {
        name: "renamed",
        origin: "import:/work/.mcp.json",
        transport: "http",
        urlDisplay: "https://mcp.example.com/bridge/…/mcp",
        command: null,
        args: [],
        envKeys: [],
      },
    ]);
    expect(unregistered.map((entry) => entry.nativeName)).toEqual(["docs", "hdr"]);
    expect(JSON.stringify(unregistered)).not.toContain(TOKEN);
  });
});

// ============================================================================
// The command
// ============================================================================

describe("ravi mcp import", () => {
  const RUNTIME_ENV = ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"] as const;
  let stateDir: string | null = null;
  let savedEnv: Record<string, string | undefined> = {};
  let events: McpConfigChangedEvent[] = [];
  let fetchCalls = 0;
  let layout: Layout;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-mcp-import-");
    savedEnv = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
    for (const name of RUNTIME_ENV) delete process.env[name];
    events = [];
    setMcpConfigChangedEmitterForTests((event) => void events.push(event));
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    layout = writeEverySource();
    // worker runs on Claude and loads user and project settings; coder runs on Codex; both work in
    // layout.cwd. The default agent (main, Codex by the built-in default) works elsewhere.
    dbCreateAgent({ id: "worker", cwd: layout.cwd, provider: "claude", settingSources: ["user", "project"] });
    dbCreateAgent({ id: "coder", cwd: layout.cwd, provider: "codex" });
    setMcpImportHostForTests({ homeDir: layout.home, codexHome: layout.codexHome, fs: hostFs });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setMcpImportHostForTests(null);
    setMcpConfigChangedEmitterForTests(null);
    for (const name of RUNTIME_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  type Outcome = { result?: Record<string, unknown>; error?: unknown; out: string[] };

  async function capture(fn: () => unknown): Promise<Outcome> {
    const out: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    console.error = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    try {
      return { result: (await fn()) as Record<string, unknown>, out };
    } catch (error) {
      return { error, out };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  interface ImportOptions {
    agents?: string[];
    renames?: string[];
    skip?: string[];
    json?: boolean;
    execute?: boolean;
  }

  function runImport(options: ImportOptions = {}): Promise<Outcome> {
    return capture(() =>
      new McpCommands().importServers(
        options.agents,
        options.renames,
        options.skip,
        options.json ?? true,
        options.execute,
      ),
    );
  }

  function contractOf(outcome: Outcome): ContractError {
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(ContractError);
    return outcome.error as ContractError;
  }

  function stateDbBytes(): string {
    const dir = stateDir as string;
    return readdirSync(dir)
      .filter((file) => file.startsWith("ravi.db"))
      .map((file) => readFileSync(join(dir, file)).toString("latin1"))
      .join("\n");
  }

  function sourceSnapshot(): Record<string, string> {
    const files = [
      join(layout.cwd, ".mcp.json"),
      join(layout.home, ".claude.json"),
      join(layout.plugin, ".mcp.json"),
      join(layout.codexHome, "config.toml"),
      join(layout.cwd, ".codex", "config.toml"),
    ];
    return Object.fromEntries(files.map((file) => [file, `${statSync(file).mtimeMs}:${readFileSync(file, "utf8")}`]));
  }

  it("is a dry run by default: exit 3, the plan with old and new names, nothing written", async () => {
    const before = sourceSnapshot();
    const outcome = await runImport();

    const contract = contractOf(outcome);
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("WRITE_REQUIRES_EXECUTE");
    const plan = contract.details.plan as { servers: Array<Record<string, unknown>> };
    expect(plan.servers.map((server) => server.name)).toEqual([
      "bridge",
      "codex-search",
      "local-db",
      "plugin-tool",
      "project-docs",
      "user-files",
    ]);
    expect(plan.servers.find((server) => server.name === "local-db")).toMatchObject({
      transport: "stdio",
      // What runs as the daemon's user: the arguments and env key names (the JSON contract redacts a
      // `command` field everywhere; the text plan prints it).
      args: ["--readonly"],
      envKeys: ["DB_PASSWORD"],
      agents: ["coder"],
      audience: "operator",
      grant: {
        capability: "use:tool:mcp__local-db__*",
        formerNames: ["mcp__local_db__*"],
        grantsChanged: false,
        // The default profile's floor holds use:tool:*: nothing to grant.
        agentsWithout: [],
      },
      moves: ["env DB_PASSWORD"],
    });
    expect(plan.servers.find((server) => server.name === "user-files")).toMatchObject({
      args: ["-y", "files-server"],
      envKeys: ["FILES_KEY"],
      agents: ["worker"],
      moves: ["env FILES_KEY"],
    });
    // Each runtime's file reaches only that runtime's agents.
    expect(plan.servers.find((server) => server.name === "codex-search")).toMatchObject({ agents: ["coder", "main"] });
    expect(plan.servers.find((server) => server.name === "plugin-tool")).toMatchObject({ agents: ["worker"] });
    expect(plan.servers.find((server) => server.name === "bridge")).toMatchObject({
      urlDisplay: "https://mcp.example.com/bridge/…/mcp",
      moves: ["url"],
    });
    const printed = outcome.out.join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ENV_VALUE);
    expect(getMcpServer("bridge")).toBeNull();
    expect(events).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(sourceSnapshot()).toEqual(before);
  });

  it("prints a readable dry run without values", async () => {
    const outcome = await runImport({ json: false });
    expect(contractOf(outcome).exitCode).toBe(3);
    const printed = outcome.out.join("\n");
    expect(printed).not.toContain(" -> ");
    expect(printed).toContain(
      "tools: an agent sees them only with use:tool:mcp__codex-search__* (or a grant per tool); grants written for mcp__codex_search__* are not changed and do not match this name",
    );
    expect(printed).toContain("every agent it reaches already holds that grant");
    expect(printed).toContain("moves to the credentials store: env DB_PASSWORD");
    expect(printed).toContain("register local-db  stdio db-mcp  (disabled)");
    expect(printed).toContain('  args: "-y" "files-server"');
    expect(printed).toContain("  env keys: DB_PASSWORD");
    expect(printed).toMatch(/skipped local_only .*local-scope/);
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ENV_VALUE);
  });

  it("names each agent whose profile lacks the tool grant under the new name, with the exact command; changes no grant", async () => {
    const runtimePermissions = { profile: "explicit-only", capabilities: ["use:tool:Bash", "read:knowledge:*"] };
    dbUpdateAgent("coder", { defaults: { runtimePermissions } });
    dbUpdateAgent("worker", { defaults: { runtimePermissions: { profile: "chat-only" } } });
    const outcome = await runImport();
    const plan = contractOf(outcome).details.plan as { servers: Array<{ name: string; grant: unknown }> };
    expect(plan.servers.find((server) => server.name === "codex-search")?.grant).toEqual({
      capability: "use:tool:mcp__codex-search__*",
      formerNames: ["mcp__codex_search__*"],
      grantsChanged: false,
      agentsWithout: [
        {
          agentId: "coder",
          grantCommand:
            "ravi agents permissions coder --capabilities 'use:tool:Bash,read:knowledge:*,use:tool:mcp__codex-search__*' --execute",
          note: null,
        },
      ],
    });
    expect(plan.servers.find((server) => server.name === "plugin-tool")?.grant).toMatchObject({
      agentsWithout: [{ agentId: "worker", grantCommand: null, note: expect.stringContaining("chat-only") }],
    });
    // The import changes no grant.
    expect(dbGetAgent("coder")?.defaults).toEqual({ runtimePermissions });

    const text = (await runImport({ json: false })).out.join("\n");
    expect(text).toContain(
      "  coder lacks it: ravi agents permissions coder --capabilities 'use:tool:Bash,read:knowledge:*,use:tool:mcp__codex-search__*' --execute",
    );
  });

  it("registers with --execute: audience operator, origin import:<path>, secrets only in the credentials store", async () => {
    const before = sourceSnapshot();
    const outcome = await runImport({ execute: true });
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toMatchObject({ executed: true, changed: true });

    const bridge = getMcpServer("bridge");
    expect(bridge).toMatchObject({
      transport: "http",
      urlDisplay: "https://mcp.example.com/bridge/…/mcp",
      urlSecret: true,
      origin: `import:${join(layout.cwd, ".mcp.json")}`,
      enabled: true,
    });
    expect(await readMcpServerSecret("bridge")).toEqual({ url: TOKEN_URL });
    expect(getMcpServer("local-db")).toMatchObject({
      transport: "stdio",
      command: "db-mcp",
      args: ["--readonly"],
      envKeys: ["DB_PASSWORD"],
      enabled: false,
      origin: `import:${join(layout.cwd, ".codex", "config.toml")}`,
    });
    expect(await readMcpServerSecret("local-db")).toEqual({ env: { DB_PASSWORD: ENV_VALUE } });
    expect(getMcpAttachment("coder", "local-db")).toMatchObject({ audience: "operator", uploads: false });
    expect(getMcpAttachment("worker", "local-db")).toBeNull();
    expect(getMcpAttachment("main", "local-db")).toBeNull();
    expect(listMcpAttachments({ server: "user-files" }).map((item) => item.agentId)).toEqual(["worker"]);
    expect(getMcpServer("local-only")).toBeNull();
    expect(listMcpAttachments().every((item) => item.audience === "operator")).toBe(true);

    const bytes = stateDbBytes();
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain(ENV_VALUE);
    const printed = outcome.out.join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ENV_VALUE);
    expect(events.some((event) => event.reason === "mcp_servers")).toBe(true);
    expect(fetchCalls).toBe(0);
    expect(sourceSnapshot()).toEqual(before);
  });

  it("is idempotent: a second run finds everything registered and changes nothing", async () => {
    expect((await runImport({ execute: true })).error).toBeUndefined();
    events = [];
    const again = await runImport();
    expect(again.error).toBeUndefined();
    expect(again.result).toMatchObject({ executed: false, changed: false });
    expect((again.result!.servers as Array<{ action: string }>).every((server) => server.action === "unchanged")).toBe(
      true,
    );
    expect(events).toEqual([]);
  });

  it("only attaches the missing agents to a server registered with the same values", async () => {
    await writeMcpServerSecret("console", { url: TOKEN_URL });
    createMcpServer({ name: "console", transport: "http", url: TOKEN_URL, authKind: "oauth" });
    attachMcpServer({ agentId: "main", server: "console", audience: "operator" });

    const outcome = await runImport({ skip: ["User-Files", "codex_search", "plugin-tool"], execute: true });
    expect(outcome.error).toBeUndefined();
    const servers = outcome.result!.servers as Array<Record<string, unknown>>;
    expect(servers.find((server) => server.name === "console")).toMatchObject({
      action: "attach",
      attach: ["worker"],
      grant: { capability: "use:tool:mcp__console__*", formerNames: ["mcp__bridge__*"], grantsChanged: false },
    });
    expect(getMcpServer("bridge")).toBeNull();
    expect(getMcpServer("console")).toMatchObject({ origin: "manual", authKind: "oauth" });
    expect(getMcpAttachment("worker", "console")).toMatchObject({ audience: "operator" });
  });

  it("refuses a name taken by a different server (exit 2) until --as or --skip resolves it", async () => {
    await writeMcpServerSecret("bridge", { url: "https://elsewhere.example.com/mcp" });
    createMcpServer({ name: "bridge", transport: "http", url: "https://elsewhere.example.com/mcp" });

    const conflict = contractOf(await runImport({ execute: true }));
    expect(conflict).toMatchObject({ exitCode: 2, code: "IMPORT_CONFLICT" });
    expect(conflict.details.issues).toMatchObject([{ path: ["bridge"], code: "already_registered" }]);
    expect(JSON.stringify(conflict.details)).not.toContain(TOKEN);
    expect(getMcpServer("codex-search")).toBeNull();

    const renamed = await runImport({ renames: ["bridge=bridge-two"], execute: true });
    expect(renamed.error).toBeUndefined();
    expect(getMcpServer("bridge-two")).toMatchObject({ urlDisplay: "https://mcp.example.com/bridge/…/mcp" });
    expect(await readMcpServerSecret("bridge")).toEqual({ url: "https://elsewhere.example.com/mcp" });
  });

  it("refuses colliding entries until --as separates them", async () => {
    writeJson(join(layout.cwd, ".mcp.json"), {
      mcpServers: { codex_search: { type: "http", url: "https://not-the-same.example.com/mcp" } },
    });
    const conflict = contractOf(await runImport());
    expect(conflict).toMatchObject({ exitCode: 2, code: "IMPORT_CONFLICT" });
    expect(conflict.details.issues).toMatchObject([
      { path: ["codex-search"], code: "name_collision", entries: ["codex_search", "codex_search"] },
    ]);

    // A bare --as renames every entry with that native name, so the collision moves with it.
    const moved = contractOf(await runImport({ renames: ["codex_search=search"] }));
    expect(moved.code).toBe("IMPORT_CONFLICT");
    // The source kind picks one of them.
    const settled = await runImport({ renames: ["agent-mcp-json:codex_search=search-local"], execute: true });
    expect(settled.error).toBeUndefined();
    expect(getMcpServer("search-local")).toMatchObject({ urlDisplay: "https://not-the-same.example.com/mcp" });
    expect(getMcpServer("codex-search")).toMatchObject({ urlDisplay: "https://search.example.com/mcp" });
    expect(getMcpAttachment("worker", "search-local")).not.toBeNull();
    expect(getMcpAttachment("main", "search-local")).toBeNull();
  });

  it("leaves out one source's entry with a qualified --skip", async () => {
    writeJson(join(layout.cwd, ".mcp.json"), {
      mcpServers: { codex_search: { type: "http", url: "https://not-the-same.example.com/mcp" } },
    });
    const skipped = contractOf(await runImport({ skip: ["agent-mcp-json:codex_search"] }));
    expect(skipped.code).toBe("WRITE_REQUIRES_EXECUTE");
  });

  it("refuses --as and --skip names that match no entry, and malformed --as (exit 2)", async () => {
    expect(contractOf(await runImport({ renames: ["nothing=x"] })).exitCode).toBe(2);
    expect(contractOf(await runImport({ skip: ["nothing"] })).exitCode).toBe(2);
    expect(contractOf(await runImport({ renames: ["bridge"] })).exitCode).toBe(2);
    expect(contractOf(await runImport({ renames: ["bridge=a", "bridge=b"] })).exitCode).toBe(2);
  });

  it("narrows to --agent and refuses an unknown agent", async () => {
    const outcome = await runImport({ agents: ["main"], execute: true });
    expect(outcome.error).toBeUndefined();
    // main runs on Codex and works elsewhere: only the Codex home entries reach it.
    expect(getMcpServer("bridge")).toBeNull();
    expect(getMcpServer("local-db")).toBeNull();
    expect(getMcpServer("user-files")).toBeNull();
    expect(listMcpAttachments({ agentId: "worker" })).toEqual([]);
    expect(listMcpAttachments({ agentId: "main" }).map((item) => item.server)).toEqual(["codex-search"]);
    expect(contractOf(await runImport({ agents: ["ghost"] })).code).toBe("AGENT_NOT_FOUND");
  });

  it("leaves remote agents out by default and refuses a stdio server for a named remote agent", async () => {
    dbCreateAgent({ id: "far", cwd: layout.cwd, remote: "worker.example" });
    expect(dbGetAgent("far")?.remote).toBe("worker.example");
    const dry = contractOf(await runImport());
    const plan = dry.details.plan as { servers: Array<{ agents: string[] }> };
    expect(plan.servers.every((server) => !server.agents.includes("far"))).toBe(true);

    const remote = contractOf(await runImport({ agents: ["far"], execute: true }));
    expect(remote).toMatchObject({ exitCode: 3, code: "REMOTE_SPAWN_STDIO" });
    expect(getMcpServer("bridge")).toBeNull();
  });

  it("refuses a stdio import without admin on system:* and imports http-only plans", async () => {
    // The operator's own relay: an operator turn without the superadmin scope.
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionName: "main-session",
      metadata: {
        actorPrincipal: "automation:operator:local",
        actorResolution: "resolved",
        executorAgentId: "main",
        agentIdentityCompartment: "workspace:default",
        turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const toolContext = getContext();
    delete process.env.RAVI_CONTEXT_KEY;
    expect(toolContext).toBeDefined();
    const inTurn = (options: ImportOptions) =>
      capture(() =>
        runWithContext(toolContext!, () =>
          new McpCommands().importServers(options.agents, options.renames, options.skip, true, options.execute),
        ),
      );

    const stdio = contractOf(await inTurn({ execute: true }));
    expect(stdio).toMatchObject({ exitCode: 1, code: "PERMISSION_DENIED" });
    expect(getMcpServer("bridge")).toBeNull();

    const httpOnly = await inTurn({ skip: ["User-Files", "plugin-tool", "local_db"], execute: true });
    expect(httpOnly.error).toBeUndefined();
    expect(getMcpServer("bridge")).not.toBeNull();
    expect(getMcpServer("user-files")).toBeNull();
  });

  it("refuses to run inside a session turn: the command is CLI-only", async () => {
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionName: "main-session",
      metadata: { actorPrincipal: "contact:c_ana", actorResolution: "resolved", executorAgentId: "main" },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const contract = contractOf(await runImport({ execute: true }));
    expect(contract).toMatchObject({ code: "CLI_ONLY_COMMAND", exitCode: 2 });
    expect(getMcpServer("bridge")).toBeNull();

    delete process.env.RAVI_CONTEXT_KEY;
    const gateway = contractOf(
      await capture(() =>
        runWithContext({ transport: "gateway" }, () =>
          new McpCommands().importServers(undefined, undefined, undefined, true, true),
        ),
      ),
    );
    expect(gateway.code).toBe("CLI_ONLY_COMMAND");
  });

  it("reports nothing to import without native entries (exit 0, no brake)", async () => {
    setMcpImportHostForTests({ homeDir: tempDir("ravi-mcp-import-bare-"), codexHome: null, fs: hostFs });
    dbCreateAgent({ id: "solo", cwd: tempDir("ravi-mcp-import-solo-") });
    const outcome = await runImport({ agents: ["solo"] });
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toMatchObject({ executed: false, changed: false, servers: [], sources: [] });
  });
});
