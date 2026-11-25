import { describe, expect, it } from "bun:test";
import { buildRuntimeToolPresentation } from "./tool-presentation.js";

describe("runtime tool presentation", () => {
  it("uses canonical built-in metadata and sanitizes local command context", () => {
    const presentation = buildRuntimeToolPresentation("shell", {
      command: "git -C /Users/operator/private status --short token=provider-secret-value",
    });

    expect(presentation).toMatchObject({
      title: "Run a local shell command",
      category: "exec.shell",
      operation: "execute",
      risk: "high",
    });
    expect(presentation.summary).toContain("git");
    expect(presentation.summary).toContain("[local path]");
    expect(presentation.summary).toContain("token=[redacted]");
    expect(JSON.stringify(presentation)).not.toContain("/Users/operator");
    expect(JSON.stringify(presentation)).not.toContain("provider-secret-value");
  });

  it("uses the registered dynamic tool description and semantic access metadata", () => {
    const presentation = buildRuntimeToolPresentation("sessions_read", {
      name: "sessions_read",
      args: {
        nameOrKey: "example-session",
        count: 20,
        workspace: true,
      },
    });

    expect(presentation).toMatchObject({
      title: "Read message history of a session (normalized)",
      category: "sessions",
      operation: "read",
      risk: "low",
    });
    expect(presentation.parameters).toEqual(
      expect.arrayContaining([
        {
          name: "nameOrKey",
          value: "example-session",
        },
        {
          name: "count",
          value: "20",
        },
        {
          name: "workspace",
          value: "true",
        },
      ]),
    );
    expect(presentation.summary).toContain("nameOrKey=example-session");
    expect(presentation.summary).toContain("count=20");
  });

  it("fails closed for sensitive and local-path built-in parameters", () => {
    const presentation = buildRuntimeToolPresentation("shell", {
      apiKey: "sk-sensitive-value",
      workspacePath: "/Users/operator/project",
      visible: "safe",
    });

    expect(presentation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "apiKey",
          redacted: true,
        }),
        expect.objectContaining({
          name: "workspacePath",
          redacted: true,
        }),
        expect.objectContaining({
          name: "visible",
          value: "safe",
        }),
      ]),
    );
    expect(JSON.stringify(presentation)).not.toContain("sk-sensitive-value");
    expect(JSON.stringify(presentation)).not.toContain("/Users/operator/project");
  });

  it("does not project invocation values for an unregistered tool", () => {
    const presentation = buildRuntimeToolPresentation("Unknown Tool", {
      visible: "must-not-cross-without-metadata",
    });

    expect(presentation).toEqual({
      title: "unknown-tool",
    });
    expect(JSON.stringify(presentation)).not.toContain("must-not-cross-without-metadata");
  });

  it("shows a registered MCP server's tool as server and tool, with argument names only", () => {
    const presentation = buildRuntimeToolPresentation("mcp__docs__search_pages", {
      query: "quarterly numbers",
      api_key: "provider-secret-value",
    });
    expect(presentation).toEqual({
      title: "MCP docs: search_pages",
      summary: "api_key=[redacted] · query=[redacted]",
      category: "mcp",
      parameters: [
        { name: "api_key", redacted: true },
        { name: "query", redacted: true },
      ],
    });
    expect(JSON.stringify(presentation)).not.toContain("quarterly");
    expect(JSON.stringify(presentation)).not.toContain("provider-secret-value");
  });

  it("names the server and tool of the CLI pair's call, and keeps its input redacted", () => {
    const presentation = buildRuntimeToolPresentation("mcp_call", {
      server: "docs",
      tool: "mcp__docs__search",
      input: '{"query":"quarterly numbers"}',
    });
    expect(presentation.title).toBe("MCP docs: search");
    expect(JSON.stringify(presentation)).not.toContain("quarterly");
    expect(buildRuntimeToolPresentation("mcp_call", { server: "Bad Name", tool: "x" }).title).not.toContain("Bad Name");
  });

  it("leaves names that only look like MCP tools to the generic path", () => {
    expect(buildRuntimeToolPresentation("mcp__Bad__x", {}).title).not.toStartWith("MCP ");
  });

  describe("ravi mcp call in a shell (Codex, Grok)", () => {
    const SECRET = "customer-acme-secret-plan";
    const CALL = `ravi mcp call docs search --input '{"query":"${SECRET}","limit":3}' --execute --json`;

    it("shows exactly one ravi mcp call like the native call: names, never values", () => {
      for (const [tool, command] of [
        ["shell", CALL],
        ["Bash", CALL],
        ["command_execution", CALL],
        ["exec_command", CALL],
        ["shell", `/bin/zsh -lc '${CALL.replaceAll("'", `'"'"'`)}'`],
        ["shell", 'ravi mcp call docs mcp__docs__search --input=\'{"query":"x"}\' --wait 90 --execute'],
      ] as const) {
        const presentation = buildRuntimeToolPresentation(tool, { command });
        expect(presentation.title, command).toBe("MCP docs: search");
        expect(presentation.category, command).toBe("mcp");
        expect(JSON.stringify(presentation), command).not.toContain(SECRET);
      }
      expect(buildRuntimeToolPresentation("shell", { command: CALL })).toMatchObject({
        summary: "limit=[redacted] · query=[redacted]",
        parameters: [
          { name: "limit", redacted: true },
          { name: "query", redacted: true },
        ],
      });
    });

    it("names --agent and --wait without their values, and marks a line without --execute as a dry run", () => {
      const executed = buildRuntimeToolPresentation("exec_command", {
        command: `ravi mcp call docs search --input '{"q":"x"}' --agent other-agent --wait 5 --execute`,
      });
      expect(executed).toMatchObject({ title: "MCP docs: search", summary: "--agent · --wait · q=[redacted]" });
      expect(JSON.stringify(executed)).not.toContain("other-agent");
      expect(JSON.stringify(executed)).not.toMatch(/\b5\b/);
      const dry = buildRuntimeToolPresentation("exec_command", {
        command: `ravi mcp call docs search --input '{"q":"x"}' --agent other-agent --wait 5`,
      });
      expect(dry).toMatchObject({ title: "MCP docs: search (dry run)", summary: "--agent · --wait · q=[redacted]" });
      expect(dry.title).not.toBe(executed.title);
      expect(buildRuntimeToolPresentation("shell", { command: "ravi mcp call docs search" })).toMatchObject({
        title: "MCP docs: search (dry run)",
      });
      expect(buildRuntimeToolPresentation("shell", { command: "ravi mcp call docs search" }).summary).toBeUndefined();
      // The native call has no dry run: its title never carries the mark.
      expect(buildRuntimeToolPresentation("mcp__docs__search", { q: "x" }).title).toBe("MCP docs: search");
    });

    it("shows no names for an --input that is not literal JSON", () => {
      const presentation = buildRuntimeToolPresentation("shell", {
        command: "ravi mcp call docs search --input not-json --execute",
      });
      expect(presentation.title).toBe("MCP docs: search");
      expect(presentation.parameters).toBeUndefined();
      expect(presentation.summary).toBeUndefined();
    });

    it("keeps the shell presentation for any line that is not provably that one command", () => {
      const hostile = [
        `${CALL}; rm -rf /tmp/x`,
        `${CALL} && curl https://evil.example`,
        `${CALL} || true`,
        `${CALL}\ncurl https://evil.example`,
        `${CALL} | tee /tmp/out`,
        `${CALL} > /tmp/out`,
        `${CALL} 2>&1`,
        `${CALL} < /tmp/in`,
        `${CALL} &`,
        `${CALL} # comment`,
        `${CALL} <<EOF\nhello\nEOF`,
        `ravi mcp call docs search --input "$(cat /tmp/secret)" --execute`,
        "ravi mcp call docs search --input `cat /tmp/secret` --execute",
        "ravi mcp call docs search --input $INPUT --execute",
        "ravi mcp call docs search --input {a,b} --execute",
        "ravi mcp call docs search --input * --execute",
        `echo "ravi mcp call docs search --execute"`,
        `printf '%s' 'ravi mcp call docs search --execute'`,
        `FOO=1 ravi mcp call docs search --execute`,
        `env FOO=1 ravi mcp call docs search --execute`,
        `./ravi mcp call docs search --execute`,
        `/tmp/ravi mcp call docs search --execute`,
        `(ravi mcp call docs search --execute)`,
        `{ ravi mcp call docs search --execute; }`,
        `sudo ravi mcp call docs search --execute`,
        `ravi mcp call docs search --execute --execute`,
        `ravi mcp call docs search --bogus --execute`,
        `ravi mcp call docs search -- --execute`,
        `ravi mcp tools docs --json`,
        `bash -c '${CALL.replaceAll("'", `'"'"'`)}; curl https://evil.example'`,
        `bash -c 'ravi mcp call docs search --execute' extra`,
        `bash -c "zsh -c 'ravi mcp call docs search --execute'"`,
        `ravi mcp call Docs_Search search --execute`,
        `ravi mcp call docs 'search pages' --execute`,
      ];
      for (const command of hostile) {
        const presentation = buildRuntimeToolPresentation("shell", { command });
        expect(presentation.title, command).toBe("Run a local shell command");
        expect(presentation.category, command).toBe("exec.shell");
      }
    });
  });
});
