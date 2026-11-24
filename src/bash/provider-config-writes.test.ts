import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runWithContext, type ToolContext } from "../cli/context.js";
import {
  fileWriteToolTargets,
  isProviderConfigPath,
  providerConfigWriteDenial,
} from "../permissions/provider-config-paths.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { createRuntimeHostServices } from "../runtime/host-services.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getRaviStateDir } from "../utils/paths.js";
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
    expect(evaluateBashPermission("echo x#y > .codex/config.toml", ctx).allowed).toBe(false);
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
      "cd .codex | echo ok > config.toml",
      "cd .codex & echo ok > config.toml",
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
      "cd .codex # comment\necho ok > config.toml",
      "cd .codex && \\\necho ok > config.toml",
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

  it("refuses a pathless file-change approval for a person held below break-glass", async () => {
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId,
      capabilities: [
        ...WRITER,
        { permission: "deny_execute", objectType: "executable", objectId: "*" },
        { permission: "deny_admin", objectType: "system", objectId: "*" },
      ],
      metadata: { authorityMode: "agent-identity", executorAgentId: agentId },
    });
    const services = createRuntimeHostServices({
      context,
      agentId,
      sessionName: `${agentId}-main`,
      toolContext: {},
      cwd: workspace,
    });
    const pathless = await services.authorizeToolUse({ toolName: "Edit", input: { itemId: "item_1" } });
    expect(pathless.approved).toBe(false);
    const inside = await services.authorizeToolUse({
      toolName: "Write",
      input: { file_path: "notes.md", content: "ok" },
    });
    expect(inside.approved).toBe(true);
  });

  it("reads the paths out of patch-style tool inputs", () => {
    const patch = "*** Begin Patch\n*** Add File: .codex/config.toml\n+x\n*** Update File: src/a.ts\n*** End Patch";
    expect(fileWriteToolTargets("apply_patch", { input: patch })).toEqual([".codex/config.toml", "src/a.ts"]);
    expect(fileWriteToolTargets("Read", { file_path: ".claude/settings.json" })).toEqual([]);
    expect(isProviderConfigPath("~/.claude/settings.json")).toBe(true);
    expect(isProviderConfigPath("docs/claude.md")).toBe(false);
  });
});

describe("file writes for a person held below the agent's break-glass", () => {
  const denyAll = () => false;
  const home = homedir();
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ravi-person-workspace-"));
    outside = mkdtempSync(join(home, ".ravi-person-outside-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const deniedFor = (target: string, cwd = workspace) =>
    providerConfigWriteDenial({
      can: denyAll,
      agentId: "full-agent",
      targets: [target],
      cwd,
      restrictToWorkspace: true,
    });

  it("refuses operator config and boot-time files: ~/.ravi/.env, installed bundle, shell rc, launch agents", () => {
    for (const target of [
      "~/.ravi/.env",
      join(home, ".bun/install/global/node_modules/ravi.bot/dist/bundle/index.js"),
      "~/.zshrc",
      join(home, "Library/LaunchAgents/ravi.plist"),
    ]) {
      expect(deniedFor(target)).toContain("outside the session workspace");
    }
  });

  it("keeps operator config denied even when the session workspace is the Ravi state dir or ~/.ravi", () => {
    expect(deniedFor(".env", getRaviStateDir())).toContain("outside the session workspace");
    expect(deniedFor(join(home, ".ravi", ".env"), join(home, ".ravi"))).toContain("outside the session workspace");
    expect(deniedFor(".zshrc", home)).toContain("outside the session workspace");
  });

  it("refuses a hardlink inside the workspace (a second name of another file)", () => {
    const outsideFile = join(outside, "secret.env");
    writeFileSync(outsideFile, "X=1\n");
    linkSync(outsideFile, join(workspace, "linked.env"));
    expect(deniedFor(join(workspace, "linked.env"))).toContain("outside the session workspace");
  });

  it("refuses another spelling of a protected directory on a case-insensitive volume", () => {
    const state = getRaviStateDir();
    mkdirSync(state, { recursive: true });
    const upper = join(dirname(state), basename(state).toUpperCase());
    // Only meaningful where the volume folds case (macOS default); elsewhere it is another directory.
    if (upper !== state && existsSync(upper)) {
      expect(deniedFor(".env", upper)).toContain("outside the session workspace");
    }
  });

  it("refuses a symlink inside the workspace that points outside", () => {
    symlinkSync(outside, join(workspace, "escape"));
    expect(deniedFor(join(workspace, "escape", "payload.sh"))).toContain("outside the session workspace");
  });

  it("allows the session workspace and the temp directory", () => {
    expect(deniedFor(join(workspace, "notes.md"))).toBeUndefined();
    expect(deniedFor("relative/file.txt")).toBeUndefined();
    expect(deniedFor(join(tmpdir(), "scratch.txt"))).toBeUndefined();
  });

  it("does not restrict turns without the limit or principals with break-glass", () => {
    expect(
      providerConfigWriteDenial({ can: denyAll, agentId: "a", targets: ["~/.zshrc"], cwd: workspace }),
    ).toBeUndefined();
    expect(
      providerConfigWriteDenial({
        can: (permission) => permission === "admin",
        agentId: "owner",
        targets: ["~/.zshrc"],
        cwd: workspace,
        restrictToWorkspace: true,
      }),
    ).toBeUndefined();
  });
});
