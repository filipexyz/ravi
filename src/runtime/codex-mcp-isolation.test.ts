import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAVI_CODEX_BASH_HOOK_MATCHER } from "./codex-hooks.js";
import {
  CODEX_APPS_FEATURE_OVERRIDE,
  CodexMcpIsolationError,
  type CodexTomlParse,
  codexMcpToolCallError,
  codexProjectLayerDirs,
  collectCodexMcpConfigSources,
  isCodexMcpToolCallMessage,
  listActiveCodexMcpServers,
  resolveCodexHomeDir,
  resolveCodexMcpIsolation,
  verifyCodexMcpServersDisabled,
} from "./codex-mcp-isolation.js";

interface Fixture {
  root: string;
  home: string;
  cwd: string;
  system: string;
  managed: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ravi-codex-mcp-iso-"));
  const home = join(root, "codex-home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd, system: join(root, "etc-config.toml"), managed: join(root, "etc-managed.toml") };
}

function resolveFor(fixture: Fixture, cwd = fixture.cwd, parseToml?: CodexTomlParse) {
  return resolveCodexMcpIsolation({
    cwd,
    env: { CODEX_HOME: fixture.home },
    systemConfigPath: fixture.system,
    managedConfigPath: fixture.managed,
    parseToml,
  });
}

/**
 * A parser that rejects every file, so the line scan runs on any Bun version:
 * which valid TOML Bun's own parser rejects (date-times, for example) changes
 * between Bun releases.
 */
const rejectingToml: CodexTomlParse = () => {
  throw new Error("rejected by the test parser");
};

/** Resolves through the line scan (the parser rejects the file). */
function scanFor(fixture: Fixture, cwd = fixture.cwd) {
  return resolveFor(fixture, cwd, rejectingToml);
}

function writeProjectConfig(dir: string, body: string): void {
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "config.toml"), body);
}

function trust(fixture: Fixture, entries: Record<string, "trusted" | "untrusted">, extra = ""): void {
  const tables = Object.entries(entries)
    .map(([path, level]) => `[projects.${JSON.stringify(path)}]\ntrust_level = "${level}"\n`)
    .join("\n");
  writeFileSync(join(fixture.home, "config.toml"), `${extra}\n${tables}`);
}

describe("collectCodexMcpConfigSources", () => {
  it("lists the layers the launch reads, without refusing a key the launch cannot address", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.system, '[mcp_servers."sys.tem"]\ncommand = "a"\n');
    const untrusted = join(fixture.root, "untrusted");
    mkdirSync(untrusted, { recursive: true });
    writeProjectConfig(untrusted, '[mcp_servers."un.trusted"]\ncommand = "b"\n');
    writeProjectConfig(fixture.cwd, '[mcp_servers."pro.ject"]\ncommand = "c"\n');
    trust(fixture, { [fixture.cwd]: "trusted", [untrusted]: "untrusted" });
    const input = {
      env: { CODEX_HOME: fixture.home },
      systemConfigPath: fixture.system,
      managedConfigPath: fixture.managed,
    };
    expect(collectCodexMcpConfigSources({ ...input, cwd: fixture.cwd })).toEqual([
      { layer: "system", path: fixture.system, keys: ["sys.tem"] },
      { layer: "user", path: join(fixture.home, "config.toml"), keys: [] },
      { layer: "project", path: join(realpathSync(fixture.cwd), ".codex", "config.toml"), keys: ["pro.ject"] },
    ]);
    // An untrusted project layer is not loaded by Codex, so it is not listed.
    expect(collectCodexMcpConfigSources({ ...input, cwd: untrusted }).map((source) => source.layer)).toEqual([
      "system",
      "user",
    ]);
    // The launch refuses on the same list.
    expect(() => resolveCodexMcpIsolation({ ...input, cwd: fixture.cwd })).toThrow(CodexMcpIsolationError);
  });
});

