import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { fileWriteToolTargets, isProviderConfigPath } from "../permissions/provider-config-paths.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { createRuntimeHostServices } from "../runtime/host-services.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createToolPermissionHook, evaluateBashPermission } from "./hook.js";

const agentId = "writer";
let stateDir: string | null = null;
let workspace = "";

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-provider-config-writes-");
  workspace = mkdtempSync(join(tmpdir(), "ravi-provider-config-cwd-"));
  dbCreateAgent({ id: agentId, cwd: workspace });
});

afterEach(async () => {
  rmSync(workspace, { recursive: true, force: true });
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function caps(...values: string[]): ContextCapability[] {
  return values.map((value) => {
    const [permission, objectType, objectId] = value.split(":");
    return { permission: permission!, objectType: objectType!, objectId: objectId! };
  });
}

function toolContext(capabilities: ContextCapability[]): ToolContext {
  return {
    agentId,
    context: {
      contextId: "ctx_writer",
      contextKey: "rctx_writer",
      kind: "agent-runtime",
      agentId,
      capabilities,
      createdAt: 0,
    },
  };
}

async function writeDecision(capabilities: ContextCapability[], toolName: string, toolInput: Record<string, unknown>) {
  const hook = createToolPermissionHook({ getAgentId: () => agentId }).hooks[0]!;
  const result = (await runWithContext(toolContext(capabilities), () =>
    hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: workspace }, null, {
      signal: new AbortController().signal,
    }),
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return result.hookSpecificOutput?.permissionDecision ?? "allow";
}

describe("writes to runtime provider settings", () => {
  const WRITER = caps("use:tool:*");

  it("refuses Write/Edit of .claude settings and .mcp.json for a context without host execution", async () => {
    expect(await writeDecision(WRITER, "Write", { file_path: ".claude/settings.json", content: "{}" })).toBe("deny");
    expect(await writeDecision(WRITER, "Edit", { file_path: join(workspace, ".mcp.json") })).toBe("deny");
    expect(await writeDecision(WRITER, "Write", { file_path: "notes.md", content: "ok" })).toBe("allow");
    expect(await writeDecision(WRITER, "Write", { file_path: ".CoDeX/config.toml", content: "{}" })).toBe("deny");
    expect(await writeDecision(WRITER, "Write", { file_path: ".MCP.JSON", content: "{}" })).toBe("deny");
  });

  it("follows a symlink planted to reach the settings directory", async () => {
    mkdirSync(join(workspace, ".claude"));
    symlinkSync(join(workspace, ".claude"), join(workspace, "innocent"));
    expect(await writeDecision(WRITER, "Write", { file_path: "innocent/settings.json", content: "{}" })).toBe("deny");
    symlinkSync(".claude", join(workspace, " innocent "));
    expect(await writeDecision(WRITER, "Write", { file_path: " innocent /settings.json", content: "{}" })).toBe("deny");
  });

  it("allows them for a context that can already run any executable", async () => {
    const full = caps("use:tool:*", "execute:executable:*");
    expect(await writeDecision(full, "Write", { file_path: ".claude/settings.json", content: "{}" })).toBe("allow");
  });

  it("refuses a shell redirect into provider settings even with use:tool:Write", () => {
    const ctx = { agentId, capabilities: caps("use:tool:Write", "execute:executable:echo") };
    expect(evaluateBashPermission("echo '{}' > .claude/settings.json", ctx).allowed).toBe(false);
    expect(evaluateBashPermission("echo ok > notes.txt", ctx).allowed).toBe(true);
  });

  it("resolves a relative redirect against the shell's cwd, not the daemon's", () => {
    mkdirSync(join(workspace, ".claude"));
    symlinkSync(join(workspace, ".claude"), join(workspace, "innocent"));
    const ctx = { agentId, capabilities: caps("use:tool:Write", "execute:executable:echo"), cwd: workspace };
    expect(evaluateBashPermission("echo '{}' > innocent/settings.json", ctx).allowed).toBe(false);
  });

  it("follows static cd chains and their symlinks without assuming cd succeeds", () => {
    mkdirSync(join(workspace, "nested", ".codex"), { recursive: true });
    symlinkSync(".codex", join(workspace, "nested", "innocent"));
    // A failed `cd` followed by || or ; can still write in the original cwd.
    symlinkSync("nested/.codex", join(workspace, "innocent"));
    const ctx = {
      agentId,
      capabilities: caps("use:tool:Write", "execute:executable:echo", "execute:executable:cd"),
      cwd: workspace,
    };
    for (const command of [
      "cd nested && echo '{}' > innocent/config.toml",
      "cd nested; echo '{}' >> innocent/config.toml",
      "cd missing || echo '{}' > innocent/config.toml",
      "cd missing; echo '{}' > innocent/config.toml",
      "cd nested && echo '{}' &> innocent/config.toml",
      "cd nested && echo '{}' >| innocent/config.toml",
      "cd nested && echo '{}' >&innocent/config.toml",
      "2>/dev/null cd nested && echo '{}' > innocent/config.toml",
      "cd nested 2>/dev/null && echo '{}' > innocent/config.toml",
    ]) {
      expect(evaluateBashPermission(command, ctx).allowed, command).toBe(false);
    }
    expect(evaluateBashPermission("cd nested && echo ok > notes.txt", ctx).allowed).toBe(true);
    expect(evaluateBashPermission("cd nested && cd .. && echo ok > notes.txt", ctx).allowed).toBe(true);
    expect(evaluateBashPermission("cd -- 'nested' && echo ok > 'notes with spaces.txt'", ctx).allowed).toBe(true);
  });

  it("refuses unresolved shell state and dynamic redirect paths", () => {
    const ctx = {
      agentId,
      cwd: workspace,
      capabilities: caps(
        "use:tool:Write",
        "execute:executable:echo",
        "execute:executable:cd",
        "execute:executable:pushd",
        "execute:executable:popd",
        "execute:executable:export",
        "execute:executable:printf",
        "execute:executable:trap",
      ),
    };
    for (const command of [
      "(cd nested); echo ok > notes.txt",
      "cd nested | echo ok > notes.txt",
      "cd nested & echo ok > notes.txt",
      "pushd nested; echo ok > notes.txt",
      "popd; echo ok > notes.txt",
      "cd -; echo ok > notes.txt",
      "cd $TARGET; echo ok > notes.txt",
      "export CDPATH=/tmp; cd nested; echo ok > notes.txt",
      "printf -v CDPATH /tmp; cd nested; echo ok > notes.txt",
      "trap 'cd nested' DEBUG; echo ok > innocent/config.toml",
      "echo ok > $TARGET",
      "echo ok > */config.toml",
      "echo ok > innocent/[c]onfig.toml",
      "echo ok > innocent/{config,other}.toml",
      "cd nested # comment\necho ok > innocent/config.toml",
      "cd nested && \\\necho ok > innocent/config.toml",
      "echo ok <> innocent/config.toml",
    ]) {
      expect(evaluateBashPermission(command, ctx).allowed, command).toBe(false);
    }
  });

  it("follows a symlink before processing .. for file tools and shell redirects", async () => {
    mkdirSync(join(workspace, ".codex", "nested"), { recursive: true });
    symlinkSync(".codex/nested", join(workspace, "innocent"));
    const target = `${workspace}/innocent/../config.toml`;
    expect(isProviderConfigPath(target)).toBe(true);
    expect(await writeDecision(WRITER, "Write", { file_path: target, content: "{}" })).toBe("deny");
    const ctx = {
      agentId,
      capabilities: caps("use:tool:Write", "execute:executable:echo", "execute:executable:cd"),
      cwd: workspace,
    };
    expect(evaluateBashPermission("echo ok > innocent/../config.toml", ctx).allowed).toBe(false);
    expect(evaluateBashPermission("cd -P innocent/.. && echo ok > config.toml", ctx).allowed).toBe(false);
  });

  it("follows dangling file symlinks and refuses cyclic links", async () => {
    mkdirSync(join(workspace, ".codex"));
    symlinkSync(".codex/config.toml", join(workspace, "innocent"));
    expect(await writeDecision(WRITER, "Write", { file_path: "innocent", content: "{}" })).toBe("deny");
    symlinkSync(".codex/config.toml", join(workspace, "   "));
    expect(await writeDecision(WRITER, "Write", { file_path: "   ", content: "{}" })).toBe("deny");
    symlinkSync("loop", join(workspace, "loop"));
    expect(isProviderConfigPath("loop/file.txt", workspace)).toBe(true);
  });

  it("resolves relative host-service tool paths against the session cwd", async () => {
    mkdirSync(join(workspace, ".claude"));
    symlinkSync(join(workspace, ".claude"), join(workspace, "innocent"));
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      capabilities: WRITER,
      metadata: { authorityMode: "agent-identity", executorAgentId: agentId },
    });
    const services = createRuntimeHostServices({
      context,
      agentId,
      sessionName: `${agentId}-main`,
      toolContext: {},
      cwd: workspace,
    });
    const planted = await services.authorizeToolUse({
      toolName: "Write",
      input: { file_path: "innocent/settings.json", content: "{}" },
    });
    expect(planted.approved).toBe(false);
    const plain = await services.authorizeToolUse({
      toolName: "Write",
      input: { file_path: "notes.md", content: "ok" },
    });
    expect(plain.approved).toBe(true);
  });

  it("reads the paths out of patch-style tool inputs", () => {
    const patch = "*** Begin Patch\n*** Add File: .codex/config.toml\n+x\n*** Update File: src/a.ts\n*** End Patch";
    expect(fileWriteToolTargets("apply_patch", { input: patch })).toEqual([".codex/config.toml", "src/a.ts"]);
    expect(fileWriteToolTargets("Read", { file_path: ".claude/settings.json" })).toEqual([]);
    expect(isProviderConfigPath("~/.claude/settings.json")).toBe(true);
    expect(isProviderConfigPath("docs/claude.md")).toBe(false);
  });
});
