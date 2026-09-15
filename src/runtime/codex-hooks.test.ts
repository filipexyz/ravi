import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRaviCodexHookCommand,
  ensureCodexBashHookConfig,
  inspectCodexHookConfig,
  inspectParsedCodexHookConfig,
  isRaviCodexHookGroup,
  RAVI_CODEX_BASH_HOOK_COMMAND,
  RAVI_CODEX_BASH_HOOK_MATCHER,
  RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND,
  upsertRaviCodexBashHook,
} from "./codex-hooks.js";

function staleToolHookConfig() {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "^(Read|Bash|shell|exec_command|view_image)$",
          hooks: [
            {
              type: "command",
              command: "ravi context codex-tool-hook",
              statusMessage: "ravi codex native tool permission gate",
            },
          ],
        },
      ],
    },
  };
}

describe("codex hook materialization", () => {
  it("emits codex-bash-hook as the preferred command and never the legacy name", () => {
    const command = buildRaviCodexHookCommand();
    expect(command).toContain(RAVI_CODEX_BASH_HOOK_COMMAND);
    expect(command).not.toContain(RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND);
  });

  it("recognizes legacy tool-hook groups so rematerialize can replace them", () => {
    expect(isRaviCodexHookGroup(staleToolHookConfig().hooks.PreToolUse[0])).toBe(true);
  });

  it("replaces a stale wide-matcher tool-hook group with the bash-only preferred hook", () => {
    const next = upsertRaviCodexBashHook(staleToolHookConfig());
    const groups = (next.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(groups).toHaveLength(1);
    const group = groups[0] as {
      matcher: string;
      hooks: Array<{ type: string; command: string; statusMessage: string }>;
    };
    expect(group.matcher).toBe(RAVI_CODEX_BASH_HOOK_MATCHER);
    expect(group.hooks[0]?.type).toBe("command");
    expect(group.hooks[0]?.statusMessage).toBe("ravi codex bash permission gate");
    const command = group.hooks[0]?.command;
    expect(command).toContain(RAVI_CODEX_BASH_HOOK_COMMAND);
    expect(command).not.toContain(RAVI_CODEX_LEGACY_TOOL_HOOK_COMMAND);
  });

  it("inspects stale command and invalid matcher separately", () => {
    const stale = inspectParsedCodexHookConfig(staleToolHookConfig(), "/tmp/hooks.json");
    expect(stale.ok).toBe(false);
    expect(stale.staleCommand).toBe(true);
    expect(stale.matcherOk).toBe(false);
    expect(stale.reasons.join(" ")).toContain("codex-tool-hook");
    expect(stale.reasons.join(" ")).toContain(RAVI_CODEX_BASH_HOOK_MATCHER);

    const missing = inspectCodexHookConfig(null, "/tmp/hooks.json");
    expect(missing.exists).toBe(false);
    expect(missing.ok).toBe(false);
  });

  it("rewrites a stale hooks.json in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-hooks-"));
    const hooksPath = join(dir, "hooks.json");
    writeFileSync(hooksPath, `${JSON.stringify(staleToolHookConfig(), null, 2)}\n`);

    const result = ensureCodexBashHookConfig(dir);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(hooksPath);

    const rewritten = JSON.parse(readFileSync(hooksPath, "utf8"));
    const inspection = inspectParsedCodexHookConfig(rewritten, hooksPath);
    expect(inspection.ok).toBe(true);
    expect(inspection.staleCommand).toBe(false);
    expect(inspection.matcherOk).toBe(true);
    expect(inspection.preferredCommand).toBe(true);
  });
});