describe("resolveCodexMcpIsolation", () => {
  it("turns off every home server and the apps feature, and never relies on mcp_servers={}", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.home, "config.toml"),
      '[mcp_servers.foo]\ncommand = "/bin/false"\n\n[mcp_servers.my-srv_2]\nurl = "http://127.0.0.1:9/mcp"\n',
    );
    const plan = resolveFor(fixture);
    expect(plan.keys).toEqual(["foo", "my-srv_2"]);
    expect(plan.args).toEqual([
      "-c",
      "mcp_servers.foo.enabled=false",
      "-c",
      "mcp_servers.my-srv_2.enabled=false",
      "-c",
      CODEX_APPS_FEATURE_OVERRIDE,
    ]);
    expect(plan.args).not.toContain("mcp_servers={}");
    expect(plan.sources.map((source) => source.layer)).toEqual(["user"]);
  });

  it("still turns the apps feature off when no server is configured", () => {
    const fixture = makeFixture();
    const plan = resolveFor(fixture);
    expect(plan.keys).toEqual([]);
    expect(plan.args).toEqual(["-c", "features.apps=false"]);
  });

  it("adds the keys of the system and managed layers and dedupes them", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.system, '[mcp_servers.shared]\ncommand = "a"\n[mcp_servers.sys]\ncommand = "b"\n');
    writeFileSync(fixture.managed, '[mcp_servers.corp]\nurl = "https://corp.example/mcp"\n');
    writeFileSync(join(fixture.home, "config.toml"), '[mcp_servers.shared]\ncommand = "c"\n');
    const plan = resolveFor(fixture);
    expect(plan.keys).toEqual(["corp", "shared", "sys"]);
    expect(plan.sources.map((source) => source.layer)).toEqual(["system", "managed", "user"]);
  });

  it("includes a trusted project's servers", () => {
    const fixture = makeFixture();
    trust(fixture, { [fixture.cwd]: "trusted" }, '[mcp_servers.home]\ncommand = "x"\n');
    writeProjectConfig(fixture.cwd, '[mcp_servers.projonly]\ncommand = "/bin/true"\n');
    const plan = resolveFor(fixture);
    expect(plan.keys).toEqual(["home", "projonly"]);
    expect(plan.sources.at(-1)).toMatchObject({ layer: "project", keys: ["projonly"] });
  });

  it("leaves out an untrusted project's servers, which Codex does not load", () => {
    // Codex refuses to start on an override for a key no loaded layer defines.
    const fixture = makeFixture();
    writeProjectConfig(fixture.cwd, '[mcp_servers.projonly]\ncommand = "/bin/true"\n');
    expect(resolveFor(fixture).keys).toEqual([]);

    trust(fixture, { [fixture.cwd]: "untrusted" });
    expect(resolveFor(fixture).keys).toEqual([]);
  });

  it("layers every trusted folder from the git root down to the cwd", () => {
    const fixture = makeFixture();
    const sub = join(fixture.cwd, "b");
    mkdirSync(join(fixture.cwd, ".git"), { recursive: true });
    writeProjectConfig(fixture.cwd, '[mcp_servers.ina]\ncommand = "x"\n');
    writeProjectConfig(sub, '[mcp_servers.inb]\ncommand = "x"\n');

    trust(fixture, { [fixture.cwd]: "trusted" });
    expect(resolveFor(fixture, sub).keys).toEqual(["ina", "inb"]);

    // A folder's own entry wins over the git root's.
    trust(fixture, { [fixture.cwd]: "trusted", [sub]: "untrusted" });
    expect(resolveFor(fixture, sub).keys).toEqual(["ina"]);

    // Trusting only the subfolder does not load the root's layer.
    trust(fixture, { [sub]: "trusted" });
    expect(resolveFor(fixture, sub).keys).toEqual(["inb"]);
  });

  it("does not inherit trust from an ancestor without a git root", () => {
    const fixture = makeFixture();
    const sub = join(fixture.cwd, "b");
    writeProjectConfig(fixture.cwd, '[mcp_servers.ina]\ncommand = "x"\n');
    writeProjectConfig(sub, '[mcp_servers.inb]\ncommand = "x"\n');
    trust(fixture, { [fixture.cwd]: "trusted" });
    expect(codexProjectLayerDirs(sub).map((dir) => dir.path)).toHaveLength(1);
    expect(resolveFor(fixture, sub).keys).toEqual([]);
  });

  it("fails closed on a key `-c` cannot address, naming it and the file", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.home, "config.toml"),
      '[mcp_servers."my.server"]\ncommand = "x"\n[mcp_servers.ok]\ncommand = "y"\n',
    );
    let caught: unknown;
    try {
      resolveFor(fixture);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexMcpIsolationError);
    const error = caught as CodexMcpIsolationError;
    expect(error.code).toBe("key_not_overridable");
    expect(error.servers).toEqual(["my.server"]);
    expect(error.message).toContain('"my.server"');
    expect(error.message).toContain(join(fixture.home, "config.toml"));
    expect(error.message).toContain("ravi mcp import");
  });

  it("fails closed on quoted keys that need quoting for spaces or quotes", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, "config.toml"), '[mcp_servers."a b"]\ncommand = "x"\n');
    expect(() => resolveFor(fixture)).toThrow(CodexMcpIsolationError);
  });

  it("accepts a quoted key that is a bare key once unquoted", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, "config.toml"), '[mcp_servers."foo"]\ncommand = "x"\n');
    expect(resolveFor(fixture).args).toContain("mcp_servers.foo.enabled=false");
  });

  it("fails closed on a malformed configuration file instead of reading no servers", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, "config.toml"), "[mcp_servers.foo\ncommand = ");
    expect(() => resolveFor(fixture)).toThrow(/Ravi could not read Codex configuration/);
    expect(() => resolveFor(fixture)).not.toThrow(/not valid TOML/);

    writeFileSync(join(fixture.home, "config.toml"), "mcp_servers = 3\n");
    expect(() => resolveFor(fixture)).toThrow(/not a table/);
  });

  it("reads valid TOML that a TOML reader may reject: date-times, local dates and times", () => {
    const values = [
      "1979-05-27T07:32:00Z",
      "1979-05-27T00:32:00.999999-07:00",
      "1979-05-27 07:32:00Z",
      "1979-05-27T07:32:00",
      "1979-05-27",
      "07:32:00",
    ];
    for (const value of values) {
      const fixture = makeFixture();
      // A file with no MCP server at all simply works.
      writeFileSync(join(fixture.home, "config.toml"), `model = "gpt-5"\n[notice]\nlast_seen = ${value}\n`);
      // Through the scan, and through this Bun's parser whether or not it accepts the value.
      expect(scanFor(fixture).keys).toEqual([]);
      expect(resolveFor(fixture).keys).toEqual([]);
      // Servers in the same file are still found and turned off.
      writeFileSync(
        join(fixture.home, "config.toml"),
        `when = ${value}\n[mcp_servers.docs]\ncommand = "/bin/false"\nargs = ["--since", "x"] # ${value}\n`,
      );
      expect(scanFor(fixture).args).toContain("mcp_servers.docs.enabled=false");
      expect(resolveFor(fixture).args).toContain("mcp_servers.docs.enabled=false");
    }
  });

  it("reads a bare value followed by a tab, before a comment or the line's end, when it scans", () => {
    const fixture = makeFixture();
    // Whitespace in TOML is space or tab.
    writeFileSync(join(fixture.home, "config.toml"), "d = 1979-05-27\nx = 1\t# note\ny = true\t\n");
    expect(scanFor(fixture).keys).toEqual([]);
    writeFileSync(
      join(fixture.home, "config.toml"),
      "d = 1979-05-27\t# when\n[mcp_servers.docs]\nstartup_timeout_sec = 10\t\t# note\nenabled = true\t\n",
    );
    expect(scanFor(fixture).args).toContain("mcp_servers.docs.enabled=false");
  });

  it("finds every server shape when it scans: headers, dotted keys, quoted keys, inline tables", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.home, "config.toml"),
      [
        "stamp = 2026-11-01T10:00:00Z",
        'mcp_servers.dotted.command = "/bin/a"',
        'mcp_servers = { inline_a = { command = "/bin/b" }, \'inline-b\' = { url = "http://x" } }',
        "[mcp_servers]",
        'under = { command = "/bin/c", args = [',
        '  "multi", # a comment',
        '  "line",',
        "] }",
        'sub.command = "/bin/d"',
        '[ mcp_servers . "quoted" ]',
        'description = """',
        "[mcp_servers.not_a_server]",
        '"""',
        "[mcp_servers.'literal'.env]",
        'TOKEN = "x"',
        "[[mcp_servers.arrayed.extra]]",
        "n = 1",
      ].join("\n"),
    );
    expect(scanFor(fixture).keys).toEqual([
      "arrayed",
      "dotted",
      "inline-b",
      "inline_a",
      "literal",
      "quoted",
      "sub",
      "under",
    ]);
  });

  it("strips a byte order mark instead of reading an empty file", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.home, "config.toml"), '﻿[mcp_servers.bom]\ncommand = "/bin/false"\n');
    expect(resolveFor(fixture).keys).toEqual(["bom"]);
    writeFileSync(join(fixture.home, "config.toml"), '﻿t = 07:32:00\n[mcp_servers.bom2]\ncommand = "x"\n');
    expect(scanFor(fixture).keys).toEqual(["bom2"]);
    expect(resolveFor(fixture).keys).toEqual(["bom2"]);
  });

  it("keeps a scanned project's trust, and its quoted keys still fail closed", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.home, "config.toml"),
      `seen = 2026-11-01T10:00:00Z\n[projects.${JSON.stringify(fixture.cwd)}]\ntrust_level = "trusted"\n`,
    );
    writeProjectConfig(fixture.cwd, '[mcp_servers.proj]\ncommand = "x"\n');
    expect(scanFor(fixture).keys).toEqual(["proj"]);

    writeFileSync(join(fixture.home, "config.toml"), 'd = 1979-05-27\n[mcp_servers."a.b"]\ncommand = "x"\n');
    expect(() => scanFor(fixture)).toThrow(/cannot be turned off at launch/);
    expect(() => resolveFor(fixture)).toThrow(/cannot be turned off at launch/);
  });

  it("fails closed when the scan cannot place a line, saying Ravi could not read the file", () => {
    const cases = [
      "d = 1979-05-27\nmcp_servers = 3\n",
      "d = 1979-05-27\n[[mcp_servers]]\nname = 1\n",
      "d = 1979-05-27\nthis is not toml\n",
      'd = 1979-05-27\nx = "unterminated\n',
      "d = 1979-05-27\nprojects = { a = 1 }\n",
      'd = 1979-05-27\nx = """never closed\n[mcp_servers.hidden]\n',
    ];
    for (const body of cases) {
      const fixture = makeFixture();
      writeFileSync(join(fixture.home, "config.toml"), body);
      expect(() => scanFor(fixture)).toThrow(/Ravi could not read Codex configuration/);
    }
  });

  it("fails closed on a malformed trusted project file", () => {
    const fixture = makeFixture();
    trust(fixture, { [fixture.cwd]: "trusted" });
    writeProjectConfig(fixture.cwd, "[[[");
    expect(() => resolveFor(fixture)).toThrow(CodexMcpIsolationError);
  });

  it("fails closed on a configuration file that exists but cannot be read", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.home, "config.toml"));
    expect(() => resolveFor(fixture)).toThrow(/could not be read/);

    const unreadable = makeFixture();
    const path = join(unreadable.home, "config.toml");
    writeFileSync(path, '[mcp_servers.foo]\ncommand = "x"\n');
    chmodSync(path, 0o000);
    try {
      // Root without DAC override (the suite runs under setpriv) cannot read it either.
      let readable = true;
      try {
        readFileSync(path);
      } catch {
        readable = false;
      }
      if (!readable) expect(() => resolveFor(unreadable)).toThrow(/could not be read/);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("changes its signature when the configured keys change", () => {
    const fixture = makeFixture();
    const before = resolveFor(fixture).signature;
    writeFileSync(join(fixture.home, "config.toml"), '[mcp_servers.late]\ncommand = "x"\n');
    const after = resolveFor(fixture).signature;
    expect(after).not.toBe(before);
    expect(resolveFor(fixture).signature).toBe(after);
  });

  it("resolves the home from CODEX_HOME, else HOME/.codex", () => {
    expect(resolveCodexHomeDir({ CODEX_HOME: "/x/codex" })).toBe("/x/codex");
    expect(resolveCodexHomeDir({ HOME: "/home/u" })).toBe("/home/u/.codex");
    expect(resolveCodexHomeDir({ CODEX_HOME: "  " }, "/h")).toBe("/h/.codex");
  });

  it("leaves the global Bash hook matcher unchanged", () => {
    expect(RAVI_CODEX_BASH_HOOK_MATCHER).toBe("^(Bash|shell)$");
  });
});

