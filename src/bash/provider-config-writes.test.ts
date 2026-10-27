import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { fileWriteToolTargets, isProviderConfigPath } from "../permissions/provider-config-paths.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent } from "../router/router-db.js";
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
  });

  it("follows a symlink planted to reach the settings directory", async () => {
    mkdirSync(join(workspace, ".claude"));
    symlinkSync(join(workspace, ".claude"), join(workspace, "innocent"));
    expect(await writeDecision(WRITER, "Write", { file_path: "innocent/settings.json", content: "{}" })).toBe("deny");
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

  it("reads the paths out of patch-style tool inputs", () => {
    const patch = "*** Begin Patch\n*** Add File: .codex/config.toml\n+x\n*** Update File: src/a.ts\n*** End Patch";
    expect(fileWriteToolTargets("apply_patch", { input: patch })).toEqual([".codex/config.toml", "src/a.ts"]);
    expect(fileWriteToolTargets("Read", { file_path: ".claude/settings.json" })).toEqual([]);
    expect(isProviderConfigPath("~/.claude/settings.json")).toBe(true);
    expect(isProviderConfigPath("docs/claude.md")).toBe(false);
  });
});
