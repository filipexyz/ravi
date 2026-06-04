import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RAVI_DIR = join(homedir(), ".ravi");
const TOML_PATH = join(RAVI_DIR, "rtk-rewrite.toml");

let savedToml: string | null = null;

function backupToml() {
  try {
    const { readFileSync } = require("node:fs");
    savedToml = readFileSync(TOML_PATH, "utf-8");
  } catch {
    savedToml = null;
  }
}

function restoreToml() {
  if (savedToml !== null) {
    writeFileSync(TOML_PATH, savedToml);
  } else {
    try {
      rmSync(TOML_PATH);
    } catch {
      // no-op
    }
  }
}

// Mock publish to capture NATS events
const publishedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];

mock.module("../nats.js", () => ({
  publish: async (topic: string, data: Record<string, unknown>) => {
    publishedEvents.push({ topic, data });
  },
}));

// Mock logger
mock.module("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

describe("createRtkRewriteHook", () => {
  beforeEach(() => {
    publishedEvents.length = 0;
    backupToml();
  });

  afterEach(() => {
    restoreToml();
  });

  // Helper: mock `which rtk` by controlling PATH
  function buildHookWithRtk(rtkAvailable: boolean, tomlContent?: string) {
    // Reset module cache so loadRtkRewriteConfig re-runs
    // We mock execSync to control rtk detection
    const { execSync: _orig } = require("node:child_process");

    if (tomlContent !== undefined) {
      mkdirSync(RAVI_DIR, { recursive: true });
      writeFileSync(TOML_PATH, tomlContent);
    } else {
      try {
        rmSync(TOML_PATH);
      } catch {
        // no-op
      }
    }

    // Use mock.module to mock child_process
    mock.module("node:child_process", () => ({
      execSync: (cmd: string, opts?: unknown) => {
        if (typeof cmd === "string" && (cmd.includes("which rtk") || cmd.includes("command -v rtk"))) {
          if (rtkAvailable) return "/usr/local/bin/rtk\n";
          throw new Error("not found");
        }
        return _orig(cmd, opts);
      },
    }));

    // Clear cached module to re-import with fresh mocks
    delete require.cache[require.resolve("./rtk-rewrite.js")];
    delete require.cache[require.resolve("./rtk-rewrite.defaults.js")];
    delete require.cache[require.resolve("./rtk-rewrite.types.js")];

    const { createRtkRewriteHook } = require("./rtk-rewrite.js");
    return createRtkRewriteHook();
  }

  function makeInput(command: string) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  const dummyContext = { signal: new AbortController().signal };

  test("rewrites `grep foo bar` to `rtk grep foo bar`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("grep foo bar.txt"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk grep foo bar.txt");
  });

  test("rewrites `grep -q close /tmp/...` preserving flags", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("grep -q close /tmp/claude-1001/file"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk grep -q close /tmp/claude-1001/file");
  });

  test("rewrites `grep -rn pattern src/` preserving flags", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("grep -rn pattern src/"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk grep -rn pattern src/");
  });

  test("rewrites `ps aux` to `rtk:toml ps aux`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("ps aux"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk:toml ps aux");
  });

  test("rewrites `eslint .` to `rtk lint eslint .`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("eslint ."), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk lint eslint .");
  });

  test("rewrites `eslint . --max-warnings 0`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("eslint . --max-warnings 0"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk lint eslint . --max-warnings 0");
  });

  test("rewrites `ls -la /home/ravi/main`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("ls -la /home/ravi/main"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk ls -la /home/ravi/main");
  });

  test("rewrites `du -sh /home/ravi/repo`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("du -sh /home/ravi/repo"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk:toml du -sh /home/ravi/repo");
  });

  test("rewrites `find /home/ravi/dir`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("find /home/ravi/dir -name '*.ts'"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk find /home/ravi/dir -name '*.ts'");
  });

  test("rewrites `diff -u a b`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("diff -u file1 file2"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk:toml diff -u file1 file2");
  });

  test("does NOT rewrite if command already starts with `rtk `", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("rtk grep foo"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("does NOT rewrite if command already starts with `rtk:`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("rtk:toml ps aux"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("does NOT rewrite if rtk binary is not in PATH", async () => {
    const hook = buildHookWithRtk(false);
    const result = await hook.hooks[0](makeInput("grep foo bar"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("does NOT rewrite compound commands (&&, ||, ;, |)", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("cd /tmp && grep foo bar"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("does NOT rewrite `echo grep`", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](makeInput("echo grep"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("supports user-overridden rules via ~/.ravi/rtk-rewrite.toml", async () => {
    const toml = `[[rule]]
id = "wc-l"
match = "^wc -l "
rewrite = "rtk wc -l "
`;
    const hook = buildHookWithRtk(true, toml);
    const result = await hook.hooks[0](makeInput("wc -l file.txt"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk wc -l file.txt");
  });

  test("disables default rules listed in `disabled` array", async () => {
    const toml = `disabled = ["du-sh"]`;
    const hook = buildHookWithRtk(true, toml);
    const result = await hook.hooks[0](makeInput("du -sh /home/ravi/repo"), null, dummyContext);
    expect(result).toEqual({});
  });

  test("emits ravi.rtk.rewrite NATS event on every rewrite", async () => {
    publishedEvents.length = 0;
    const hook = buildHookWithRtk(true);
    await hook.hooks[0](makeInput("grep foo bar"), null, dummyContext);
    expect(publishedEvents.length).toBe(1);
    expect(publishedEvents[0].topic).toBe("ravi.rtk.rewrite");
    expect(publishedEvents[0].data.original).toBe("grep foo bar");
    expect(publishedEvents[0].data.rewritten).toBe("rtk grep foo bar");
    expect(publishedEvents[0].data.ruleId).toBe("grep");
  });

  test("does NOT emit NATS event when no rewrite happens", async () => {
    publishedEvents.length = 0;
    const hook = buildHookWithRtk(true);
    await hook.hooks[0](makeInput("echo hello"), null, dummyContext);
    expect(publishedEvents.length).toBe(0);
  });

  test("does NOT throw on invalid regex in user config", async () => {
    const toml = `[[rule]]
id = "bad-regex"
match = "[invalid("
rewrite = "rtk bad"
`;
    const hook = buildHookWithRtk(true, toml);
    // Should still work for default rules
    const result = await hook.hooks[0](makeInput("grep foo bar"), null, dummyContext);
    expect(result.hookSpecificOutput?.updatedInput?.command).toBe("rtk grep foo bar");
  });

  test("returns empty object when command is missing", async () => {
    const hook = buildHookWithRtk(true);
    const result = await hook.hooks[0](
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
      null,
      dummyContext,
    );
    expect(result).toEqual({});
  });

  test("matcher is set to 'Bash'", () => {
    const hook = buildHookWithRtk(true);
    expect(hook.matcher).toBe("Bash");
  });
});