describe("verifyCodexMcpServersDisabled", () => {
  const disabled = (name: string) => ({ name, runtimeStatus: "disabled", tools: [], pluginId: null });

  it("passes on an empty list and asks for the thread", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    await verifyCodexMcpServersDisabled(async (method, params) => {
      calls.push({ method, params });
      return { data: [], nextCursor: null };
    }, "thread_1");
    expect(calls).toEqual([
      { method: "mcpServerStatus/list", params: { threadId: "thread_1", detail: "toolsAndAuthOnly" } },
    ]);
  });

  it("passes when every server is reported disabled", async () => {
    await verifyCodexMcpServersDisabled(
      async () => ({ data: [disabled("foo"), disabled("bar")], nextCursor: null }),
      "t",
    );
  });

  it("aborts on one active server, naming it and ravi mcp import", async () => {
    const promise = verifyCodexMcpServersDisabled(
      async () => ({
        data: [disabled("foo"), { name: "github", runtimeStatus: "connected", tools: { search: {} } }],
        nextCursor: null,
      }),
      "t",
    );
    await expect(promise).rejects.toThrow(/"github"/);
    await expect(promise).rejects.toThrow(/ravi mcp import/);
    await expect(promise).rejects.toMatchObject({ code: "server_active", servers: ["github"] });
  });

  it("counts failed, missing and unknown statuses, and a disabled entry with tools, as active", () => {
    expect(
      listActiveCodexMcpServers([
        { name: "a", runtimeStatus: "failed", tools: [] },
        { name: "b", runtimeStatus: null, tools: [] },
        { name: "c" },
        { name: "d", runtimeStatus: "disabled", tools: { t: {} } },
        { name: "e", runtimeStatus: "disabled", tools: ["t"] },
        { runtimeStatus: "connected" },
        "junk",
        disabled("ok"),
      ]),
    ).toEqual(["a", "b", "c", "d", "e", "(unnamed)", "(unnamed)"]);
  });

  it("follows pages and fails on a server on a later page", async () => {
    const cursors: unknown[] = [];
    const promise = verifyCodexMcpServersDisabled(async (_method, params) => {
      cursors.push(params.cursor);
      return params.cursor
        ? { data: [{ name: "late", runtimeStatus: "starting", tools: [] }], nextCursor: null }
        : { data: [disabled("foo")], nextCursor: "page2" };
    }, "t");
    await expect(promise).rejects.toThrow(/"late"/);
    expect(cursors).toEqual([undefined, "page2"]);
  });

  it("aborts when the call fails, times out or answers without a list", async () => {
    await expect(
      verifyCodexMcpServersDisabled(async () => {
        throw new Error("Method not found");
      }, "t"),
    ).rejects.toMatchObject({ code: "status_failed" });
    await expect(
      verifyCodexMcpServersDisabled(async () => {
        throw new Error("Method not found");
      }, "t"),
    ).rejects.toThrow(/verified on Codex 0\.172\.0.*Update Codex/);
    await expect(verifyCodexMcpServersDisabled(async () => ({}), "t")).rejects.toMatchObject({
      code: "status_failed",
    });
    await expect(verifyCodexMcpServersDisabled(async () => ({ data: [], nextCursor: 5 }), "t")).rejects.toMatchObject({
      code: "status_failed",
    });
    await expect(
      verifyCodexMcpServersDisabled(async () => ({ data: [], nextCursor: "same" }), "t"),
    ).rejects.toMatchObject({ code: "status_failed" });
  });

  it("passes the bounded timeout to the request", async () => {
    let timeoutMs: number | undefined;
    await verifyCodexMcpServersDisabled(
      async (_method, _params, options) => {
        timeoutMs = options.timeoutMs;
        return { data: [], nextCursor: null };
      },
      "t",
      { timeoutMs: 1234 },
    );
    expect(timeoutMs).toBe(1234);
  });
});

describe("isCodexMcpToolCallMessage", () => {
  it("matches every MCP tool call event and item", () => {
    expect(isCodexMcpToolCallMessage("item/mcpToolCall/progress", {})).toBe(true);
    expect(isCodexMcpToolCallMessage("item/mcpToolCall/anything", {})).toBe(true);
    expect(isCodexMcpToolCallMessage("item/started", { item: { type: "mcpToolCall" } })).toBe(true);
    expect(isCodexMcpToolCallMessage("item/completed", { item: { type: "mcp_tool_call" } })).toBe(true);
  });

  it("leaves other items alone", () => {
    expect(isCodexMcpToolCallMessage("item/started", { item: { type: "commandExecution" } })).toBe(false);
    expect(isCodexMcpToolCallMessage("item/completed", { item: { type: "dynamicToolCall" } })).toBe(false);
    expect(isCodexMcpToolCallMessage("item/commandExecution/outputDelta", {})).toBe(false);
    expect(isCodexMcpToolCallMessage("mcpServer/startupStatus/updated", {})).toBe(false);
  });

  it("names the server but never the arguments in the error", () => {
    const error = codexMcpToolCallError({
      item: { type: "mcpToolCall", server: "github", tool: "x", arguments: { token: "s3cret" } },
    });
    expect(error.code).toBe("mcp_tool_call");
    expect(error.servers).toEqual(["github"]);
    expect(error.message).toContain('"github"');
    expect(error.message).not.toContain("s3cret");
  });
});
